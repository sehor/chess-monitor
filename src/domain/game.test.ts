import { describe, expect, it } from 'vitest'
import { XiangqiGame } from './game'

describe('XiangqiGame', () => {
  it('lists legal ICCS moves and advances a versioned snapshot', () => {
    const game = new XiangqiGame()

    expect(game.legalMovesFrom('a3')).toContain('a3a4')

    const snapshot = game.apply('a3a4')
    expect(snapshot).toMatchObject({
      positionVersion: 1,
      sideToMove: 'black',
      lastMove: 'a3a4',
      moveHistory: ['a3a4'],
    })
    expect(snapshot.fen).toContain(' b ')
  })

  it('rejects non-ICCS coordinates before calling the rule engine', () => {
    expect(() => new XiangqiGame().apply('a3-a4')).toThrow('four-character ICCS')
  })

  it('undoes a move while retaining a monotonically increasing position version', () => {
    const game = new XiangqiGame()
    game.apply('a3a4')

    expect(game.undo()).toMatchObject({
      positionVersion: 2,
      sideToMove: 'red',
      lastMove: null,
      moveHistory: [],
    })
  })
})
