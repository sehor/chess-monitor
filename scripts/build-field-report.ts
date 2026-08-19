import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import {
  assignDatasetSplit,
  renderCaptureReport,
  type CaptureSampleRecord,
} from '../src/shared/capture-report.ts'

interface MoveManifestState {
  index: number
  fileName: string
  capturedAt: string
  pointScores: number[]
}

interface MoveManifest {
  states: MoveManifestState[]
}

interface ReviewedMove {
  stateIndex: number
  eventType: 'move' | 'capture' | 'highlight' | 'animation'
  expectedChangedPoints: number[]
}

interface MoveReview {
  accepted: ReviewedMove[]
}

const workspace = resolve(import.meta.dirname, '..')
const validationRoot = join(workspace, 'artifacts', 'field-validation')

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle]
}

async function stationarySamples(
  directory: string,
  dpi: 100 | 125,
  gameId: string,
): Promise<CaptureSampleRecord[]> {
  const names = (await readdir(directory)).filter((name) => name.endsWith('.png')).sort()
  return Promise.all(names.map(async (name, index) => {
    const filePath = join(directory, name)
    const fileStat = await stat(filePath)
    return {
      sampleId: `${gameId}-${String(index + 1).padStart(3, '0')}`,
      fileName: relative(validationRoot, filePath).replaceAll('\\', '/'),
      capturedAt: fileStat.mtime.toISOString(),
      datasetSplit: assignDatasetSplit(gameId, dpi),
      gameId,
      dpi,
      eventType: 'stationary',
      expectedChangedPoints: [],
      gridErrorRatio: null,
      captureSucceeded: fileStat.size > 0,
      orientation: 'red-bottom',
      roiScale: 0.6,
      sourceName: '整个屏幕（天天象棋棋盘裁剪）',
      analysis: null,
    }
  }))
}

async function moveSamples(
  directory: string,
  dpi: 100 | 125,
  gameId: string,
): Promise<CaptureSampleRecord[]> {
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as MoveManifest
  const review = JSON.parse(await readFile(join(directory, 'review.json'), 'utf8')) as MoveReview
  return Promise.all(review.accepted.map(async (accepted) => {
    const state = manifest.states.find((candidate) => candidate.index === accepted.stateIndex)
    if (!state) throw new Error(`Missing state ${accepted.stateIndex} in ${directory}`)
    const expectedChangedPoints = accepted.expectedChangedPoints.map((point) => point - 1)
    const imageStat = await stat(join(directory, state.fileName))
    return {
      sampleId: `${gameId}-state-${String(state.index).padStart(3, '0')}`,
      fileName: relative(validationRoot, join(directory, state.fileName)).replaceAll('\\', '/'),
      capturedAt: state.capturedAt,
      datasetSplit: assignDatasetSplit(gameId, dpi),
      gameId,
      dpi,
      eventType: accepted.eventType,
      expectedChangedPoints,
      gridErrorRatio: null,
      captureSucceeded: imageStat.size > 0,
      orientation: 'red-bottom',
      roiScale: 0.6,
      sourceName: '整个屏幕（天天象棋棋盘裁剪）',
      analysis: {
        isStable: false,
        stableFrameCount: 0,
        changedPointCount: state.pointScores.filter((score) => score >= 0.05).length,
        medianScore: median(state.pointScores),
        pointScores: state.pointScores,
      },
    }
  }))
}

const samples = [
  ...await stationarySamples(join(validationRoot, 'dpi-100', 'stationary'), 100, 'field-a'),
  ...await moveSamples(join(validationRoot, 'dpi-100', 'moves'), 100, 'field-f'),
  ...await stationarySamples(join(validationRoot, 'dpi-125', 'stationary'), 125, 'field-d'),
  ...await stationarySamples(join(validationRoot, 'dpi-125', 'stationary-supplement-recalibrated'), 125, 'field-d'),
  ...await moveSamples(join(validationRoot, 'dpi-125', 'moves'), 125, 'field-b'),
]

const report = renderCaptureReport(samples)
await writeFile(join(validationRoot, 'capture-quality.json'), report.json)
await writeFile(join(validationRoot, 'capture-quality.md'), report.markdown)
process.stdout.write(`${JSON.stringify(report.summary, null, 2)}\n`)
