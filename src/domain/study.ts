import { DEFAULT_POSITION } from '@west-shell/xiangqi.js'
import { RulesAdapter, type IccsMove } from './game'
import { parseFen, type Side } from './position'
import type { NormalizedScore } from '../shared/ipc'
import type { StudyNode } from '../shared/study'

export type StudyRecordFormat = 'chess-monitor-iccs-v1' | 'fen'

export interface StudyRecord {
  format: StudyRecordFormat
  rootFen: string
  moves: string[]
}

export interface MoveQualityInput {
  mover: Side
  actualMove: string
  bestMove: string | null
  before: NormalizedScore
  after: NormalizedScore
  questionThresholdCp?: number
  blunderThresholdCp?: number
}

export interface MoveQualityMark {
  kind: 'question' | 'blunder'
  lossCp: number | null
  mateSwing: boolean
  explanation: string
}

const RECORD_HEADER = 'CHESS-MONITOR-ICCS 1'
const MOVE_PATTERN = /^[a-i][0-9][a-i][0-9]$/

export function studyBranchToNode(nodes: StudyNode[], nodeId: string | null): StudyNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  let cursor = (nodeId ? byId.get(nodeId) : undefined) ?? nodes.at(-1)
  const branch: StudyNode[] = []
  const seen = new Set<string>()
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id)
    branch.unshift(cursor)
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined
  }
  return branch
}

function normalizedFen(fen: string): string {
  return parseFen(fen).fen
}

function parseMoves(rootFen: string, tokens: string[]): IccsMove[] {
  const game = new RulesAdapter(rootFen)
  const moves: IccsMove[] = []
  for (const [index, token] of tokens.entries()) {
    const move = token.toLowerCase()
    if (!MOVE_PATTERN.test(move)) {
      throw new Error(`Invalid ICCS move at ply ${index + 1}: ${token}`)
    }
    try {
      game.apply(move)
    } catch {
      throw new Error(`Illegal move at ply ${index + 1}: ${move}`)
    }
    moves.push(move as IccsMove)
  }
  return moves
}

export function serializeStudyRecord(record: StudyRecord): string {
  const rootFen = normalizedFen(record.rootFen)
  const moves = parseMoves(rootFen, record.moves)
  if (record.format === 'fen' && moves.length === 0) return rootFen
  return `${RECORD_HEADER}\nFEN ${rootFen}\nMOVES${moves.length > 0 ? ` ${moves.join(' ')}` : ''}\n`
}

export function parseStudyRecord(text: string): StudyRecord {
  const trimmed = text.trim()
  if (!trimmed) throw new Error('Study record is empty')

  try {
    const fen = normalizedFen(trimmed)
    return { format: 'fen', rootFen: fen, moves: [] }
  } catch {
    // Continue with the explicit ICCS record format below.
  }

  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (lines[0] !== RECORD_HEADER) {
    throw new Error('Unsupported record format; supported formats are FEN and CHESS-MONITOR-ICCS 1')
  }
  const fenLine = lines.find((line) => line.startsWith('FEN '))
  const movesLine = lines.find((line) => line === 'MOVES' || line.startsWith('MOVES '))
  if (!fenLine || !movesLine || lines.some((line) => !(
    line === RECORD_HEADER || line.startsWith('FEN ') || line === 'MOVES' || line.startsWith('MOVES ')
  ))) {
    throw new Error('Unsupported record fields; only FEN and MOVES are supported')
  }

  const rootFen = normalizedFen(fenLine.slice(4))
  const tokens = movesLine.slice('MOVES'.length).trim().split(/\s+/).filter(Boolean)
  return {
    format: 'chess-monitor-iccs-v1',
    rootFen,
    moves: parseMoves(rootFen, tokens),
  }
}

function mateAgainstMover(score: NormalizedScore, mover: Side): boolean {
  if (score.mateIn === undefined) return false
  return mover === 'red' ? score.mateIn < 0 : score.mateIn > 0
}

function mateForMover(score: NormalizedScore, mover: Side): boolean {
  if (score.mateIn === undefined) return false
  return mover === 'red' ? score.mateIn > 0 : score.mateIn < 0
}

export function classifyMoveQuality(input: MoveQualityInput): MoveQualityMark | null {
  if (!input.bestMove || input.actualMove === input.bestMove) return null
  const questionThreshold = input.questionThresholdCp ?? 80
  const blunderThreshold = input.blunderThresholdCp ?? 180
  if (questionThreshold <= 0 || blunderThreshold < questionThreshold) {
    throw new Error('Move quality thresholds are invalid')
  }

  const afterMateLoss = mateAgainstMover(input.after, input.mover)
  const beforeMateLoss = mateAgainstMover(input.before, input.mover)
  if (afterMateLoss && !beforeMateLoss) {
    return {
      kind: 'blunder',
      lossCp: null,
      mateSwing: true,
      explanation: `实战着 ${input.actualMove} 偏离最佳着 ${input.bestMove}，并进入对行棋方不利的强制将杀。`,
    }
  }

  const beforeMateWin = mateForMover(input.before, input.mover)
  const afterMateWin = mateForMover(input.after, input.mover)
  if (beforeMateWin && !afterMateWin) {
    return {
      kind: 'blunder',
      lossCp: null,
      mateSwing: true,
      explanation: `实战着 ${input.actualMove} 偏离最佳着 ${input.bestMove}，并错失行棋方原有的强制将杀。`,
    }
  }

  if (input.before.cp === undefined || input.after.cp === undefined) return null
  const lossCp = input.mover === 'red'
    ? input.before.cp - input.after.cp
    : input.after.cp - input.before.cp
  if (lossCp < questionThreshold) return null

  const kind = lossCp >= blunderThreshold ? 'blunder' : 'question'
  return {
    kind,
    lossCp,
    mateSwing: false,
    explanation: `实战着 ${input.actualMove} 偏离最佳着 ${input.bestMove}，按红方视角评估换算后损失 ${lossCp} cp。`,
  }
}

export { DEFAULT_POSITION }
