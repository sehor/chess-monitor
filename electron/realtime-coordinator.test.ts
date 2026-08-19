import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { expectedMovePoints } from '../src/domain/board-tracker'
import { RulesAdapter } from '../src/domain/game'
import type { AnalysisEvent, AnalysisStartInput, CaptureAnalysis } from '../src/shared/ipc'
import { GameStore } from './game-store'
import { RealtimeCoordinator, type RealtimeEngine } from './realtime-coordinator'

const START_FEN = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1'
const directories: string[] = []

function captureAnalysis(pointScores: number[] = Array(90).fill(0), isStable = true): CaptureAnalysis {
  return {
    isStable,
    stableFrameCount: isStable ? 3 : 0,
    changedPointCount: pointScores.filter((score) => score > 0).length,
    medianScore: 0,
    pointScores,
  }
}

function scoresForMove(move: string, orientation: 'red-bottom' | 'black-bottom'): number[] {
  const scores = Array(90).fill(0)
  const [origin, destination] = expectedMovePoints(move as `${string}${string}${string}${string}`, orientation)
  scores[origin] = 0.2
  scores[destination] = 0.22
  return scores
}

class FakeEngine implements RealtimeEngine {
  private sequence = 0
  private readonly listeners = new Set<(event: AnalysisEvent) => void>()
  readonly requests: Array<AnalysisStartInput & { analysisId: number }> = []
  stopCount = 0

  onEvent(listener: (event: AnalysisEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  start(request: AnalysisStartInput): number {
    const analysisId = ++this.sequence
    this.requests.push({ ...request, analysisId })
    this.emit({ type: 'state', analysisId, positionVersion: request.positionVersion, state: 'STARTING' })
    return analysisId
  }

  stop(): void {
    this.stopCount += 1
  }

  emit(event: AnalysisEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'chess-monitor-realtime-'))
  directories.push(directory)
  return join(directory, 'games.sqlite3')
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('RealtimeCoordinator', () => {
  it('rejects stale analysis across 100 rapid adjacent position versions', async () => {
    const store = new GameStore(await databasePath())
    const engine = new FakeEngine()
    const coordinator = new RealtimeCoordinator(store, engine)
    coordinator.start({ fen: START_FEN, orientation: 'red-bottom', settings: { multiPv: 3, depth: 12 } })

    const latencies: number[] = []
    for (let version = 1; version <= 100; version += 1) {
      const previous = engine.requests.at(-1)!
      const startedAt = performance.now()
      coordinator.resync(START_FEN)
      latencies.push(performance.now() - startedAt)
      const current = engine.requests.at(-1)!
      engine.emit({
        type: 'info',
        value: {
          analysisId: previous.analysisId,
          positionVersion: previous.positionVersion,
          multiPv: 1,
          depth: 99,
          score: { cp: 999 },
          nodes: '1',
          pv: ['h2e2'],
        },
      })
      engine.emit({
        type: 'info',
        value: {
          analysisId: current.analysisId,
          positionVersion: current.positionVersion,
          multiPv: 1,
          depth: 12,
          score: { cp: version },
          nodes: String(version),
          pv: ['h2e2'],
        },
      })
      expect(coordinator.getSnapshot().analysis.lines).toEqual([
        expect.objectContaining({ positionVersion: version, score: { cp: version } }),
      ])
    }
    expect(coordinator.getSnapshot().position?.positionVersion).toBe(100)
    latencies.sort((left, right) => left - right)
    expect(latencies[Math.ceil(latencies.length * 0.95) - 1]).toBeLessThan(100)
    coordinator.dispose()
    store.close()
  })

  it('keeps tracker, persistence, engine and UI snapshot aligned for 10 games and 500 moves', async () => {
    const store = new GameStore(await databasePath())
    const engine = new FakeEngine()
    let now = 0
    const coordinator = new RealtimeCoordinator(store, engine, () => now)
    let confirmedMoves = 0

    for (let gameIndex = 0; gameIndex < 10; gameIndex += 1) {
      const orientation = gameIndex % 2 === 0 ? 'red-bottom' : 'black-bottom'
      const mirror = new RulesAdapter(START_FEN, orientation)
      coordinator.start({ fen: START_FEN, orientation })
      coordinator.observe({ capturedAt: now, sourceValid: true, profileValid: true, analysis: captureAnalysis() })

      for (let ply = 0; ply < 50; ply += 1) {
        const legalMoves = mirror.legalMoves()
        expect(legalMoves.length).toBeGreaterThan(0)
        const move = legalMoves[(gameIndex * 7 + ply * 11) % legalMoves.length]
        now += 100
        coordinator.observe({
          capturedAt: now,
          sourceValid: true,
          profileValid: true,
          analysis: captureAnalysis(scoresForMove(move, orientation), false),
        })
        now += 300
        coordinator.observe({ capturedAt: now, sourceValid: true, profileValid: true, analysis: captureAnalysis() })
        const expected = mirror.apply(move)
        const snapshot = coordinator.getSnapshot()
        confirmedMoves += 1

        expect(snapshot.position).toMatchObject({ fen: expected.fen, positionVersion: ply + 1 })
        expect(snapshot.confirmedMoves.at(-1)).toMatchObject({ move, fen: expected.fen, positionVersion: ply + 1 })
        expect(engine.requests.at(-1)).toMatchObject({ fen: expected.fen, positionVersion: ply + 1 })
      }
      coordinator.stop()
      now += 1_000
    }

    expect(confirmedMoves).toBe(500)
    coordinator.dispose()
    store.close()
  }, 20_000)

  it('pauses without losing the current position and resumes only the latest analysis', async () => {
    const store = new GameStore(await databasePath())
    const engine = new FakeEngine()
    const coordinator = new RealtimeCoordinator(store, engine)
    coordinator.start({ fen: START_FEN, orientation: 'red-bottom' })
    coordinator.resync(START_FEN)
    const requestCount = engine.requests.length

    expect(coordinator.pause()).toMatchObject({ monitoringState: 'PAUSED', position: { positionVersion: 1 } })
    expect(engine.requests).toHaveLength(requestCount)
    expect(coordinator.resume()).toMatchObject({ monitoringState: 'RUNNING', position: { positionVersion: 1 } })
    expect(engine.requests.at(-1)).toMatchObject({ positionVersion: 1 })
    coordinator.dispose()
    store.close()
  })

  it('stops analysis and marks results untrusted when tracking enters DESYNC', async () => {
    const store = new GameStore(await databasePath())
    const engine = new FakeEngine()
    const coordinator = new RealtimeCoordinator(store, engine)
    coordinator.start(
      { fen: START_FEN, orientation: 'red-bottom' },
      { candidateTimeoutMs: 500 },
    )
    coordinator.observe({ capturedAt: 0, sourceValid: true, profileValid: true, analysis: captureAnalysis() })
    const ambiguous = Array(90).fill(0)
    for (const move of ['a3a4', 'c3c4']) {
      for (const point of expectedMovePoints(move as `${string}${string}${string}${string}`, 'red-bottom')) ambiguous[point] = 0.2
    }
    coordinator.observe({ capturedAt: 100, sourceValid: true, profileValid: true, analysis: captureAnalysis(ambiguous, false) })
    coordinator.observe({ capturedAt: 400, sourceValid: true, profileValid: true, analysis: captureAnalysis() })
    const snapshot = coordinator.observe({ capturedAt: 901, sourceValid: true, profileValid: true, analysis: captureAnalysis() })

    expect(snapshot).toMatchObject({
      monitoringState: 'DESYNC',
      trackerState: { status: 'DESYNC' },
      analysis: { isTrusted: false },
    })
    expect(engine.stopCount).toBeGreaterThan(0)
    coordinator.dispose()
    store.close()
  })

  it('rolls back to the persisted position and enters ERROR when a position transaction fails', async () => {
    const store = new GameStore(await databasePath())
    const engine = new FakeEngine()
    const coordinator = new RealtimeCoordinator(store, engine)
    coordinator.start({ fen: START_FEN, orientation: 'red-bottom' })
    vi.spyOn(store, 'replaceBaseline').mockImplementationOnce(() => {
      throw new Error('disk full')
    })

    expect(coordinator.resync(START_FEN)).toMatchObject({
      monitoringState: 'ERROR',
      position: { positionVersion: 0, fen: START_FEN },
      analysis: { isTrusted: false },
    })
    expect(store.getActive()).toMatchObject({ currentVersion: 0, status: 'error' })
    coordinator.dispose()
    store.close()
  })

  it('restores an unfinished paused game after close and reopen', async () => {
    const path = await databasePath()
    const firstStore = new GameStore(path)
    const first = new RealtimeCoordinator(firstStore, new FakeEngine())
    first.start({ fen: START_FEN, orientation: 'black-bottom', settings: { multiPv: 4, depth: 20 } })
    first.resync(START_FEN)
    first.pause()
    first.dispose()
    firstStore.close()

    const reopenedStore = new GameStore(path)
    const reopened = new RealtimeCoordinator(reopenedStore, new FakeEngine())
    expect(reopened.getSnapshot()).toMatchObject({
      monitoringState: 'PAUSED',
      position: { positionVersion: 1, orientation: 'black-bottom' },
      settings: { multiPv: 4, depth: 20 },
    })
    reopened.dispose()
    reopenedStore.close()
  })

  it('stores one final analysis summary instead of persisting intermediate info events', async () => {
    const path = await databasePath()
    const store = new GameStore(path)
    const engine = new FakeEngine()
    const coordinator = new RealtimeCoordinator(store, engine)
    coordinator.start({ fen: START_FEN, orientation: 'red-bottom', settings: { multiPv: 3, depth: 16 } })
    const request = engine.requests.at(-1)!
    for (const depth of [8, 12, 16]) {
      engine.emit({
        type: 'info',
        value: {
          analysisId: request.analysisId,
          positionVersion: 0,
          multiPv: 1,
          depth,
          score: { cp: depth },
          nodes: String(depth * 100),
          pv: ['h2e2'],
        },
      })
    }
    engine.emit({ type: 'bestmove', analysisId: request.analysisId, positionVersion: 0, move: 'h2e2' })
    coordinator.dispose()
    store.close()

    const database = new DatabaseSync(path)
    const rows = database.prepare('SELECT depth, best_move, lines_json FROM analysis_summaries').all() as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ depth: 16, best_move: 'h2e2' })
    expect(JSON.parse(rows[0].lines_json as string)).toEqual([
      expect.objectContaining({ depth: 16, score: { cp: 16 } }),
    ])
    database.close()
  })
})
