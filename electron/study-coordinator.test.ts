import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_POSITION } from '@west-shell/xiangqi.js'
import { RulesAdapter } from '../src/domain/game'
import { parseStudyRecord, serializeStudyRecord, type StudyRecord } from '../src/domain/study'
import type { AnalysisEvent, AnalysisStartInput, EngineDescriptor } from '../src/shared/ipc'
import { GameStore } from './game-store'
import { StudyCoordinator, type StudyEngine } from './study-coordinator'

const directories: string[] = []

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'chess-monitor-study-'))
  directories.push(directory)
  return join(directory, 'games.sqlite3')
}

function recordWithPlies(plies: number): StudyRecord {
  const game = new RulesAdapter(DEFAULT_POSITION)
  const moves: string[] = []
  for (let index = 0; index < plies; index += 1) {
    const legal = game.legalMoves().sort()
    const move = legal[index % legal.length]
    moves.push(move)
    game.apply(move)
  }
  return { format: 'chess-monitor-iccs-v1', rootFen: DEFAULT_POSITION, moves }
}

class FakeStudyEngine implements StudyEngine {
  readonly descriptor: EngineDescriptor = { name: 'pikafish.exe', sha256: 'c'.repeat(64) }
  starts: AnalysisStartInput[] = []
  stopCount = 0
  private sequence = 0
  private activeId = 0
  private listeners = new Set<(event: AnalysisEvent) => void>()

  onEvent(listener: (event: AnalysisEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  start(request: AnalysisStartInput): number {
    this.starts.push(request)
    this.activeId = ++this.sequence
    this.emit({
      type: 'state',
      analysisId: this.activeId,
      positionVersion: request.positionVersion,
      state: 'STARTING',
    })
    this.emit({
      type: 'state',
      analysisId: this.activeId,
      positionVersion: request.positionVersion,
      state: 'ANALYZING',
    })
    return this.activeId
  }

  stop(): void {
    this.stopCount += 1
  }

  externalStop(): void {
    const request = this.starts.at(-1)!
    this.emit({
      type: 'state',
      analysisId: this.activeId,
      positionVersion: request.positionVersion,
      state: 'STOPPED',
    })
  }

  getEngine(): EngineDescriptor | null {
    return this.descriptor
  }

  complete(cp: number, bestMove: string, mateIn?: number): void {
    const request = this.starts.at(-1)!
    this.emit({
      type: 'info',
      value: {
        analysisId: this.activeId,
        positionVersion: request.positionVersion,
        multiPv: 1,
        depth: request.depth ?? 16,
        score: mateIn === undefined ? { cp } : { mateIn },
        nodes: '1000',
        pv: [bestMove],
      },
    })
    this.emit({
      type: 'bestmove',
      analysisId: this.activeId,
      positionVersion: request.positionVersion,
      move: bestMove,
    })
  }

  private emit(event: AnalysisEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('StudyCoordinator', () => {
  it('imports, saves and exports 50 legal games without changing the selected line', async () => {
    const store = new GameStore(await databasePath())
    const coordinator = new StudyCoordinator(store, new FakeStudyEngine())

    for (let index = 0; index < 50; index += 1) {
      const record = recordWithPlies(3 + (index % 8))
      const study = coordinator.importRecord(serializeStudyRecord(record))
      const selected = study.nodes.at(-1)!
      expect(parseStudyRecord(coordinator.exportBranch(selected.id))).toEqual(record)
    }

    coordinator.dispose()
    store.close()
  })

  it('uses the engine/FEN/settings cache for an equivalent node instead of re-running analysis', async () => {
    const store = new GameStore(await databasePath())
    const engine = new FakeStudyEngine()
    const coordinator = new StudyCoordinator(store, engine)
    const session = store.create(DEFAULT_POSITION, 'red-bottom', { multiPv: 1, depth: 16 })
    const root = store.getStudyNodes(session.id)[0]
    const duplicate = store.createFenNode(session.id, root.fen)

    expect(coordinator.analyzeNode(root.id, { multiPv: 1, depth: 16 }).cached).toBe(false)
    engine.complete(42, 'h2e2')
    expect(coordinator.analyzeNode(duplicate.id, { multiPv: 1, depth: 16 }).cached).toBe(true)
    expect(engine.starts).toHaveLength(1)
    expect(store.getStudyAnalyses(session.id)).toHaveLength(2)

    coordinator.dispose()
    store.close()
  })

  it('lets interactive historical analysis preempt review work without advancing the review cursor', async () => {
    const store = new GameStore(await databasePath())
    const engine = new FakeStudyEngine()
    const coordinator = new StudyCoordinator(store, engine)
    const session = store.create(DEFAULT_POSITION, 'red-bottom', { multiPv: 1, depth: 12 })
    const root = store.getStudyNodes(session.id)[0]
    const variation = store.createStudyChild(session.id, root.id, 'h2e2', 'variation')

    coordinator.startReview(session.id, { multiPv: 1, depth: 12 })
    expect(engine.starts).toHaveLength(1)
    coordinator.analyzeNode(variation.id, { multiPv: 1, depth: 12 })
    expect(engine.stopCount).toBe(1)
    expect(store.getReviewJob(session.id)).toMatchObject({ status: 'running', nextIndex: 0, completedNodes: 0 })

    engine.complete(10, 'h7e7')
    await Promise.resolve()
    expect(engine.starts).toHaveLength(3)
    expect(store.getReviewJob(session.id)).toMatchObject({ status: 'running', nextIndex: 0 })

    coordinator.dispose()
    store.close()
  })

  it('reviews a fixed node snapshot when the live game grows during analysis', async () => {
    const store = new GameStore(await databasePath())
    const engine = new FakeStudyEngine()
    const coordinator = new StudyCoordinator(store, engine)
    const session = store.create(DEFAULT_POSITION, 'red-bottom', { multiPv: 1, depth: 12 })

    coordinator.startReview(session.id, { multiPv: 1, depth: 12 })
    const game = new RulesAdapter(DEFAULT_POSITION)
    const previous = game.snapshot()
    const next = game.apply('h2e2')
    store.confirmMove(session.id, {
      type: 'move-confirmed', move: 'h2e2', confirmation: 'automatic',
      previousFen: previous.fen, fen: next.fen,
      previousPositionHash: 'before', positionHash: 'after',
      positionVersion: 1, capturedAt: 10, confirmedAt: 11,
    })

    engine.complete(10, 'h2e2')
    await Promise.resolve()
    expect(engine.starts).toHaveLength(1)
    expect(store.getReviewJob(session.id)).toMatchObject({ status: 'completed', totalNodes: 1, nextIndex: 1 })

    coordinator.dispose()
    store.close()
  })

  it('resumes the original review after interactive analysis of another game', async () => {
    const store = new GameStore(await databasePath())
    const engine = new FakeStudyEngine()
    const coordinator = new StudyCoordinator(store, engine)
    const first = store.createStudyGame(DEFAULT_POSITION)
    const alternative = new RulesAdapter(DEFAULT_POSITION).apply('h2e2').fen
    const second = store.createStudyGame(alternative)
    const firstRoot = store.getStudyNodes(first.id)[0]
    const secondRoot = store.getStudyNodes(second.id)[0]

    coordinator.startReview(first.id, { multiPv: 1, depth: 12 })
    coordinator.analyzeNode(secondRoot.id, { multiPv: 1, depth: 12 })
    engine.complete(12, 'h2e2')
    await Promise.resolve()

    expect(engine.starts).toHaveLength(3)
    expect(engine.starts.at(-1)?.fen).toBe(firstRoot.fen)
    expect(store.getReviewJob(first.id)).toMatchObject({ status: 'running', nextIndex: 0 })

    coordinator.dispose()
    store.close()
  })

  it('marks a running review failed when the study engine is stopped externally', async () => {
    const store = new GameStore(await databasePath())
    const engine = new FakeStudyEngine()
    const coordinator = new StudyCoordinator(store, engine)
    const session = store.createStudyGame(DEFAULT_POSITION)

    coordinator.startReview(session.id, { multiPv: 1, depth: 12 })
    engine.externalStop()
    expect(store.getReviewJob(session.id)).toMatchObject({ status: 'failed' })

    coordinator.dispose()
    store.close()
  })

  it('finishes a sequential review and creates an explainable blunder mark from before/after evaluations', async () => {
    const store = new GameStore(await databasePath())
    const engine = new FakeStudyEngine()
    const coordinator = new StudyCoordinator(store, engine)
    const session = store.create(DEFAULT_POSITION, 'red-bottom', { multiPv: 1, depth: 12 })
    const game = new RulesAdapter(DEFAULT_POSITION)
    const previous = game.snapshot()
    const next = game.apply('h2e2')
    store.confirmMove(session.id, {
      type: 'move-confirmed',
      move: 'h2e2',
      confirmation: 'automatic',
      previousFen: previous.fen,
      fen: next.fen,
      previousPositionHash: 'before',
      positionHash: 'after',
      positionVersion: 1,
      capturedAt: 10,
      confirmedAt: 11,
    })

    coordinator.startReview(session.id, { multiPv: 1, depth: 12 })
    engine.complete(220, 'b2e2')
    await Promise.resolve()
    engine.complete(10, 'h7e7')
    await Promise.resolve()

    expect(store.getReviewJob(session.id)).toMatchObject({ status: 'completed', nextIndex: 2, completedNodes: 2 })
    expect(store.getStudyMarks(session.id)).toEqual([
      expect.objectContaining({
        kind: 'blunder',
        actualMove: 'h2e2',
        bestMove: 'b2e2',
        lossCp: 210,
        mateSwing: false,
      }),
    ])

    coordinator.dispose()
    store.close()
  })
})
