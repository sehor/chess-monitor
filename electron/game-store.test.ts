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
    expect(reopened.schemaVersion).toBe(1)
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
})
