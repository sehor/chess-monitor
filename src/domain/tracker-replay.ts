import { BoardTracker, expectedMovePoints, type MoveConfirmedEvent, type TrackerObservation, type TrackerOptions } from './board-tracker'
import type { IccsMove } from './game'
import type { Orientation } from './position'

export interface LabelledReplaySequence {
  id: string
  initialFen: string
  orientation: Orientation
  expectedMove: IccsMove | null
  expectedFen?: string
  frames: TrackerObservation[]
}

export type ReplayFault =
  | { type: 'drop-frame'; frameIndex: number }
  | { type: 'duplicate-frame'; frameIndex: number }
  | { type: 'reorder-adjacent'; frameIndex: number }
  | { type: 'profile-invalid'; frameIndex: number }

export interface ReplaySequenceResult {
  id: string
  expectedMove: IccsMove | null
  confirmedMove: IccsMove | null
  finalStatus: ReturnType<BoardTracker['snapshot']>['state']['status']
  endpointHits: number
  endpointTotal: number
  stableToConfirmationMs: number | null
  mismatch: boolean
}

export interface TrackerReplayReport {
  sequenceCount: number
  labelledMoveCount: number
  confirmedMoveCount: number
  refusedMoveCount: number
  mismatchCount: number
  silentMismatchCount: number
  confirmationAccuracy: number | null
  endpointRecall: number | null
  normalRefusalRate: number | null
  p95StableToConfirmationMs: number | null
  results: ReplaySequenceResult[]
}

function cloneObservation(frame: TrackerObservation): TrackerObservation {
  return {
    ...frame,
    analysis: {
      ...frame.analysis,
      pointScores: [...frame.analysis.pointScores],
    },
  }
}

export function injectReplayFaults(
  sequence: LabelledReplaySequence,
  faults: readonly ReplayFault[],
): LabelledReplaySequence {
  const frames = sequence.frames.map(cloneObservation)
  for (const fault of faults) {
    if (!Number.isInteger(fault.frameIndex) || fault.frameIndex < 0 || fault.frameIndex >= frames.length) {
      throw new Error('Replay fault frame index is out of range')
    }
    if (fault.type === 'drop-frame') {
      frames.splice(fault.frameIndex, 1)
    } else if (fault.type === 'duplicate-frame') {
      frames.splice(fault.frameIndex + 1, 0, cloneObservation(frames[fault.frameIndex]))
    } else if (fault.type === 'reorder-adjacent') {
      if (fault.frameIndex + 1 >= frames.length) throw new Error('Replay reorder fault requires a following frame')
      ;[frames[fault.frameIndex], frames[fault.frameIndex + 1]] = [frames[fault.frameIndex + 1], frames[fault.frameIndex]]
    } else {
      frames[fault.frameIndex] = { ...frames[fault.frameIndex], profileValid: false }
    }
  }
  return {
    ...sequence,
    frames,
  }
}

function percentile95(values: number[]): number | null {
  if (values.length === 0) return null
  const ordered = [...values].sort((left, right) => left - right)
  return ordered[Math.ceil(ordered.length * 0.95) - 1]
}

export function replayLabelledSequences(
  sequences: readonly LabelledReplaySequence[],
  options: Partial<TrackerOptions> = {},
): TrackerReplayReport {
  const evidenceThreshold = options.changeThreshold ?? 0.0076
  const results: ReplaySequenceResult[] = []

  for (const sequence of sequences) {
    if (!sequence.id || sequence.frames.length === 0) throw new Error('Replay sequences require an ID and at least one frame')
    const tracker = new BoardTracker(sequence.initialFen, sequence.orientation, options)
    const confirmations: MoveConfirmedEvent[] = []
    let sawMotion = false
    let firstSettledAt: number | null = null
    const maximumScores = new Float32Array(90)

    for (const frame of sequence.frames) {
      if (frame.analysis.changedPointCount > 0 || !frame.analysis.isStable) sawMotion = true
      if (sawMotion && frame.analysis.isStable && frame.analysis.changedPointCount === 0 && firstSettledAt === null) {
        firstSettledAt = frame.capturedAt
      }
      for (let point = 0; point < 90; point += 1) {
        maximumScores[point] = Math.max(maximumScores[point], frame.analysis.pointScores[point])
      }
      for (const event of tracker.observe(frame)) {
        if (event.type === 'move-confirmed') confirmations.push(event)
      }
    }

    const confirmed = confirmations.at(-1) ?? null
    const endpointPoints = sequence.expectedMove
      ? expectedMovePoints(sequence.expectedMove, sequence.orientation)
      : []
    const endpointHits = endpointPoints.filter((point) => maximumScores[point] >= evidenceThreshold).length
    const mismatch = Boolean(
      (sequence.expectedMove && confirmed?.move !== sequence.expectedMove) ||
      (!sequence.expectedMove && confirmed) ||
      (sequence.expectedFen && confirmed?.fen !== sequence.expectedFen),
    )
    results.push({
      id: sequence.id,
      expectedMove: sequence.expectedMove,
      confirmedMove: confirmed?.move ?? null,
      finalStatus: tracker.snapshot().state.status,
      endpointHits,
      endpointTotal: endpointPoints.length,
      stableToConfirmationMs: confirmed && firstSettledAt !== null
        ? Math.max(0, confirmed.confirmedAt - firstSettledAt)
        : null,
      mismatch,
    })
  }

  const labelled = results.filter((result) => result.expectedMove !== null)
  const confirmed = labelled.filter((result) => result.confirmedMove !== null)
  const endpointTotal = results.reduce((total, result) => total + result.endpointTotal, 0)
  const endpointHits = results.reduce((total, result) => total + result.endpointHits, 0)
  const latencies = results.flatMap((result) => result.stableToConfirmationMs === null ? [] : [result.stableToConfirmationMs])
  const mismatchCount = results.filter((result) => result.mismatch).length
  return {
    sequenceCount: results.length,
    labelledMoveCount: labelled.length,
    confirmedMoveCount: confirmed.length,
    refusedMoveCount: labelled.length - confirmed.length,
    mismatchCount,
    silentMismatchCount: results.filter((result) => result.mismatch && result.confirmedMove !== null).length,
    confirmationAccuracy: confirmed.length ? confirmed.filter((result) => !result.mismatch).length / confirmed.length : null,
    endpointRecall: endpointTotal ? endpointHits / endpointTotal : null,
    normalRefusalRate: labelled.length ? (labelled.length - confirmed.length) / labelled.length : null,
    p95StableToConfirmationMs: percentile95(latencies),
    results,
  }
}
