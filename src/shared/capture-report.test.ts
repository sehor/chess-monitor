import { describe, expect, it } from 'vitest'
import { assignDatasetSplit, buildCaptureQualitySummary, calibrateCaptureThresholds, renderCaptureReport, type CaptureSampleRecord } from './capture-report'

function sample(overrides: Partial<CaptureSampleRecord> = {}): CaptureSampleRecord {
  return {
    sampleId: 'sample-1',
    fileName: 'sample-1.png',
    capturedAt: '2026-08-18T00:00:00.000Z',
    datasetSplit: 'holdout',
    gameId: 'game-1',
    dpi: 100,
    eventType: 'move',
    expectedChangedPoints: [0],
    gridErrorRatio: 0.05,
    captureSucceeded: true,
    orientation: 'red-bottom',
    roiScale: 0.6,
    sourceName: '天天象棋',
    analysis: { isStable: false, stableFrameCount: 0, changedPointCount: 1, medianScore: 0.01, pointScores: [0.1, ...Array(89).fill(0)] },
    ...overrides,
  }
}

describe('capture quality reporting', () => {
  it('keeps every game and DPI group in one deterministic 70/30 split', () => {
    expect(assignDatasetSplit('game-1', 125)).toBe(assignDatasetSplit('game-1', 125))
    expect(['training', 'holdout']).toContain(assignDatasetSplit('game-2', 150))
  })

  it('calculates recall, false positives and failed sample indexes', () => {
    const summary = buildCaptureQualitySummary([
      sample(),
      sample({ sampleId: 'stationary-failure', eventType: 'stationary', expectedChangedPoints: [], analysis: { isStable: false, stableFrameCount: 0, changedPointCount: 1, medianScore: 0.1, pointScores: Array(90).fill(0.1) } }),
    ])
    expect(summary.captureSuccessRate).toBe(1)
    expect(summary.changedPointRecall).toBe(1)
    expect(summary.stationaryFalsePositiveRate).toBe(1)
    expect(summary.failedSampleIds).toContain('stationary-failure')
    expect(summary.meetsQualityGate).toBe(false)
  })

  it('derives P99.5 stationary and 99%-recall change thresholds from training data', () => {
    const training = [
      sample({ sampleId: 'still', datasetSplit: 'training', eventType: 'stationary', expectedChangedPoints: [], analysis: { isStable: true, stableFrameCount: 3, changedPointCount: 0, medianScore: 0.01, pointScores: Array(90).fill(0.01) } }),
      sample({ sampleId: 'move', datasetSplit: 'training' }),
    ]
    const calibration = calibrateCaptureThresholds(training)
    expect(calibration.lowThreshold).toBe(0.01)
    expect(calibration.highThreshold).toBeCloseTo(0.055)
    expect(calibration.isValid).toBe(true)
  })

  it('renders machine-readable JSON and a Markdown gate report', () => {
    const report = renderCaptureReport([sample()])
    expect(JSON.parse(report.json).summary.eventCount).toBe(1)
    expect(report.markdown).toContain('质量门：未通过')
  })

  it('uses the approved 100% and 125% two-DPI acceptance scope', () => {
    const samples = [
      ...Array.from({ length: 100 }, (_, index) => sample({
        sampleId: `dpi-100-${index}`,
        dpi: 100,
        datasetSplit: index < 70 ? 'training' : 'holdout',
        eventType: index % 2 === 0 ? 'stationary' : 'move',
        expectedChangedPoints: index % 2 === 0 ? [] : [0],
        analysis: index % 2 === 0
          ? { isStable: true, stableFrameCount: 3, changedPointCount: 0, medianScore: 0, pointScores: Array(90).fill(0) }
          : { isStable: false, stableFrameCount: 0, changedPointCount: 1, medianScore: 0, pointScores: [0.1, ...Array(89).fill(0)] },
      })),
      ...Array.from({ length: 100 }, (_, index) => sample({
        sampleId: `dpi-125-${index}`,
        dpi: 125,
        datasetSplit: index < 70 ? 'training' : 'holdout',
        eventType: index % 2 === 0 ? 'stationary' : 'move',
        expectedChangedPoints: index % 2 === 0 ? [] : [0],
        analysis: index % 2 === 0
          ? { isStable: true, stableFrameCount: 3, changedPointCount: 0, medianScore: 0, pointScores: Array(90).fill(0) }
          : { isStable: false, stableFrameCount: 0, changedPointCount: 1, medianScore: 0, pointScores: [0.1, ...Array(89).fill(0)] },
      })),
    ]

    const report = renderCaptureReport(samples)
    expect(report.summary.countsByDpi).toEqual({ '100': 100, '125': 100, '150': 0 })
    expect(report.summary.meetsQualityGate).toBe(true)
    expect(report.markdown).toContain('DPI 100/125：100 / 100')
  })
})
