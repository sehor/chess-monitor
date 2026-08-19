import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RulesAdapter } from '../src/domain/game'
import type { MoveConfirmedEvent } from '../src/domain/board-tracker'
import { GameStore } from './game-store'

const START_FEN = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1'
const directories: string[] = []

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'chess-monitor-game-'))
  directories.push(directory)
  return join(directory, 'games.sqlite3')
}

function confirmedEvent(game: RulesAdapter, move: string, capturedAt = 10): MoveConfirmedEvent {
  const previous = game.snapshot()
  const next = game.apply(move)
  return {
    type: 'move-confirmed',
    move: move as MoveConfirmedEvent['move'],
    confirmation: 'automatic',
    previousFen: previous.fen,
    fen: next.fen,
    previousPositionHash: `hash-${previous.positionVersion}`,
    positionHash: `hash-${next.positionVersion}`,
    positionVersion: next.positionVersion,
    capturedAt,
    confirmedAt: capturedAt + 1,
  }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('GameStore', () => {
  it('configures WAL, foreign keys and a bounded busy timeout for recovery diagnostics', async () => {
    const store = new GameStore(await databasePath(), { busyTimeoutMs: 2_500 })
    expect(store.databaseHealth()).toEqual({
      schemaVersion: 3,
      journalMode: 'wal',
      foreignKeys: true,
      busyTimeoutMs: 2_500,
    })
    store.close()
  })

  it('persists the Profile and model versions used when a game starts', async () => {
    const store = new GameStore(await databasePath())
    const session = store.create(START_FEN, 'red-bottom', { multiPv: 3, depth: 16 }, {
      profileId: 'profile-a',
      profileVersion: 7,
      modelVersion: 'pieces-v3',
    })
    expect(session.provenance).toEqual({ profileId: 'profile-a', profileVersion: 7, modelVersion: 'pieces-v3' })
    store.close()
  })

  it('persists a confirmed move and restores an unfinished game after reopening', async () => {
    const path = await databasePath()
    const first = new GameStore(path)
    const session = first.create(START_FEN, 'red-bottom', { multiPv: 3, depth: 16 })
    const game = new RulesAdapter(START_FEN)
    const event = confirmedEvent(game, 'h2e2')
    first.confirmMove(session.id, event)
    first.setStatus(session.id, 'paused')
    first.close()

    const reopened = new GameStore(path)
    expect(reopened.schemaVersion).toBe(3)
    expect(reopened.getActive()).toMatchObject({
      id: session.id,
      currentFen: event.fen,
      currentVersion: 1,
      status: 'paused',
      moves: [expect.objectContaining({ move: 'h2e2', positionVersion: 1 })],
    })
    reopened.close()
  })

  it('rolls back an out-of-order move without changing the persisted position', async () => {
    const store = new GameStore(await databasePath())
    const session = store.create(START_FEN, 'red-bottom', { multiPv: 3, depth: 16 })
    const event = confirmedEvent(new RulesAdapter(START_FEN), 'h2e2')
    expect(() => store.confirmMove(session.id, { ...event, positionVersion: 2 })).toThrow('does not extend')
    expect(store.get(session.id)).toMatchObject({ currentVersion: 0, currentFen: START_FEN, moves: [] })
    store.close()
  })

  it('uses a new monotonic baseline for resync and undo recovery', async () => {
    const store = new GameStore(await databasePath())
    const session = store.create(START_FEN, 'red-bottom', { multiPv: 2, depth: 12 })
    const game = new RulesAdapter(START_FEN)
    const event = confirmedEvent(game, 'h2e2')
    store.confirmMove(session.id, event)
    const undone = game.undo()
    const restored = store.undoLatestMove(session.id, undone.fen, undone.positionVersion)
    expect(restored).toMatchObject({
      baselineFen: undone.fen,
      baselineVersion: 2,
      currentVersion: 2,
      moves: [],
    })
    store.close()
  })

  it('persists an immutable 100-node study tree with stable parent-child relationships', async () => {
    const path = await databasePath()
    const first = new GameStore(path)
    const session = first.create(START_FEN, 'red-bottom', { multiPv: 3, depth: 16 })
    const root = first.getStudyNodes(session.id)[0]
    const created = [root]

    for (let index = 0; index < 100; index += 1) {
      const parent = created[index]
      const rules = new RulesAdapter(parent.fen)
      const move = rules.legalMoves().sort()[index % rules.legalMoves().length]
      created.push(first.createStudyChild(session.id, parent.id, move, 'variation'))
    }
    const before = first.getStudyNodes(session.id)
    expect(before).toHaveLength(101)
    first.close()

    const reopened = new GameStore(path)
    const after = reopened.getStudyNodes(session.id)
    expect(after).toEqual(before)
    for (const node of after.slice(1)) {
      expect(after.some((candidate) => candidate.id === node.parentId)).toBe(true)
    }
    reopened.close()
  })

  it('repairs a schema-v3 database whose legacy study-node backfill did not complete', async () => {
    const path = await databasePath()
    const first = new GameStore(path)
    const session = first.create(START_FEN, 'red-bottom', { multiPv: 1, depth: 12 })
    first.close()

    const damaged = new DatabaseSync(path)
    damaged.prepare('DELETE FROM position_nodes WHERE game_id = ?').run(session.id)
    damaged.close()

    const repaired = new GameStore(path)
    expect(repaired.getStudyNodes(session.id)).toEqual([
      expect.objectContaining({ gameId: session.id, parentId: null, fen: START_FEN, livePositionVersion: 0 }),
    ])
    repaired.close()
  })

  it('records resync and undo as new immutable live nodes instead of mutating history', async () => {
    const store = new GameStore(await databasePath())
    const session = store.create(START_FEN, 'red-bottom', { multiPv: 2, depth: 12 })
    const game = new RulesAdapter(START_FEN)
    const event = confirmedEvent(game, 'h2e2')
    store.confirmMove(session.id, event)
    const resynced = new RulesAdapter(event.fen, 'red-bottom', 1).reset(START_FEN)
    store.replaceBaseline(session.id, resynced.fen, resynced.positionVersion)
    const undone = new RulesAdapter(resynced.fen, 'red-bottom', resynced.positionVersion).reset(resynced.fen)
    expect(() => store.undoLatestMove(session.id, undone.fen, undone.positionVersion)).not.toThrow()

    const liveNodes = store.getStudyNodes(session.id).filter((node) => node.livePositionVersion !== null)
    expect(liveNodes.map((node) => node.livePositionVersion)).toEqual([0, 1, 2, 3])
    expect(liveNodes.map((node) => node.source)).toEqual(['live', 'live', 'resync', 'undo'])
    store.close()
  })

  it('reuses FEN/engine/settings analysis cache across different nodes', async () => {
    const store = new GameStore(await databasePath())
    const session = store.create(START_FEN, 'red-bottom', { multiPv: 3, depth: 16 })
    const root = store.getStudyNodes(session.id)[0]
    const detached = store.createFenNode(session.id, root.fen)
    const analysis = {
      cacheKey: 'cache-a',
      fen: root.fen,
      engine: { name: 'pikafish.exe', sha256: 'a'.repeat(64) },
      settings: { multiPv: 2, depth: 18 },
      bestMove: 'h2e2',
      lines: [{
        analysisId: 1,
        positionVersion: 0,
        multiPv: 1,
        depth: 18,
        score: { cp: 42 },
        nodes: '1000',
        pv: ['h2e2'],
      }],
      createdAt: new Date(0).toISOString(),
    }
    store.saveStudyAnalysis(root.id, analysis)
    expect(store.getCachedStudyAnalysis('cache-a')).toMatchObject({ cacheKey: 'cache-a', fen: root.fen })
    store.attachStudyAnalysis(detached.id, 'cache-a')
    expect(store.getStudyAnalyses(session.id).filter((item) => item.cacheKey === 'cache-a')).toHaveLength(2)
    store.close()
  })

  it('persists review cursor updates so repeated pause/resume does not lose completed work', async () => {
    const path = await databasePath()
    const first = new GameStore(path)
    const session = first.create(START_FEN, 'red-bottom', { multiPv: 1, depth: 12 })
    first.saveReviewJob({
      gameId: session.id,
      status: 'running',
      depth: 12,
      multiPv: 1,
      nextIndex: 3,
      totalNodes: 9,
      completedNodes: 3,
      nodeIds: Array.from({ length: 9 }, (_value, index) => `node-${index}`),
      engineSha256: 'b'.repeat(64),
      message: '复盘中',
    })
    for (let index = 0; index < 20; index += 1) {
      first.updateReviewJob(session.id, { status: 'paused', message: '已暂停' })
      first.updateReviewJob(session.id, { status: 'running', message: '继续复盘' })
    }
    first.close()

    const reopened = new GameStore(path)
    expect(reopened.getReviewJob(session.id)).toMatchObject({
      status: 'running',
      nextIndex: 3,
      completedNodes: 3,
      totalNodes: 9,
    })
    reopened.close()
  })
})
