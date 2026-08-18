import { DEFAULT_POSITION } from '@west-shell/xiangqi.js'
import { describe, expect, it } from 'vitest'
import type { CaptureAnalysis } from '../shared/ipc'
import { BoardTracker, expectedMovePoints, iccsSquareToPoint } from './board-tracker'
import { RulesAdapter } from './game'

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

function moveScores(move: string, orientation: 'red-bottom' | 'black-bottom' = 'red-bottom'): number[] {
  const scores = Array(90).fill(0)
  const [origin, destination] = expectedMovePoints(move as `${string}${string}${string}${string}`, orientation)
  scores[origin] = 0.2
  scores[destination] = 0.22
  return scores
}

function playObservation(tracker: BoardTracker, move: string, startedAt = 100) {
  tracker.observe({ capturedAt: startedAt, sourceValid: true, profileValid: true, analysis: analysis({
    isStable: false,
    stableFrameCount: 0,
    changedPointCount: 2,
    pointScores: moveScores(move),
  }) })
  return tracker.observe({ capturedAt: startedAt + 300, sourceValid: true, profileValid: true, analysis: analysis() })
}

describe('BoardTracker', () => {
  it('maps ICCS squares into both capture orientations', () => {
    expect(iccsSquareToPoint('a0', 'red-bottom')).toBe(81)
    expect(iccsSquareToPoint('i9', 'red-bottom')).toBe(8)
    expect(iccsSquareToPoint('a0', 'black-bottom')).toBe(8)
    expect(iccsSquareToPoint('i9', 'black-bottom')).toBe(81)
  })

  it('confirms the unique legal move after animation settles', () => {
    const tracker = new BoardTracker(DEFAULT_POSITION, 'red-bottom')
    tracker.observe({ capturedAt: 0, sourceValid: true, profileValid: true, analysis: analysis() })
    const move = tracker.snapshot().position.sideToMove === 'red' ? 'a3a4' : 'a6a5'
    const events = playObservation(tracker, move)
    expect(events.find((event) => event.type === 'move-confirmed')).toMatchObject({ type: 'move-confirmed', move, confirmation: 'automatic' })
    expect(tracker.snapshot()).toMatchObject({
      state: { status: 'MOVE_CONFIRMED', move },
      confirmedMoveCount: 1,
      position: { lastMove: move, positionVersion: 1 },
    })
  })

  it('establishes a stable baseline without inventing an opening move', () => {
    const tracker = new BoardTracker(DEFAULT_POSITION, 'red-bottom')
    expect(tracker.observe({
      capturedAt: 0,
      sourceValid: true,
      profileValid: true,
      analysis: analysis({ isStable: false, stableFrameCount: 1 }),
    })).toEqual([])
    expect(tracker.snapshot().state.status).toBe('NO_BOARD')
    tracker.observe({ capturedAt: 100, sourceValid: true, profileValid: true, analysis: analysis() })
    expect(tracker.snapshot()).toMatchObject({ state: { status: 'STABLE' }, candidates: [], confirmedMoveCount: 0 })
  })

  it('accumulates animation frames and tolerates unrelated highlight changes', () => {
    const tracker = new BoardTracker(DEFAULT_POSITION, 'red-bottom')
    tracker.observe({ capturedAt: 0, sourceValid: true, profileValid: true, analysis: analysis() })
    const [origin, destination] = expectedMovePoints('a3a4', 'red-bottom')
    const first = Array(90).fill(0)
    first[origin] = 0.2
    first[0] = 0.025
    tracker.observe({ capturedAt: 100, sourceValid: true, profileValid: true, analysis: analysis({ isStable: false, changedPointCount: 2, pointScores: first }) })
    const second = Array(90).fill(0)
    second[destination] = 0.22
    second[10] = 0.025
    tracker.observe({ capturedAt: 180, sourceValid: true, profileValid: true, analysis: analysis({ isStable: false, changedPointCount: 2, pointScores: second }) })
    const events = tracker.observe({ capturedAt: 500, sourceValid: true, profileValid: true, analysis: analysis() })
    expect(events.find((event) => event.type === 'move-confirmed')).toMatchObject({ move: 'a3a4' })
  })

  it('refuses a dropped endpoint instead of silently confirming', () => {
    const tracker = new BoardTracker(DEFAULT_POSITION, 'red-bottom')
    tracker.observe({ capturedAt: 0, sourceValid: true, profileValid: true, analysis: analysis() })
    const scores = Array(90).fill(0)
    scores[expectedMovePoints('a3a4', 'red-bottom')[0]] = 0.2
    tracker.observe({ capturedAt: 100, sourceValid: true, profileValid: true, analysis: analysis({ isStable: false, changedPointCount: 1, pointScores: scores }) })
    tracker.observe({ capturedAt: 400, sourceValid: true, profileValid: true, analysis: analysis() })
    expect(tracker.snapshot()).toMatchObject({ state: { status: 'MOVE_CANDIDATE' }, confirmedMoveCount: 0 })
  })

  it('refuses ambiguous observations and enters DESYNC after timeout', () => {
    const tracker = new BoardTracker(DEFAULT_POSITION, 'red-bottom', { candidateTimeoutMs: 500 })
    tracker.observe({ capturedAt: 0, sourceValid: true, profileValid: true, analysis: analysis() })
    const scores = Array(90).fill(0)
    for (const move of ['a3a4', 'c3c4']) {
      for (const point of expectedMovePoints(move as `${string}${string}${string}${string}`, 'red-bottom')) scores[point] = 0.2
    }
    tracker.observe({ capturedAt: 100, sourceValid: true, profileValid: true, analysis: analysis({ isStable: false, changedPointCount: 4, pointScores: scores }) })
    tracker.observe({ capturedAt: 400, sourceValid: true, profileValid: true, analysis: analysis() })
    const events = tracker.observe({ capturedAt: 901, sourceValid: true, profileValid: true, analysis: analysis() })
    expect(events).toEqual([expect.objectContaining({ type: 'state', state: expect.objectContaining({ status: 'DESYNC' }) })])
    expect(tracker.snapshot().confirmedMoveCount).toBe(0)
  })

  it('moves to explicit safety states when the source or Profile is invalid', () => {
    const tracker = new BoardTracker(DEFAULT_POSITION, 'red-bottom')
    tracker.observe({ capturedAt: 0, sourceValid: false, profileValid: true, analysis: analysis() })
    expect(tracker.snapshot().state.status).toBe('NO_BOARD')
    tracker.observe({ capturedAt: 1, sourceValid: true, profileValid: false, analysis: analysis() })
    expect(tracker.snapshot().state.status).toBe('CALIBRATING')
  })

  it('supports manual candidate confirmation and undo with a rescan barrier', () => {
    const tracker = new BoardTracker(DEFAULT_POSITION, 'red-bottom')
    tracker.observe({ capturedAt: 0, sourceValid: true, profileValid: true, analysis: analysis() })
    const scores = Array(90).fill(0)
    for (const move of ['a3a4', 'c3c4']) {
      for (const point of expectedMovePoints(move as `${string}${string}${string}${string}`, 'red-bottom')) scores[point] = 0.2
    }
    tracker.observe({ capturedAt: 100, sourceValid: true, profileValid: true, analysis: analysis({ isStable: false, changedPointCount: 4, pointScores: scores }) })
    tracker.observe({ capturedAt: 400, sourceValid: true, profileValid: true, analysis: analysis() })
    const confirmed = tracker.confirmCandidate('a3a4', 450)
    expect(confirmed.find((event) => event.type === 'move-confirmed')).toMatchObject({ move: 'a3a4', confirmation: 'manual' })
    expect(tracker.snapshot().position.moveHistory).toEqual(['a3a4'])
    tracker.undo(500)
    expect(tracker.snapshot()).toMatchObject({ state: { status: 'RESCANNING' }, position: { moveHistory: [] }, confirmedMoveCount: 0 })
  })

  it('records bounded structured observations for diagnostics', () => {
    const tracker = new BoardTracker(DEFAULT_POSITION, 'red-bottom')
    for (let index = 0; index < 300; index += 1) {
      tracker.observe({ capturedAt: index, sourceValid: true, profileValid: true, analysis: analysis() })
    }
    const diagnostics = tracker.diagnostics()
    expect(diagnostics.observations).toHaveLength(256)
    expect(diagnostics.observations.at(-1)).toMatchObject({ capturedAt: 299, stateBefore: 'STABLE', isStable: true })
  })

  it('replays at least 1,000 labelled legal moves without a silent mismatch', () => {
    const labelledCases = ['a3a4', 'c3c4', 'e3e4', 'g3g4', 'i3i4'].map((move) => {
      const game = new RulesAdapter(DEFAULT_POSITION)
      return { move, expectedFen: game.apply(move).fen }
    })
    let confirmedMoves = 0

    for (let index = 0; index < 1_000; index += 1) {
      const { move, expectedFen } = labelledCases[index % labelledCases.length]
      const tracker = new BoardTracker(DEFAULT_POSITION, 'red-bottom')
      tracker.observe({ capturedAt: 0, sourceValid: true, profileValid: true, analysis: analysis() })
      const events = playObservation(tracker, move, 100)
      const confirmed = events.find((event) => event.type === 'move-confirmed')
      expect(confirmed).toMatchObject({ type: 'move-confirmed', move, fen: expectedFen })
      confirmedMoves += confirmed ? 1 : 0
    }

    expect({ labelledMoves: 1_000, confirmedMoves }).toEqual({ labelledMoves: 1_000, confirmedMoves: 1_000 })
  }, 20_000)
})
