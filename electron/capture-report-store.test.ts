import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CaptureSampleRecord } from '../src/shared/capture-report'
import { persistCaptureSampleRecord } from './capture-report-store'

const directories: string[] = []

async function reportDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'chess-monitor-capture-report-'))
  directories.push(directory)
  return directory
}

function sample(sampleId: string): CaptureSampleRecord {
  return {
    sampleId,
    fileName: `${sampleId}.png`,
    capturedAt: '2026-08-19T00:00:00.000Z',
    datasetSplit: 'holdout',
    gameId: `game-${sampleId}`,
    dpi: 100,
    eventType: 'move',
    expectedChangedPoints: [0],
    gridErrorRatio: 0.01,
    captureSucceeded: true,
    orientation: 'red-bottom',
    roiScale: 0.6,
    sourceName: 'screen',
    analysis: {
      isStable: false,
      stableFrameCount: 0,
      changedPointCount: 1,
      medianScore: 0.01,
      pointScores: [0.1, ...Array(89).fill(0)],
    },
  }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('capture report persistence', () => {
  it('rebuilds the aggregate report from records saved by previous process sessions', async () => {
    const directory = await reportDirectory()
    await persistCaptureSampleRecord(directory, sample('sample-1'))
    await persistCaptureSampleRecord(directory, sample('sample-2'))

    const payload = JSON.parse(await readFile(join(directory, 'metrics.json'), 'utf8')) as {
      summary: { eventCount: number }
      samples: CaptureSampleRecord[]
    }
    expect(payload.summary.eventCount).toBe(2)
    expect(payload.samples.map((record) => record.sampleId)).toEqual(['sample-1', 'sample-2'])
  })
})
