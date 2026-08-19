import { describe, expect, it } from 'vitest'
import { DEFAULT_POSITION } from '@west-shell/xiangqi.js'
import { RulesAdapter } from './game'
import {
  classifyMoveQuality,
  parseStudyRecord,
  serializeStudyRecord,
  studyBranchToNode,
  type StudyRecord,
} from './study'

function deterministicRecord(plies: number): StudyRecord {
  const game = new RulesAdapter(DEFAULT_POSITION)
  const moves: string[] = []
  for (let index = 0; index < plies; index += 1) {
    const move = game.legalMoves().sort()[index % game.legalMoves().length]
    moves.push(move)
    game.apply(move)
  }
  return { format: 'chess-monitor-iccs-v1', rootFen: DEFAULT_POSITION, moves }
}

describe('study record import/export', () => {
  it('round-trips 50 legal ICCS records without changing move semantics', () => {
    for (let index = 0; index < 50; index += 1) {
      const record = deterministicRecord(4 + (index % 12))
      const parsed = parseStudyRecord(serializeStudyRecord(record))
      expect(parsed).toEqual(record)
    }
  })

  it('accepts a standalone FEN as an importable study record', () => {
    expect(parseStudyRecord(DEFAULT_POSITION)).toEqual({
      format: 'fen',
      rootFen: DEFAULT_POSITION,
      moves: [],
    })
  })

  it('rejects illegal moves and unsupported record formats explicitly', () => {
    expect(() => parseStudyRecord(`CHESS-MONITOR-ICCS 1\nFEN ${DEFAULT_POSITION}\nMOVES a0a9`))
      .toThrow(/illegal move/i)
    expect(() => parseStudyRecord('[Event "example"]\n1. 炮二平五'))
      .toThrow(/unsupported record format/i)
  })
})

describe('move quality classification', () => {
  it('marks a materially worse non-best move as a question move', () => {
    expect(classifyMoveQuality({
      mover: 'red',
      actualMove: 'h2e2',
      bestMove: 'b2e2',
      before: { cp: 120 },
      after: { cp: 20 },
    })).toMatchObject({ kind: 'question', lossCp: 100 })
  })

  it('marks a large evaluation loss as a blunder', () => {
    expect(classifyMoveQuality({
      mover: 'black',
      actualMove: 'h7e7',
      bestMove: 'b7e7',
      before: { cp: -80 },
      after: { cp: 160 },
    })).toMatchObject({ kind: 'blunder', lossCp: 240 })
  })

  it('does not flag the engine best move even when numeric samples differ', () => {
    expect(classifyMoveQuality({
      mover: 'red',
      actualMove: 'h2e2',
      bestMove: 'h2e2',
      before: { cp: 200 },
      after: { cp: -200 },
    })).toBeNull()
  })

  it('treats a newly forced mate against the mover as a blunder without plotting it as cp', () => {
    expect(classifyMoveQuality({
      mover: 'red',
      actualMove: 'h2e2',
      bestMove: 'b2e2',
      before: { cp: 20 },
      after: { mateIn: -4 },
    })).toMatchObject({ kind: 'blunder', lossCp: null, mateSwing: true })
  })

  it('marks losing an existing forced mate for the mover as a blunder', () => {
    expect(classifyMoveQuality({
      mover: 'red',
      actualMove: 'h2e2',
      bestMove: 'b2e2',
      before: { mateIn: 3 },
      after: { cp: 120 },
    })).toMatchObject({ kind: 'blunder', lossCp: null, mateSwing: true })
  })
})

describe('study branch selection', () => {
  it('returns only the selected root-to-node path and excludes sibling variations', () => {
    const base = { gameId: 'game', source: 'variation' as const, fen: DEFAULT_POSITION, livePositionVersion: null, createdAt: new Date(0).toISOString() }
    const nodes = [
      { ...base, id: 'root', parentId: null, move: null, ply: 0 },
      { ...base, id: 'left', parentId: 'root', move: 'h2e2', ply: 1 },
      { ...base, id: 'right', parentId: 'root', move: 'b2e2', ply: 1 },
      { ...base, id: 'leaf', parentId: 'left', move: 'h7e7', ply: 2 },
    ]
    expect(studyBranchToNode(nodes, 'leaf').map((node) => node.id)).toEqual(['root', 'left', 'leaf'])
  })
})
