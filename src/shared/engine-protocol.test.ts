import { describe, expect, it } from 'vitest'
import { parseBestMove, parseEngineInfo } from './engine-protocol'

describe('parseEngineInfo', () => {
  it('parses a bounded UCI information line', () => {
    expect(parseEngineInfo('info depth 18 multipv 2 score cp -43 nodes 123456 pv h2e2 h7e7')).toEqual({
      depth: 18,
      multiPv: 2,
      score: { cp: -43 },
      nodes: '123456',
      pv: ['h2e2', 'h7e7'],
    })
  })

  it('parses mate scores without coercing them into centipawns', () => {
    expect(parseEngineInfo('info depth 9 score mate 4 pv a0a1')).toMatchObject({
      score: { mateIn: 4 },
      pv: ['a0a1'],
    })
  })

  it('rejects malformed or incomplete lines', () => {
    expect(parseEngineInfo('info score cp 10')).toBeNull()
    expect(parseEngineInfo('bestmove a0a1')).toBeNull()
  })

  it('parses bestmove and the UCI no-move sentinel', () => {
    expect(parseBestMove('bestmove h2e2 ponder h7e7')).toEqual({ move: 'h2e2' })
    expect(parseBestMove('bestmove (none)')).toEqual({ move: null })
    expect(parseBestMove('bestmove h2z2')).toBeNull()
  })
})
