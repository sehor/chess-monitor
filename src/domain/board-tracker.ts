import type { CaptureAnalysis } from '../shared/ipc'
import { RulesAdapter, type IccsMove } from './game'
import type { Orientation, PositionSnapshot } from './position'

export type TrackerStatus =
  | 'NO_BOARD'
  | 'CALIBRATING'
  | 'STABLE'
  | 'MOVE_ANIMATING'
  | 'MOVE_CANDIDATE'
  | 'MOVE_CONFIRMED'
  | 'DESYNC'
  | 'RESCANNING'

export interface TrackerOptions {
  changeThreshold: number
  confirmThreshold: number
  ambiguityMargin: number
  animationWaitMs: number
  candidateTimeoutMs: number
  maximumFrameGapMs: number
}

export interface TrackerObservation {
  capturedAt: number
  sourceValid: boolean
  profileValid: boolean
  analysis: CaptureAnalysis
}

export interface MoveCandidate {
  move: IccsMove
  originPoint: number
  destinationPoint: number
  originScore: number
  destinationScore: number
  confidence: number
  score: number
  unexplainedPointCount: number
}

export type TrackerState =
  | { status: 'NO_BOARD'; message: string }
  | { status: 'CALIBRATING'; message: string }
  | { status: 'STABLE'; since: number }
  | { status: 'MOVE_ANIMATING'; since: number; lastChangeAt: number }
  | { status: 'MOVE_CANDIDATE'; since: number; candidates: MoveCandidate[]; message: string }
  | { status: 'MOVE_CONFIRMED'; confirmedAt: number; move: IccsMove }
  | { status: 'DESYNC'; since: number; message: string; candidates: MoveCandidate[] }
  | { status: 'RESCANNING'; since: number; message: string }

export interface MoveConfirmedEvent {
  type: 'move-confirmed'
  move: IccsMove
  confirmation: 'automatic' | 'manual'
  previousFen: string
  fen: string
  previousPositionHash: string
  positionHash: string
  positionVersion: number
  capturedAt: number
  confirmedAt: number
}

export type BoardTrackerEvent =
  | { type: 'state'; state: TrackerState }
  | MoveConfirmedEvent

export interface BoardTrackerSnapshot {
  state: TrackerState
  position: PositionSnapshot
  candidates: MoveCandidate[]
  observationCount: number
  confirmedMoveCount: number
}

export interface TrackerDiagnosticObservation {
  capturedAt: number
  stateBefore: TrackerStatus
  sourceValid: boolean
  profileValid: boolean
  isStable: boolean
  changedPointCount: number
  topScores: Array<{ point: number; score: number }>
}

export interface BoardTrackerDiagnostics {
  generatedAt: string
  options: TrackerOptions
  snapshot: BoardTrackerSnapshot
  observations: TrackerDiagnosticObservation[]
}

export interface BoardTrackerRestoreState {
  basePositionVersion: number
  moves: IccsMove[]
  confirmedMoveCount: number
}

const DEFAULT_OPTIONS: TrackerOptions = {
  changeThreshold: 0.0076,
  confirmThreshold: 0.02,
  ambiguityMargin: 0.01,
  animationWaitMs: 250,
  candidateTimeoutMs: 1_500,
  maximumFrameGapMs: 750,
}

function positionHash(fen: string): string {
  let hash = 2166136261
  for (const character of fen) {
    hash ^= character.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function iccsSquareToPoint(square: string, orientation: Orientation): number {
  if (!/^[a-i][0-9]$/.test(square)) throw new Error('Invalid ICCS square')
  const file = square.charCodeAt(0) - 97
  const rank = Number(square[1])
  const screenFile = orientation === 'red-bottom' ? file : 8 - file
  const screenRank = orientation === 'red-bottom' ? 9 - rank : rank
  return screenRank * 9 + screenFile
}

export function expectedMovePoints(move: IccsMove, orientation: Orientation): [number, number] {
  return [
    iccsSquareToPoint(move.slice(0, 2), orientation),
    iccsSquareToPoint(move.slice(2, 4), orientation),
  ]
}

function validateOptions(options: TrackerOptions): void {
  if (
    !Number.isFinite(options.changeThreshold) || options.changeThreshold < 0 || options.changeThreshold > 1 ||
    !Number.isFinite(options.confirmThreshold) || options.confirmThreshold < options.changeThreshold || options.confirmThreshold > 1 ||
    !Number.isFinite(options.ambiguityMargin) || options.ambiguityMargin < 0 || options.ambiguityMargin > 1 ||
    !Number.isInteger(options.animationWaitMs) || options.animationWaitMs < 0 || options.animationWaitMs > 5_000 ||
    !Number.isInteger(options.candidateTimeoutMs) || options.candidateTimeoutMs < 100 || options.candidateTimeoutMs > 30_000 ||
    !Number.isInteger(options.maximumFrameGapMs) || options.maximumFrameGapMs < 100 || options.maximumFrameGapMs > 30_000
  ) {
    throw new Error('Tracker options are invalid')
  }
}

function validateObservation(observation: TrackerObservation): void {
  if (
    !Number.isFinite(observation.capturedAt) || observation.capturedAt < 0 ||
    observation.analysis.pointScores.length !== 90 ||
    observation.analysis.pointScores.some((score) => !Number.isFinite(score) || score < 0 || score > 1)
  ) {
    throw new Error('Tracker observation is invalid')
  }
}

export class BoardTracker {
  private readonly game: RulesAdapter
  private readonly options: TrackerOptions
  private state: TrackerState = { status: 'NO_BOARD', message: '等待有效捕获来源' }
  private accumulatedScores = Array<number>(90).fill(0)
  private candidates: MoveCandidate[] = []
  private observationCount = 0
  private confirmedMoveCount = 0
  private diagnosticObservations: TrackerDiagnosticObservation[] = []
  private lastCapturedAt: number | null = null

  constructor(
    fen: string,
    orientation: Orientation,
    options: Partial<TrackerOptions> = {},
    restore?: BoardTrackerRestoreState,
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options }
    validateOptions(this.options)
    this.game = new RulesAdapter(fen, orientation, restore?.basePositionVersion ?? 0)
    for (const move of restore?.moves ?? []) this.game.apply(move)
    this.confirmedMoveCount = restore?.confirmedMoveCount ?? 0
  }

  snapshot(): BoardTrackerSnapshot {
    return {
      state: structuredClone(this.state),
      position: this.game.snapshot(),
      candidates: this.candidates.map((candidate) => ({ ...candidate })),
      observationCount: this.observationCount,
      confirmedMoveCount: this.confirmedMoveCount,
    }
  }

  private transition(state: TrackerState): BoardTrackerEvent[] {
    if (JSON.stringify(this.state) === JSON.stringify(state)) return []
    this.state = state
    return [{ type: 'state', state: structuredClone(state) }]
  }

  private clearMotion(): void {
    this.accumulatedScores.fill(0)
    this.candidates = []
  }

  private accumulate(scores: number[]): void {
    for (let index = 0; index < 90; index += 1) {
      this.accumulatedScores[index] = Math.max(this.accumulatedScores[index], scores[index])
    }
  }

  private rankCandidates(): MoveCandidate[] {
    const changedPoints = new Set(
      this.accumulatedScores
        .map((score, point) => ({ point, score }))
        .filter(({ score }) => score >= this.options.changeThreshold)
        .map(({ point }) => point),
    )
    const orientation = this.game.snapshot().orientation
    return this.game.legalMoves().map((move) => {
      const [originPoint, destinationPoint] = expectedMovePoints(move, orientation)
      const originScore = this.accumulatedScores[originPoint]
      const destinationScore = this.accumulatedScores[destinationPoint]
      const confidence = Math.min(originScore, destinationScore)
      const unexplainedPointCount = [...changedPoints]
        .filter((point) => point !== originPoint && point !== destinationPoint).length
      const score = confidence + (originScore + destinationScore) / 4 - Math.min(0.05, unexplainedPointCount * 0.001)
      return { move, originPoint, destinationPoint, originScore, destinationScore, confidence, score, unexplainedPointCount }
    }).sort((left, right) => right.score - left.score || left.move.localeCompare(right.move))
  }

  private resolveMove(capturedAt: number): BoardTrackerEvent[] {
    this.candidates = this.rankCandidates().slice(0, 5)
    const [best, second] = this.candidates
    const gap = best ? best.score - (second?.score ?? 0) : 0
    if (!best || best.confidence < this.options.confirmThreshold || gap < this.options.ambiguityMargin) {
      const candidateSince = this.state.status === 'MOVE_CANDIDATE' ? this.state.since : capturedAt
      if (capturedAt - candidateSince >= this.options.candidateTimeoutMs) {
        return this.transition({
          status: 'DESYNC',
          since: candidateSince,
          message: best ? '候选着法不唯一或置信度不足' : '画面变化无法由合法单步解释',
          candidates: this.candidates,
        })
      }
      return this.transition({
        status: 'MOVE_CANDIDATE',
        since: candidateSince,
        candidates: this.candidates,
        message: best ? '等待候选拉开安全差距' : '没有合法着法匹配当前变化',
      })
    }

    return this.confirmMove(best.move, capturedAt, 'automatic')
  }

  private confirmMove(
    move: IccsMove,
    capturedAt: number,
    confirmation: MoveConfirmedEvent['confirmation'],
  ): BoardTrackerEvent[] {
    const previous = this.game.snapshot()
    const next = this.game.apply(move)
    this.confirmedMoveCount += 1
    this.clearMotion()
    const confirmedAt = capturedAt
    const state: TrackerState = { status: 'MOVE_CONFIRMED', confirmedAt, move }
    this.state = state
    return [
      { type: 'state', state },
      {
        type: 'move-confirmed',
        move,
        confirmation,
        previousFen: previous.fen,
        fen: next.fen,
        previousPositionHash: positionHash(previous.fen),
        positionHash: positionHash(next.fen),
        positionVersion: next.positionVersion,
        capturedAt,
        confirmedAt,
      },
    ]
  }

  confirmCandidate(move: string, capturedAt: number): BoardTrackerEvent[] {
    if (!Number.isFinite(capturedAt) || capturedAt < 0) throw new Error('Confirmation timestamp is invalid')
    if (this.state.status !== 'MOVE_CANDIDATE' && this.state.status !== 'DESYNC') {
      throw new Error('Tracker is not waiting for a candidate')
    }
    const candidate = this.candidates.find((item) => item.move === move)
    if (!candidate) throw new Error('Move is not one of the current legal candidates')
    return this.confirmMove(candidate.move, capturedAt, 'manual')
  }

  undo(capturedAt: number): BoardTrackerEvent[] {
    if (!Number.isFinite(capturedAt) || capturedAt < 0) throw new Error('Undo timestamp is invalid')
    const before = this.game.snapshot()
    const after = this.game.undo()
    if (after.moveHistory.length === before.moveHistory.length) throw new Error('There is no confirmed move to undo')
    this.confirmedMoveCount = Math.max(0, this.confirmedMoveCount - 1)
    this.clearMotion()
    return this.transition({ status: 'RESCANNING', since: capturedAt, message: '已撤销最近确认，等待画面重新稳定' })
  }

  observe(observation: TrackerObservation): BoardTrackerEvent[] {
    validateObservation(observation)
    if (this.lastCapturedAt !== null && observation.capturedAt < this.lastCapturedAt) return []
    const frameGapMs = this.lastCapturedAt === null ? 0 : observation.capturedAt - this.lastCapturedAt
    this.lastCapturedAt = observation.capturedAt
    this.observationCount += 1
    this.diagnosticObservations.push({
      capturedAt: observation.capturedAt,
      stateBefore: this.state.status,
      sourceValid: observation.sourceValid,
      profileValid: observation.profileValid,
      isStable: observation.analysis.isStable,
      changedPointCount: observation.analysis.changedPointCount,
      topScores: observation.analysis.pointScores
        .map((score, point) => ({ point, score }))
        .sort((left, right) => right.score - left.score)
        .slice(0, 8),
    })
    if (this.diagnosticObservations.length > 256) this.diagnosticObservations.shift()
    if (!observation.sourceValid) {
      this.clearMotion()
      return this.transition({ status: 'NO_BOARD', message: '捕获来源不可用' })
    }
    if (!observation.profileValid) {
      this.clearMotion()
      return this.transition({ status: 'CALIBRATING', message: 'Profile 已失效，需要重新校准' })
    }
    if (this.state.status === 'DESYNC') return []
    if (
      frameGapMs > this.options.maximumFrameGapMs &&
      (this.state.status === 'MOVE_ANIMATING' || this.state.status === 'MOVE_CANDIDATE')
    ) {
      this.clearMotion()
      return this.transition({
        status: 'DESYNC',
        since: observation.capturedAt,
        message: `连续帧间隔 ${frameGapMs} ms 超出安全上限，无法证明仍是单步变化`,
        candidates: [],
      })
    }

    const hasChange = observation.analysis.changedPointCount > 0
    const isEstablishingBaseline =
      this.state.status === 'NO_BOARD' ||
      this.state.status === 'CALIBRATING' ||
      this.state.status === 'RESCANNING'
    if (isEstablishingBaseline && !hasChange) {
      if (!observation.analysis.isStable) return []
      return this.transition({ status: 'STABLE', since: observation.capturedAt })
    }

    if (hasChange || !observation.analysis.isStable) {
      this.accumulate(observation.analysis.pointScores)
      const since = this.state.status === 'MOVE_ANIMATING' ? this.state.since : observation.capturedAt
      return this.transition({
        status: 'MOVE_ANIMATING',
        since,
        lastChangeAt: observation.capturedAt,
      })
    }

    if (this.state.status === 'MOVE_ANIMATING') {
      if (observation.capturedAt - this.state.lastChangeAt < this.options.animationWaitMs) return []
      return this.resolveMove(observation.capturedAt)
    }
    if (this.state.status === 'MOVE_CANDIDATE') return this.resolveMove(observation.capturedAt)
    if (this.state.status === 'RESCANNING' || this.state.status === 'NO_BOARD' || this.state.status === 'CALIBRATING' || this.state.status === 'MOVE_CONFIRMED') {
      return this.transition({ status: 'STABLE', since: observation.capturedAt })
    }
    return []
  }

  resync(fen: string, capturedAt: number): BoardTrackerEvent[] {
    this.game.reset(fen)
    this.clearMotion()
    return this.transition({ status: 'RESCANNING', since: capturedAt, message: '等待重同步局面的稳定基线' })
  }

  stop(): BoardTrackerEvent[] {
    this.clearMotion()
    return this.transition({ status: 'NO_BOARD', message: '监控已停止' })
  }

  diagnostics(): BoardTrackerDiagnostics {
    return {
      generatedAt: new Date().toISOString(),
      options: { ...this.options },
      snapshot: this.snapshot(),
      observations: structuredClone(this.diagnosticObservations),
    }
  }
}
