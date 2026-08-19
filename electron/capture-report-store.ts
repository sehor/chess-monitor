import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  renderCaptureReport,
  type CaptureSampleRecord,
} from '../src/shared/capture-report'
import type { CaptureAnalysis, CaptureEventType } from '../src/shared/ipc'

const EVENT_TYPES = new Set<CaptureEventType>(['move', 'capture', 'highlight', 'animation', 'stationary'])

function isAnalysis(value: unknown): value is CaptureAnalysis {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.isStable === 'boolean' &&
    Number.isInteger(candidate.stableFrameCount) &&
    Number.isInteger(candidate.changedPointCount) &&
    typeof candidate.medianScore === 'number' && Number.isFinite(candidate.medianScore) &&
    Array.isArray(candidate.pointScores) && candidate.pointScores.length === 90 &&
    candidate.pointScores.every((score) => typeof score === 'number' && Number.isFinite(score))
  )
}

function isCaptureSampleRecord(value: unknown): value is CaptureSampleRecord {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.sampleId === 'string' && candidate.sampleId.length > 0 &&
    typeof candidate.fileName === 'string' && candidate.fileName.length > 0 &&
    typeof candidate.capturedAt === 'string' && Number.isFinite(Date.parse(candidate.capturedAt)) &&
    ['training', 'holdout'].includes(candidate.datasetSplit as string) &&
    typeof candidate.gameId === 'string' && candidate.gameId.length > 0 &&
    [100, 125, 150].includes(candidate.dpi as number) &&
    EVENT_TYPES.has(candidate.eventType as CaptureEventType) &&
    Array.isArray(candidate.expectedChangedPoints) &&
    candidate.expectedChangedPoints.every((point) => Number.isInteger(point) && point >= 0 && point < 90) &&
    (candidate.gridErrorRatio === null || (
      typeof candidate.gridErrorRatio === 'number' &&
      Number.isFinite(candidate.gridErrorRatio) &&
      candidate.gridErrorRatio >= 0
    )) &&
    typeof candidate.captureSucceeded === 'boolean' &&
    ['red-bottom', 'black-bottom'].includes(candidate.orientation as string) &&
    typeof candidate.roiScale === 'number' && Number.isFinite(candidate.roiScale) && candidate.roiScale > 0 &&
    typeof candidate.sourceName === 'string' &&
    (candidate.analysis === null || isAnalysis(candidate.analysis))
  )
}

export async function loadCaptureSampleRecords(directory: string): Promise<CaptureSampleRecord[]> {
  const names = await readdir(directory)
  const records = await Promise.all(names
    .filter((name) => name.endsWith('.json') && name !== 'metrics.json')
    .map(async (name) => {
      try {
        const value: unknown = JSON.parse(await readFile(join(directory, name), 'utf8'))
        return isCaptureSampleRecord(value) ? value : null
      } catch {
        return null
      }
    }))
  return records
    .filter((record): record is CaptureSampleRecord => record !== null)
    .sort((left, right) => left.capturedAt.localeCompare(right.capturedAt) || left.sampleId.localeCompare(right.sampleId))
}

export async function persistCaptureSampleRecord(
  directory: string,
  record: CaptureSampleRecord,
): Promise<{
  metadataFileName: string
  reportFileNames: { json: string; markdown: string }
  summary: ReturnType<typeof renderCaptureReport>['summary']
}> {
  const existing = await loadCaptureSampleRecords(directory)
  const records = [...existing.filter((candidate) => candidate.sampleId !== record.sampleId), record]
    .sort((left, right) => left.capturedAt.localeCompare(right.capturedAt) || left.sampleId.localeCompare(right.sampleId))
  const metadataFileName = `${record.sampleId}.json`
  const reportFileNames = { json: 'metrics.json', markdown: 'metrics.md' }
  const report = renderCaptureReport(records)
  await writeFile(join(directory, metadataFileName), `${JSON.stringify(record, null, 2)}\n`)
  await writeFile(join(directory, reportFileNames.json), report.json)
  await writeFile(join(directory, reportFileNames.markdown), report.markdown)
  return { metadataFileName, reportFileNames, summary: report.summary }
}
