import { describe, expect, it } from 'vitest'
import { createPositionSnapshot, parseFen } from './position'

const initialFen = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w'

describe('parseFen', () => {
  it('validates the 9 by 10 xiangqi board and side to move', () => {
    expect(parseFen(initialFen)).toEqual({
      board: initialFen.split(' ')[0],
      sideToMove: 'red',
    })
  })

  it('rejects malformed rank widths', () => {
    expect(() => parseFen('rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNRR')).toThrow(
      'exactly 9 files',
    )
  })

  it('rejects unsupported side-to-move values', () => {
    expect(() => parseFen(`${initialFen.split(' ')[0]} red`)).toThrow('"w" or "b"')
  })
})

describe('createPositionSnapshot', () => {
  it('creates an immutable starting state shape for the analysis pipeline', () => {
    expect(createPositionSnapshot(initialFen, 4, 'black-bottom')).toMatchObject({
      positionVersion: 4,
      sideToMove: 'red',
      orientation: 'black-bottom',
      lastMove: null,
      moveHistory: [],
    })
  })
})
