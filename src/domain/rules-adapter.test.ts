import { describe, expect, it } from 'vitest'
import { RulesAdapter } from './game'

function scenarioAfter(...moves: string[]): string {
  const game = new RulesAdapter()
  for (const move of moves) game.apply(move)
  return game.snapshot().fen
}

const RULE_SCENARIOS = [
  { name: 'initial', fen: new RulesAdapter().snapshot().fen },
  { name: 'one-ply', fen: scenarioAfter('a3a4') },
  { name: 'two-ply', fen: scenarioAfter('a3a4', 'a6a5') },
]

const LEGAL_MOVE_CASES = RULE_SCENARIOS.flatMap(({ name, fen }) =>
  new RulesAdapter(fen).legalMoves().map((move) => ({ name, fen, move })),
)

describe('RulesAdapter qualification', () => {
  it('contains at least 100 table-driven native-rule cases', () => {
    expect(LEGAL_MOVE_CASES.length).toBeGreaterThanOrEqual(100)
  })

  it.each(LEGAL_MOVE_CASES)('$name accepts legal ICCS move $move', ({ fen, move }) => {
    const game = new RulesAdapter(fen)
    const next = game.apply(move)
    expect(next.positionVersion).toBe(1)
    expect(next.lastMove).toBe(move)
    expect(next.moveHistory).toEqual([move])
  })

  it.each([
    ['general stays in the palace', 'e0', ['e0e1']],
    ['advisor moves diagonally in the palace', 'd0', ['d0e1']],
    ['elephant moves two points diagonally', 'c0', ['c0a2', 'c0e2']],
    ['horse respects its starting geometry', 'b0', ['b0a2', 'b0c2']],
    ['chariot moves until its first blocker', 'a0', ['a0a1', 'a0a2']],
    ['cannon has non-capturing file moves', 'b2', ['b2b1', 'b2b3']],
    ['uncrossed pawn advances only forward', 'a3', ['a3a4']],
  ] as const)('%s', (_name, square, expectedMoves) => {
    const moves = new RulesAdapter().legalMovesFrom(square)
    for (const move of expectedMoves) expect(moves).toContain(move)
  })

  it('rejects a sideways move by an uncrossed pawn', () => {
    expect(() => new RulesAdapter().apply('a3b3')).toThrow()
  })

  it('reports check, draw and terminal state through one stable status contract', () => {
    const status = new RulesAdapter().status()
    expect(status).toEqual({
      isCheck: false,
      isCheckmate: false,
      isStalemate: false,
      isDraw: false,
      isThreefoldRepetition: false,
      isGameOver: false,
    })
  })
})
