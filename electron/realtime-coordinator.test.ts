import { mkdtemp, rm } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { expectedMovePoints } from '../src/domain/board-tracker'
import { RulesAdapter } from '../src/domain/game'
import type { AnalysisEvent, AnalysisStartInput, CaptureAnalysis } from '../src/shared/ipc'
import { GameStore } from './game-store'
import { EngineManager, type EngineManagerDependencies, type EngineProcess } from './engine-manager'
import { RealtimeCoordinator, type RealtimeEngine } from './realtime-coordinator'

const START_FEN = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1'
const RESYNC_FEN = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR b - - 0 1'
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

  retry(request: AnalysisStartInput): number {
    return this.start(request)
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

class CrashingEngineProcess extends EventEmitter implements EngineProcess {
  readonly writes: string[] = []
  readonly stdout = new EventEmitter() as EngineProcess['stdout']
  readonly stdin = { write: (data: string) => this.writes.push(data) }
  killed = false

  output(line: string): void {
    ;(this.stdout as EventEmitter).emit('data', Buffer.from(`${line}\n`))
  }

  kill(): void {
    this.killed = true
    this.emit('exit')
  }

  crash(): void {
    this.emit('exit')
  }
}

function finishEngineHandshake(process: CrashingEngineProcess): void {
  process.output('uciok')
  process.output('readyok')
}

function installPauseWriteFailure(path: string): DatabaseSync {
  const database = new DatabaseSync(path)
  database.exec(`
    CREATE TRIGGER fail_paused_status_update
    BEFORE UPDATE OF status ON games
    WHEN NEW.status = 'paused'
    BEGIN
      SELECT RAISE(ABORT, 'simulated paused status write failure');
    END;
  `)
  return database
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('RealtimeCoordinator', () => {
  it('explicitly retries the latest realtime position after the engine circuit opens', async () => {
    const store = new GameStore(await databasePath())
    vi.useFakeTimers()
    const processes: CrashingEngineProcess[] = []
    const dependencies: EngineManagerDependencies = {
      exists: () => true,
      readFile: () => Buffer.from('fixed-engine'),
      stat: () => ({ size: 12, mtimeMs: 1 }),
      spawn: () => {
        const process = new CrashingEngineProcess()
        processes.push(process)
        return process
      },
      setTimer: (callback, delay) => setTimeout(callback, delay),
      clearTimer: clearTimeout,
      now: Date.now,
    }
    const engine = new EngineManager(dependencies)
    engine.selectEngine('E:\\engines\\pikafish.exe')
    const coordinator = new RealtimeCoordinator(store, engine)

    try {
      coordinator.start({ fen: START_FEN, orientation: 'red-bottom' })
      finishEngineHandshake(processes[0])

      for (const [index, delay] of [250, 1_000, 2_000].entries()) {
        processes[index].crash()
        await vi.advanceTimersByTimeAsync(delay)
        finishEngineHandshake(processes[index + 1])
      }
      processes[3].crash()
      expect(coordinator.getSnapshot().analysis.state).toBe('FAILED')

      expect(coordinator.resync(RESYNC_FEN)).toMatchObject({
        position: { positionVersion: 1, fen: RESYNC_FEN },
        analysis: { state: 'FAILED' },
      })

      expect(coordinator.restartAnalysis()).toMatchObject({
        position: { positionVersion: 1, fen: RESYNC_FEN },
        analysis: { state: 'STARTING', positionVersion: 1 },
      })
      expect(processes).toHaveLength(5)
      finishEngineHandshake(processes[4])
      expect(coordinator.getSnapshot()).toMatchObject({
        position: { positionVersion: 1, fen: RESYNC_FEN },
        analysis: { state: 'ANALYZING', positionVersion: 1 },
      })
    } finally {
      coordinator.dispose()
      store.close()
      vi.useRealTimers()
    }
  })

  it('propagates an explicit retry failure for the IPC boundary', async () => {
    const store = new GameStore(await databasePath())
    const engine = new FakeEngine()
    const coordinator = new RealtimeCoordinator(store, engine)
    coordinator.start({ fen: START_FEN, orientation: 'red-bottom' })
    vi.spyOn(engine, 'retry').mockImplementationOnce(() => {
      throw new Error('simulated explicit retry failure')
    })

    expect(() => coordinator.restartAnalysis()).toThrow('simulated explicit retry failure')
    expect(coordinator.getSnapshot().analysis).toMatchObject({
      state: 'FAILED',
      message: 'simulated explicit retry failure',
      isTrusted: false,
    })

    coordinator.dispose()
    store.close()
  })

  it('keeps the previous in-memory state when creating a replacement session fails', async () => {
    const store = new GameStore(await databasePath())
    const engine = new FakeEngine()
    const coordinator = new RealtimeCoordinator(store, engine)
    const previous = coordinator.start({
      fen: START_FEN,
      orientation: 'red-bottom',
      settings: { multiPv: 3, depth: 12 },
    })
    const stopCount = engine.stopCount
    vi.spyOn(store, 'create').mockImplementationOnce(() => {
      throw new Error('simulated create failure')
    })

    expect(() => coordinator.start({
      fen: RESYNC_FEN,
      orientation: 'black-bottom',
      settings: { multiPv: 5, depth: 24 },
    })).toThrow('simulated create failure')
    expect(coordinator.getSnapshot()).toEqual(previous)
    expect(engine.stopCount).toBe(stopCount)

    coordinator.dispose()
    store.close()
  })

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

  it('keeps the old position when the final paused status write fails', async () => {
    const path = await databasePath()
    const store = new GameStore(path)
    const coordinator = new RealtimeCoordinator(store, new FakeEngine())
    coordinator.start({ fen: START_FEN, orientation: 'red-bottom' })
    coordinator.pause()
    const triggerDatabase = installPauseWriteFailure(path)

    try {
      const snapshot = coordinator.resync(RESYNC_FEN)
      expect(snapshot.position).toMatchObject({ fen: START_FEN, positionVersion: 0 })
      expect(store.getActive()).toMatchObject({
        currentFen: START_FEN,
        currentVersion: 0,
      })
    } finally {
      triggerDatabase.close()
      coordinator.dispose()
      store.close()
    }
  })

  it('restores the last in-memory persisted session when rollback cannot read storage', async () => {
    const path = await databasePath()
    const store = new GameStore(path)
    let now = 0
    const coordinator = new RealtimeCoordinator(store, new FakeEngine(), () => now)
    const mirror = new RulesAdapter(START_FEN, 'red-bottom')
    coordinator.start({ fen: START_FEN, orientation: 'red-bottom' })
    coordinator.observe({ capturedAt: now, sourceValid: true, profileValid: true, analysis: captureAnalysis() })
    const move = mirror.legalMoves()[0]
    now = 100
    coordinator.observe({
      capturedAt: now,
      sourceValid: true,
      profileValid: true,
      analysis: captureAnalysis(scoresForMove(move, 'red-bottom'), false),
    })
    now = 400
    coordinator.observe({ capturedAt: now, sourceValid: true, profileValid: true, analysis: captureAnalysis() })
    const trusted = coordinator.getSnapshot().position
    expect(trusted?.positionVersion).toBe(1)

    const undoLatestMove = vi.spyOn(store, 'undoLatestMove').mockImplementationOnce(() => {
      throw new Error('simulated undo write failure')
    })
    const getActive = vi.spyOn(store, 'getActive').mockImplementation(() => {
      throw new Error('simulated persisted state read failure')
    })

    try {
      expect(() => coordinator.undo()).not.toThrow()
      expect(coordinator.getSnapshot()).toMatchObject({
        monitoringState: 'ERROR',
        position: trusted,
      })
    } finally {
      undoLatestMove.mockRestore()
      getActive.mockRestore()
      coordinator.dispose()
      store.close()
    }
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

  it('restores an interrupted active game as paused until capture is resumed explicitly', async () => {
    const path = await databasePath()
    const firstStore = new GameStore(path)
    const first = new RealtimeCoordinator(firstStore, new FakeEngine())
    const started = first.start({ fen: START_FEN, orientation: 'red-bottom' })
    first.dispose()
    firstStore.close()

    const reopenedStore = new GameStore(path)
    const engine = new FakeEngine()
    const reopened = new RealtimeCoordinator(reopenedStore, engine)
    try {
      expect(reopened.getSnapshot()).toMatchObject({
        gameId: started.gameId,
        monitoringState: 'PAUSED',
        position: { positionVersion: 0, fen: START_FEN },
        analysis: { state: 'STOPPED', isTrusted: false },
      })
      expect(reopenedStore.getActive()?.status).toBe('paused')
      expect(engine.requests).toHaveLength(0)
    } finally {
      reopened.dispose()
      reopenedStore.close()
    }
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
