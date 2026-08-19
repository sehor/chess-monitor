import { RulesAdapter } from './game'
import type { Orientation, Side } from './position'

export const RECOGNITION_CLASSES = [
  '_',
  'R', 'N', 'B', 'A', 'K', 'C', 'P',
  'r', 'n', 'b', 'a', 'k', 'c', 'p',
] as const

export type RecognitionClass = (typeof RECOGNITION_CLASSES)[number]
export type RecognitionProbabilityFrame = number[][]

export interface RecognitionCorrection {
  point: number
  label: RecognitionClass
}

export interface RecognitionOptions {
  pointConfidenceThreshold: number
  boardConfidenceThreshold: number
  alternativeProbabilityFloor: number
  alternativeRatio: number
  maxAmbiguousPoints: number
  maxCandidates: number
}

export interface RecognitionAlternative {
  label: RecognitionClass
  probability: number
}

export interface RecognitionPointPrediction {
  point: number
  label: RecognitionClass
  confidence: number
  alternatives: RecognitionAlternative[]
  corrected: boolean
}

export interface RecognitionCandidate {
  fen: string
  score: number
  boardConfidence: number
  minimumConfidence: number
  labels: RecognitionClass[]
  points: RecognitionPointPrediction[]
}

export type RecognitionEvaluationStatus = 'READY' | 'NEEDS_CORRECTION' | 'REJECTED'

export interface RecognitionEvaluation {
  status: RecognitionEvaluationStatus
  candidates: RecognitionCandidate[]
  lowConfidencePoints: number[]
  issues: string[]
}

export interface RecognitionEvaluationInput {
  probabilities: RecognitionProbabilityFrame
  orientation: Orientation
  sideToMove: Side
  corrections?: RecognitionCorrection[]
  options?: Partial<RecognitionOptions>
}

const DEFAULT_OPTIONS: RecognitionOptions = {
  pointConfidenceThreshold: 0.9,
  boardConfidenceThreshold: 0.985,
  alternativeProbabilityFloor: 0.05,
  alternativeRatio: 0.2,
  maxAmbiguousPoints: 8,
  maxCandidates: 64,
}

const PIECE_LIMITS: Partial<Record<RecognitionClass, number>> = {
  K: 1,
  R: 2,
  N: 2,
  B: 2,
  A: 2,
  C: 2,
  P: 5,
  k: 1,
  r: 2,
  n: 2,
  b: 2,
  a: 2,
  c: 2,
  p: 5,
}

const RED_ELEPHANT_SQUARES = new Set(['9,2', '9,6', '7,0', '7,4', '7,8', '5,2', '5,6'])
const BLACK_ELEPHANT_SQUARES = new Set(['0,2', '0,6', '2,0', '2,4', '2,8', '4,2', '4,6'])

function validateOptions(options: RecognitionOptions): void {
  if (
    !Number.isFinite(options.pointConfidenceThreshold) || options.pointConfidenceThreshold < 0 || options.pointConfidenceThreshold > 1 ||
    !Number.isFinite(options.boardConfidenceThreshold) || options.boardConfidenceThreshold < 0 || options.boardConfidenceThreshold > 1 ||
    !Number.isFinite(options.alternativeProbabilityFloor) || options.alternativeProbabilityFloor < 0 || options.alternativeProbabilityFloor > 1 ||
    !Number.isFinite(options.alternativeRatio) || options.alternativeRatio < 0 || options.alternativeRatio > 1 ||
    !Number.isInteger(options.maxAmbiguousPoints) || options.maxAmbiguousPoints < 0 || options.maxAmbiguousPoints > 20 ||
    !Number.isInteger(options.maxCandidates) || options.maxCandidates < 1 || options.maxCandidates > 512
  ) {
    throw new Error('Recognition options are invalid')
  }
}

function validateProbabilityFrame(frame: RecognitionProbabilityFrame): void {
  if (!Array.isArray(frame) || frame.length !== 90) throw new Error('Recognition frame must contain 90 points')
  for (const row of frame) {
    if (!Array.isArray(row) || row.length !== RECOGNITION_CLASSES.length) {
      throw new Error('Recognition point probabilities must contain 15 classes')
    }
    let total = 0
    for (const probability of row) {
      if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
        throw new Error('Recognition probabilities must be finite values between 0 and 1')
      }
      total += probability
    }
    if (total <= 0) throw new Error('Recognition probabilities must have positive mass')
  }
}

function normalizedRow(row: number[]): number[] {
  const total = row.reduce((sum, value) => sum + value, 0)
  return row.map((value) => value / total)
}

export function fuseProbabilityFrames(frames: RecognitionProbabilityFrame[]): RecognitionProbabilityFrame {
  if (!Array.isArray(frames) || frames.length < 1 || frames.length > 8) {
    throw new Error('Recognition requires between one and eight probability frames')
  }
  for (const frame of frames) validateProbabilityFrame(frame)

  return Array.from({ length: 90 }, (_, point) => {
    const fused = Array<number>(RECOGNITION_CLASSES.length).fill(0)
    for (const frame of frames) {
      const row = normalizedRow(frame[point])
      for (let classIndex = 0; classIndex < fused.length; classIndex += 1) {
        fused[classIndex] += row[classIndex] / frames.length
      }
    }
    return fused
  })
}

function logicalIndexFromScreenPoint(point: number, orientation: Orientation): number {
  const screenRow = Math.floor(point / 9)
  const screenFile = point % 9
  if (orientation === 'red-bottom') return point
  return (9 - screenRow) * 9 + (8 - screenFile)
}

function screenLabelsToLogical(labels: RecognitionClass[], orientation: Orientation): RecognitionClass[] {
  const logical = Array<RecognitionClass>(90).fill('_')
  labels.forEach((label, point) => {
    logical[logicalIndexFromScreenPoint(point, orientation)] = label
  })
  return logical
}

function boardFieldFromLabels(labels: RecognitionClass[], orientation: Orientation): string {
  const logical = screenLabelsToLogical(labels, orientation)
  const ranks: string[] = []
  for (let row = 0; row < 10; row += 1) {
    let rank = ''
    let empty = 0
    for (let file = 0; file < 9; file += 1) {
      const label = logical[row * 9 + file]
      if (label === '_') {
        empty += 1
        continue
      }
      if (empty > 0) {
        rank += String(empty)
        empty = 0
      }
      rank += label
    }
    if (empty > 0) rank += String(empty)
    ranks.push(rank)
  }
  return ranks.join('/')
}

function toFen(labels: RecognitionClass[], orientation: Orientation, sideToMove: Side): string {
  return `${boardFieldFromLabels(labels, orientation)} ${sideToMove === 'red' ? 'w' : 'b'} - - 0 1`
}

function isInPalace(row: number, file: number, side: Side): boolean {
  if (file < 3 || file > 5) return false
  return side === 'red' ? row >= 7 && row <= 9 : row >= 0 && row <= 2
}

function validatePiecePlacement(labels: RecognitionClass[], orientation: Orientation): string[] {
  const logical = screenLabelsToLogical(labels, orientation)
  const issues: string[] = []
  const counts = new Map<RecognitionClass, number>()

  for (let index = 0; index < logical.length; index += 1) {
    const label = logical[index]
    if (label === '_') continue
    counts.set(label, (counts.get(label) ?? 0) + 1)
    const row = Math.floor(index / 9)
    const file = index % 9

    if (label === 'K' && !isInPalace(row, file, 'red')) issues.push('红帅不在九宫内')
    if (label === 'k' && !isInPalace(row, file, 'black')) issues.push('黑将不在九宫内')
    if (label === 'A' && !isInPalace(row, file, 'red')) issues.push('红仕不在九宫内')
    if (label === 'a' && !isInPalace(row, file, 'black')) issues.push('黑士不在九宫内')
    if (label === 'B' && !RED_ELEPHANT_SQUARES.has(`${row},${file}`)) issues.push('红相位于不可能的交叉点')
    if (label === 'b' && !BLACK_ELEPHANT_SQUARES.has(`${row},${file}`)) issues.push('黑象位于不可能的交叉点')

    if (label === 'P') {
      if (row >= 7) issues.push('红兵位于不可能的本方后场')
      if (row >= 5 && file % 2 === 1) issues.push('未过河红兵位于不可能的纵线')
    }
    if (label === 'p') {
      if (row <= 2) issues.push('黑卒位于不可能的本方后场')
      if (row <= 4 && file % 2 === 1) issues.push('未过河黑卒位于不可能的纵线')
    }
  }

  if ((counts.get('K') ?? 0) !== 1 || (counts.get('k') ?? 0) !== 1) {
    issues.push('局面必须且只能包含一个红帅和一个黑将')
  }
  for (const [piece, limit] of Object.entries(PIECE_LIMITS) as Array<[RecognitionClass, number]>) {
    if ((counts.get(piece) ?? 0) > limit) issues.push(`${piece} 棋子数量超过上限 ${limit}`)
  }

  const redKing = logical.findIndex((label) => label === 'K')
  const blackKing = logical.findIndex((label) => label === 'k')
  if (redKing >= 0 && blackKing >= 0 && redKing % 9 === blackKing % 9) {
    const file = redKing % 9
    const start = Math.min(Math.floor(redKing / 9), Math.floor(blackKing / 9)) + 1
    const end = Math.max(Math.floor(redKing / 9), Math.floor(blackKing / 9))
    let blockers = 0
    for (let row = start; row < end; row += 1) {
      if (logical[row * 9 + file] !== '_') blockers += 1
    }
    if (blockers === 0) issues.push('将帅照面')
  }

  return [...new Set(issues)]
}

function validateCandidate(labels: RecognitionClass[], orientation: Orientation, sideToMove: Side): string[] {
  const issues = validatePiecePlacement(labels, orientation)
  if (issues.length > 0) return issues
  try {
    const game = new RulesAdapter(toFen(labels, orientation, sideToMove), orientation)
    game.status()
  } catch {
    return ['规则适配层拒绝该 FEN']
  }
  return []
}

function pointChoices(
  probabilities: RecognitionProbabilityFrame,
  corrections: Map<number, RecognitionClass>,
  options: RecognitionOptions,
): Array<Array<RecognitionAlternative & { classIndex: number }>> {
  return probabilities.map((rawRow, point) => {
    const row = normalizedRow(rawRow)
    const correction = corrections.get(point)
    if (correction) {
      const classIndex = RECOGNITION_CLASSES.indexOf(correction)
      return [{ label: correction, probability: 1, classIndex }]
    }

    const ranked = row
      .map((probability, classIndex) => ({
        label: RECOGNITION_CLASSES[classIndex],
        probability,
        classIndex,
      }))
      .sort((left, right) => right.probability - left.probability || left.classIndex - right.classIndex)
    const best = ranked[0]
    const threshold = Math.max(options.alternativeProbabilityFloor, best.probability * options.alternativeRatio)
    return ranked.filter((choice, index) => index === 0 || choice.probability >= threshold).slice(0, 4)
  })
}

function candidateFromLabels(
  labels: RecognitionClass[],
  probabilities: RecognitionProbabilityFrame,
  choices: ReturnType<typeof pointChoices>,
  corrections: Map<number, RecognitionClass>,
  orientation: Orientation,
  sideToMove: Side,
): RecognitionCandidate {
  let score = 0
  let logProbabilitySum = 0
  let minimumConfidence = 1
  const points = labels.map((label, point): RecognitionPointPrediction => {
    const corrected = corrections.has(point)
    const row = normalizedRow(probabilities[point])
    const probability = corrected ? 1 : row[RECOGNITION_CLASSES.indexOf(label)]
    score += Math.log(Math.max(probability, Number.EPSILON))
    logProbabilitySum += Math.log(Math.max(probability, Number.EPSILON))
    minimumConfidence = Math.min(minimumConfidence, probability)
    return {
      point,
      label,
      confidence: probability,
      alternatives: choices[point].map(({ label: choiceLabel, probability: choiceProbability }) => ({
        label: choiceLabel,
        probability: choiceProbability,
      })),
      corrected,
    }
  })

  return {
    fen: toFen(labels, orientation, sideToMove),
    score,
    boardConfidence: Math.exp(logProbabilitySum / 90),
    minimumConfidence,
    labels: [...labels],
    points,
  }
}

function searchCandidates(
  probabilities: RecognitionProbabilityFrame,
  orientation: Orientation,
  sideToMove: Side,
  corrections: Map<number, RecognitionClass>,
  options: RecognitionOptions,
): { candidates: RecognitionCandidate[]; ambiguousPoints: number[]; validationIssues: string[] } {
  const choices = pointChoices(probabilities, corrections, options)
  const baseline = choices.map((row) => row[0].label)
  const ambiguousPoints = choices
    .map((row, point) => ({ point, count: row.length }))
    .filter(({ count }) => count > 1)
    .map(({ point }) => point)

  if (ambiguousPoints.length > options.maxAmbiguousPoints) {
    const issues = validateCandidate(baseline, orientation, sideToMove)
    const candidate = issues.length === 0
      ? candidateFromLabels(baseline, probabilities, choices, corrections, orientation, sideToMove)
      : null
    return {
      candidates: candidate ? [candidate] : [],
      ambiguousPoints,
      validationIssues: issues.length > 0 ? issues : ['低置信度交叉点过多，禁止自动枚举局面'],
    }
  }

  type PartialCandidate = { labels: RecognitionClass[]; score: number }
  let beam: PartialCandidate[] = [{ labels: baseline, score: 0 }]
  for (const point of ambiguousPoints) {
    const next: PartialCandidate[] = []
    for (const item of beam) {
      for (const choice of choices[point]) {
        const labels = [...item.labels]
        labels[point] = choice.label
        next.push({ labels, score: item.score + Math.log(Math.max(choice.probability, Number.EPSILON)) })
      }
    }
    beam = next
      .sort((left, right) => right.score - left.score)
      .slice(0, options.maxCandidates)
  }

  const unique = new Map<string, RecognitionCandidate>()
  const validationIssueSet = new Set<string>()
  for (const item of beam) {
    const issues = validateCandidate(item.labels, orientation, sideToMove)
    for (const issue of issues) validationIssueSet.add(issue)
    if (issues.length > 0) continue
    const candidate = candidateFromLabels(
      item.labels,
      probabilities,
      choices,
      corrections,
      orientation,
      sideToMove,
    )
    const existing = unique.get(candidate.fen)
    if (!existing || candidate.score > existing.score) unique.set(candidate.fen, candidate)
  }

  return {
    candidates: [...unique.values()]
      .sort((left, right) => right.score - left.score || left.fen.localeCompare(right.fen))
      .slice(0, options.maxCandidates),
    ambiguousPoints,
    validationIssues: [...validationIssueSet],
  }
}

export function evaluateRecognition(input: RecognitionEvaluationInput): RecognitionEvaluation {
  validateProbabilityFrame(input.probabilities)
  const options = { ...DEFAULT_OPTIONS, ...input.options }
  validateOptions(options)

  const corrections = new Map<number, RecognitionClass>()
  for (const correction of input.corrections ?? []) {
    if (
      !Number.isInteger(correction.point) || correction.point < 0 || correction.point >= 90 ||
      !RECOGNITION_CLASSES.includes(correction.label)
    ) {
      throw new Error('Recognition correction is invalid')
    }
    corrections.set(correction.point, correction.label)
  }

  const probabilities = input.probabilities.map(normalizedRow)
  const lowConfidencePoints = probabilities
    .map((row, point) => {
      const sorted = [...row].sort((left, right) => right - left)
      const hasPlausibleAlternative = sorted[1] >= Math.max(options.alternativeProbabilityFloor, sorted[0] * options.alternativeRatio)
      return {
        point,
        low: !corrections.has(point) && (sorted[0] < options.pointConfidenceThreshold || hasPlausibleAlternative),
      }
    })
    .filter(({ low }) => low)
    .map(({ point }) => point)

  const searched = searchCandidates(
    probabilities,
    input.orientation,
    input.sideToMove,
    corrections,
    options,
  )
  if (searched.candidates.length === 0) {
    return {
      status: 'REJECTED',
      candidates: [],
      lowConfidencePoints: [...new Set([...lowConfidencePoints, ...searched.ambiguousPoints])].sort((a, b) => a - b),
      issues: searched.validationIssues.length > 0
        ? searched.validationIssues
        : ['没有通过规则校验的合法候选局面'],
    }
  }

  const best = searched.candidates[0]
  const confidenceAccepted =
    best.minimumConfidence >= options.pointConfidenceThreshold &&
    best.boardConfidence >= options.boardConfidenceThreshold
  const unique = searched.candidates.length === 1
  const status: RecognitionEvaluationStatus = unique && confidenceAccepted ? 'READY' : 'NEEDS_CORRECTION'
  const issues: string[] = []
  if (!unique) issues.push(`存在 ${searched.candidates.length} 个合法候选，禁止自动选择`)
  if (!confidenceAccepted) issues.push('整盘或交叉点置信度未达到自动接受门槛')

  return {
    status,
    candidates: searched.candidates,
    lowConfidencePoints: [...new Set([...lowConfidencePoints, ...searched.ambiguousPoints])].sort((a, b) => a - b),
    issues,
  }
}
