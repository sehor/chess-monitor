import { DEFAULT_POSITION } from '@west-shell/xiangqi.js'
import { describe, expect, it } from 'vitest'
import type { CaptureAnalysis } from '../shared/ipc'
import { expectedMovePoints, type TrackerObservation } from './board-tracker'
import { RulesAdapter, type IccsMove } from './game'
import { injectReplayFaults, replayLabelledSequences, type LabelledReplaySequence } from './tracker-replay'

function analysis(overrides: Partial<CaptureAnalysis> = {}): CaptureAnalysis {
  return {
    isStable: true,
    stableFrameCount: 3,
    changedPointCount: 0,
    medianScore: 0,
    pointScores: Array(90).fill(0),
    ...overrides,
  }
}

function labelledSequence(id: string, move: IccsMove): LabelledReplaySequence {
  const scores = Array(90).fill(0)
  for (const point of expectedMovePoints(move, 'red-bottom')) scores[point] = 0.2
  const game = new RulesAdapter(DEFAULT_POSITION)
  const expectedFen = game.apply(move).fen
  return {
    id,
    initialFen: DEFAULT_POSITION,
    orientation: 'red-bottom',
    expectedMove: move,
    expectedFen,
    frames: [
      { capturedAt: 0, sourceValid: true, profileValid: true, analysis: analysis() },
      { capturedAt: 100, sourceValid: true, profileValid: true, analysis: analysis({ isStable: false, stableFrameCount: 0, changedPointCount: 2, pointScores: scores }) },
      { capturedAt: 400, sourceValid: true, profileValid: true, analysis: analysis() },
    ],
  }
}

describe('replayLabelledSequences', () => {
  it('injects drop, duplicate, reorder and profile-invalid faults deterministically', () => {
    const original = labelledSequence('fault-base', 'a3a4')
    const dropped = injectReplayFaults(original, [{ type: 'drop-frame', frameIndex: 1 }])
    const duplicated = injectReplayFaults(original, [{ type: 'duplicate-frame', frameIndex: 1 }])
    const reordered = injectReplayFaults(original, [{ type: 'reorder-adjacent', frameIndex: 1 }])
    const invalidProfile = injectReplayFaults(original, [{ type: 'profile-invalid', frameIndex: 1 }])

    expect(dropped.frames).toHaveLength(original.frames.length - 1)
    expect(duplicated.frames).toHaveLength(original.frames.length + 1)
    expect(reordered.frames.map((frame) => frame.capturedAt)).toEqual([0, 400, 100])
    expect(invalidProfile.frames[1].profileValid).toBe(false)
    expect(original.frames.map((frame) => frame.capturedAt)).toEqual([0, 100, 400])
  })

  it('never silently confirms a wrong move across deterministic transport faults', () => {
    const base = labelledSequence('faulted-move', 'a3a4')
    const faulted = [
      injectReplayFaults(base, [{ type: 'drop-frame', frameIndex: 1 }]),
      injectReplayFaults(base, [{ type: 'duplicate-frame', frameIndex: 1 }]),
      injectReplayFaults(base, [{ type: 'reorder-adjacent', frameIndex: 1 }]),
      injectReplayFaults(base, [{ type: 'profile-invalid', frameIndex: 1 }]),
    ]
    const report = replayLabelledSequences(faulted)

    expect(report.silentMismatchCount).toBe(0)
    expect(report.results.every((result) => result.confirmedMove === null || result.confirmedMove === result.expectedMove)).toBe(true)
  })

  it('replays 1,000 labelled moves and reports the phase-3 quality metrics', () => {
    const moves: IccsMove[] = ['a3a4', 'c3c4', 'e3e4', 'g3g4', 'i3i4']
    const sequences = Array.from({ length: 1_000 }, (_, index) => labelledSequence(`move-${index}`, moves[index % moves.length]))
    const report = replayLabelledSequences(sequences)

    expect(report).toMatchObject({
      sequenceCount: 1_000,
      labelledMoveCount: 1_000,
      confirmedMoveCount: 1_000,
      refusedMoveCount: 0,
      mismatchCount: 0,
      silentMismatchCount: 0,
      confirmationAccuracy: 1,
      endpointRecall: 1,
      normalRefusalRate: 0,
    })
    expect(report.p95StableToConfirmationMs).toBeLessThan(500)
  }, 20_000)

  it('does not confirm dropped frames or capture/profile failures', () => {
    const originOnly = Array(90).fill(0)
    originOnly[expectedMovePoints('a3a4', 'red-bottom')[0]] = 0.2
    const failureFrames: TrackerObservation[][] = [
      [
        { capturedAt: 0, sourceValid: true, profileValid: true, analysis: analysis() },
        { capturedAt: 100, sourceValid: true, profileValid: true, analysis: analysis({ isStable: false, changedPointCount: 1, pointScores: originOnly }) },
        { capturedAt: 400, sourceValid: true, profileValid: true, analysis: analysis() },
      ],
      [{ capturedAt: 0, sourceValid: false, profileValid: true, analysis: analysis() }],
      [{ capturedAt: 0, sourceValid: true, profileValid: false, analysis: analysis() }],
    ]
    const report = replayLabelledSequences(failureFrames.map((frames, index) => ({
      id: `failure-${index}`,
      initialFen: DEFAULT_POSITION,
      orientation: 'red-bottom',
      expectedMove: null,
      frames,
    })))

    expect(report.confirmedMoveCount).toBe(0)
    expect(report.silentMismatchCount).toBe(0)
    expect(report.results.map((result) => result.finalStatus)).toEqual(['MOVE_CANDIDATE', 'NO_BOARD', 'CALIBRATING'])
  })
})
