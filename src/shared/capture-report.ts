import type { CaptureQualitySummary, CaptureSampleMetadataInput } from './ipc'

export interface CaptureSampleRecord extends CaptureSampleMetadataInput {
  sampleId: string
  fileName: string
  capturedAt: string
  datasetSplit: 'training' | 'holdout'
}

export interface CaptureThresholdCalibration {
  lowThreshold: number | null
  highThreshold: number | null
  isValid: boolean
}

export const CAPTURE_QUALITY_EVENT_MINIMUM = 200
export const CAPTURE_QUALITY_DPI_MINIMUM = 80
export const REQUIRED_CAPTURE_DPIS = [100, 125] as const

function stableHash(value: string): number {
  let hash = 2166136261
  for (const character of value) {
    hash ^= character.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

export function assignDatasetSplit(gameId: string, dpi: number): 'training' | 'holdout' {
  return stableHash(`${gameId}:${dpi}`) % 10 < 7 ? 'training' : 'holdout'
}

function quantile(values: number[], percentile: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(percentile * sorted.length) - 1))
  return sorted[index]
}

export function calibrateCaptureThresholds(samples: CaptureSampleRecord[]): CaptureThresholdCalibration {
  const stationaryScores = samples
    .filter((sample) => sample.eventType === 'stationary')
    .flatMap((sample) => sample.analysis?.pointScores ?? [])
  const changedScores = samples.flatMap((sample) =>
    sample.expectedChangedPoints.map((point) => sample.analysis?.pointScores[point]).filter((score): score is number => score !== undefined),
  )
  const lowThreshold = quantile(stationaryScores, 0.995)
  const firstChangedPercentile = quantile(changedScores, 0.01)
  if (lowThreshold === null || firstChangedPercentile === null) {
    return { lowThreshold, highThreshold: null, isValid: false }
  }
  const highThreshold = firstChangedPercentile > lowThreshold
    ? lowThreshold + (firstChangedPercentile - lowThreshold) / 2
    : lowThreshold + Number.EPSILON
  const recall = changedScores.filter((score) => score >= highThreshold).length / changedScores.length
  return { lowThreshold, highThreshold, isValid: recall >= 0.99 }
}

export function buildCaptureQualitySummary(samples: CaptureSampleRecord[], highThreshold = 0.05): CaptureQualitySummary {
  const successful = samples.filter((sample) => sample.captureSucceeded).length
  const gridErrors = samples.flatMap((sample) => sample.gridErrorRatio === null ? [] : [sample.gridErrorRatio])
  let expectedChanges = 0
  let recalledChanges = 0
  let stationaryFrames = 0
  let falsePositiveFrames = 0
  const failedSampleIds = new Set<string>()

  for (const sample of samples) {
    if (!sample.captureSucceeded || (sample.gridErrorRatio !== null && sample.gridErrorRatio > 0.1)) {
      failedSampleIds.add(sample.sampleId)
    }
    if (sample.eventType === 'stationary' && sample.analysis) {
      stationaryFrames += 1
      if (sample.analysis.changedPointCount > 0) {
        falsePositiveFrames += 1
        failedSampleIds.add(sample.sampleId)
      }
    }
    for (const point of sample.expectedChangedPoints) {
      expectedChanges += 1
      if ((sample.analysis?.pointScores[point] ?? 0) >= highThreshold) recalledChanges += 1
      else failedSampleIds.add(sample.sampleId)
    }
  }

  const countsByDpi = {
    '100': samples.filter((sample) => sample.dpi === 100).length,
    '125': samples.filter((sample) => sample.dpi === 125).length,
    '150': samples.filter((sample) => sample.dpi === 150).length,
  }
  const captureSuccessRate = samples.length === 0 ? 0 : successful / samples.length
  const maximumGridErrorRatio = gridErrors.length === 0 ? null : Math.max(...gridErrors)
  const changedPointRecall = expectedChanges === 0 ? null : recalledChanges / expectedChanges
  const stationaryFalsePositiveRate = stationaryFrames === 0 ? null : falsePositiveFrames / stationaryFrames
  const meetsQualityGate =
    samples.length >= CAPTURE_QUALITY_EVENT_MINIMUM &&
    REQUIRED_CAPTURE_DPIS.every((dpi) => countsByDpi[String(dpi) as '100' | '125'] >= CAPTURE_QUALITY_DPI_MINIMUM) &&
    captureSuccessRate >= 0.99 &&
    maximumGridErrorRatio !== null && maximumGridErrorRatio <= 0.1 &&
    changedPointRecall !== null && changedPointRecall >= 0.99 &&
    stationaryFalsePositiveRate !== null && stationaryFalsePositiveRate <= 0.005

  return {
    eventCount: samples.length,
    captureSuccessRate,
    maximumGridErrorRatio,
    changedPointRecall,
    stationaryFalsePositiveRate,
    countsByDpi,
    trainingEventCount: samples.filter((sample) => sample.datasetSplit === 'training').length,
    holdoutEventCount: samples.filter((sample) => sample.datasetSplit === 'holdout').length,
    lowThreshold: null,
    highThreshold,
    failedSampleIds: [...failedSampleIds],
    meetsQualityGate,
  }
}

export function renderCaptureReport(samples: CaptureSampleRecord[]): { json: string; markdown: string; summary: CaptureQualitySummary } {
  const training = samples.filter((sample) => sample.datasetSplit === 'training')
  const holdout = samples.filter((sample) => sample.datasetSplit === 'holdout')
  const calibration = calibrateCaptureThresholds(training)
  const overall = buildCaptureQualitySummary(samples, calibration.highThreshold ?? 0.05)
  const holdoutMetrics = buildCaptureQualitySummary(holdout, calibration.highThreshold ?? 0.05)
  const meetsQualityGate =
    samples.length >= CAPTURE_QUALITY_EVENT_MINIMUM &&
    REQUIRED_CAPTURE_DPIS.every((dpi) => samples.filter((sample) => sample.dpi === dpi).length >= CAPTURE_QUALITY_DPI_MINIMUM) &&
    holdout.length > 0 &&
    calibration.isValid &&
    holdoutMetrics.captureSuccessRate >= 0.99 &&
    holdoutMetrics.maximumGridErrorRatio !== null && holdoutMetrics.maximumGridErrorRatio <= 0.1 &&
    holdoutMetrics.changedPointRecall !== null && holdoutMetrics.changedPointRecall >= 0.99 &&
    holdoutMetrics.stationaryFalsePositiveRate !== null && holdoutMetrics.stationaryFalsePositiveRate <= 0.005
  const summary: CaptureQualitySummary = {
    ...overall,
    captureSuccessRate: holdoutMetrics.captureSuccessRate,
    maximumGridErrorRatio: holdoutMetrics.maximumGridErrorRatio,
    changedPointRecall: holdoutMetrics.changedPointRecall,
    stationaryFalsePositiveRate: holdoutMetrics.stationaryFalsePositiveRate,
    failedSampleIds: holdoutMetrics.failedSampleIds,
    trainingEventCount: training.length,
    holdoutEventCount: holdout.length,
    lowThreshold: calibration.lowThreshold,
    highThreshold: calibration.highThreshold,
    meetsQualityGate,
  }
  const payload = { generatedAt: new Date().toISOString(), calibration, summary, samples }
  const percentage = (value: number | null) => value === null ? 'N/A' : `${(value * 100).toFixed(2)}%`
  const markdown = [
    '# 阶段 0 捕获质量报告',
    '',
    `- 事件数：${summary.eventCount} / ${CAPTURE_QUALITY_EVENT_MINIMUM}`,
    `- DPI 100/125：${summary.countsByDpi['100']} / ${summary.countsByDpi['125']}（各至少 ${CAPTURE_QUALITY_DPI_MINIMUM}）`,
    `- 训练/留出事件：${summary.trainingEventCount} / ${summary.holdoutEventCount}`,
    `- 低/高阈值：${summary.lowThreshold?.toFixed(4) ?? 'N/A'} / ${summary.highThreshold?.toFixed(4) ?? 'N/A'}`,
    `- 抓帧成功率：${percentage(summary.captureSuccessRate)}（要求 ≥99%）`,
    `- 最大网格误差：${percentage(summary.maximumGridErrorRatio)}（要求 ≤10%）`,
    `- 变化点召回率：${percentage(summary.changedPointRecall)}（要求 ≥99%）`,
    `- 静止误报帧比例：${percentage(summary.stationaryFalsePositiveRate)}（要求 ≤0.5%）`,
    `- 质量门：${summary.meetsQualityGate ? '通过' : '未通过'}`,
    '',
    `失败样本索引：${summary.failedSampleIds.length ? summary.failedSampleIds.join(', ') : '无'}`,
    '',
  ].join('\n')
  return { json: `${JSON.stringify(payload, null, 2)}\n`, markdown, summary }
}
