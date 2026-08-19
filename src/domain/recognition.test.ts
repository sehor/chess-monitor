import { describe, expect, it } from 'vitest'
import { parseFen, type Orientation, type Side } from './position'
import {
  RECOGNITION_CLASSES,
  evaluateRecognition,
  fuseProbabilityFrames,
  type RecognitionClass,
  type RecognitionProbabilityFrame,
} from './recognition'

const START_FEN = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1'

function expandBoard(fen: string): RecognitionClass[] {
  const { board } = parseFen(fen)
  return board.split('/').flatMap((rank) => {
    const cells: RecognitionClass[] = []
    for (const token of rank) {
      if (/^[1-9]$/.test(token)) cells.push(...Array<RecognitionClass>(Number(token)).fill('_'))
      else cells.push(token as RecognitionClass)
    }
    return cells
  })
}

function toScreenLabels(fen: string, orientation: Orientation): RecognitionClass[] {
  const logical = expandBoard(fen)
  if (orientation === 'red-bottom') return logical
  return Array.from({ length: 90 }, (_, screenPoint) => {
    const screenRow = Math.floor(screenPoint / 9)
    const screenFile = screenPoint % 9
    const logicalRow = 9 - screenRow
    const logicalFile = 8 - screenFile
    return logical[logicalRow * 9 + logicalFile]
  })
}

function probabilitiesFor(
  fen: string,
  orientation: Orientation,
  confidence = 0.999,
): RecognitionProbabilityFrame {
  const labels = toScreenLabels(fen, orientation)
  return labels.map((label) => {
    const row = Array<number>(RECOGNITION_CLASSES.length).fill((1 - confidence) / (RECOGNITION_CLASSES.length - 1))
    row[RECOGNITION_CLASSES.indexOf(label)] = confidence
    return row
  })
}

function withAmbiguousPoint(
  frame: RecognitionProbabilityFrame,
  point: number,
  first: RecognitionClass,
  second: RecognitionClass,
): RecognitionProbabilityFrame {
  return frame.map((row, index) => {
    if (index !== point) return [...row]
    const next = Array<number>(RECOGNITION_CLASSES.length).fill(0.001 / (RECOGNITION_CLASSES.length - 2))
    next[RECOGNITION_CLASSES.indexOf(first)] = 0.51
    next[RECOGNITION_CLASSES.indexOf(second)] = 0.489
    return next
  })
}

function evaluate(
  frame: RecognitionProbabilityFrame,
  orientation: Orientation = 'red-bottom',
  sideToMove: Side = 'red',
) {
  return evaluateRecognition({
    probabilities: frame,
    orientation,
    sideToMove,
    options: {
      pointConfidenceThreshold: 0.9,
      boardConfidenceThreshold: 0.98,
      alternativeProbabilityFloor: 0.05,
      alternativeRatio: 0.2,
      maxAmbiguousPoints: 8,
      maxCandidates: 64,
    },
  })
}

describe('recognition domain', () => {
  it.each(['red-bottom', 'black-bottom'] as const)(
    'reconstructs the same logical FEN from %s screen orientation',
    (orientation) => {
      const result = evaluate(probabilitiesFor(START_FEN, orientation), orientation)

      expect(result.status).toBe('READY')
      expect(result.candidates).toHaveLength(1)
      expect(result.candidates[0].fen).toBe(START_FEN)
      expect(result.lowConfidencePoints).toEqual([])
      expect(result.candidates[0].minimumConfidence).toBeGreaterThan(0.99)
    },
  )

  it('fuses two frames by averaging per-class probabilities', () => {
    const first = probabilitiesFor(START_FEN, 'red-bottom', 0.99)
    const second = probabilitiesFor(START_FEN, 'red-bottom', 0.97)
    const fused = fuseProbabilityFrames([first, second])
    const rookIndex = RECOGNITION_CLASSES.indexOf('r')

    expect(fused).toHaveLength(90)
    expect(fused[0][rookIndex]).toBeCloseTo(0.98, 8)
    expect(fused[0].reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 8)
  })

  it('refuses to auto-accept when one point has two plausible legal labels', () => {
    const base = probabilitiesFor(START_FEN, 'red-bottom')
    const ambiguous = withAmbiguousPoint(base, 0, 'r', '_')
    const result = evaluate(ambiguous)

    expect(result.status).toBe('NEEDS_CORRECTION')
    expect(result.lowConfidencePoints).toContain(0)
    expect(result.candidates.length).toBeGreaterThan(1)
  })

  it('uses an explicit point correction to resolve an ambiguous proposal', () => {
    const ambiguous = withAmbiguousPoint(probabilitiesFor(START_FEN, 'red-bottom'), 0, 'r', '_')
    const result = evaluateRecognition({
      probabilities: ambiguous,
      orientation: 'red-bottom',
      sideToMove: 'red',
      corrections: [{ point: 0, label: 'r' }],
      options: {
        pointConfidenceThreshold: 0.9,
        boardConfidenceThreshold: 0.98,
        alternativeProbabilityFloor: 0.05,
        alternativeRatio: 0.2,
        maxAmbiguousPoints: 8,
        maxCandidates: 64,
      },
    })

    expect(result.status).toBe('READY')
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0].fen).toBe(START_FEN)
  })

  it('rejects impossible piece counts instead of silently selecting the top labels', () => {
    const frame = probabilitiesFor(START_FEN, 'red-bottom')
    const emptyPoint = toScreenLabels(START_FEN, 'red-bottom').findIndex((label) => label === '_')
    const impossible = frame.map((row, point) => {
      if (point !== emptyPoint) return [...row]
      const next = Array<number>(RECOGNITION_CLASSES.length).fill(0.00001)
      next[RECOGNITION_CLASSES.indexOf('R')] = 0.99986
      return next
    })
    const result = evaluate(impossible)

    expect(result.status).toBe('REJECTED')
    expect(result.candidates).toEqual([])
    expect(result.issues.some((issue) => issue.includes('棋子数量') || issue.includes('合法候选'))).toBe(true)
  })

  it('preserves side-to-move in the reconstructed FEN', () => {
    const result = evaluate(probabilitiesFor(START_FEN, 'red-bottom'), 'red-bottom', 'black')

    expect(result.status).toBe('READY')
    expect(result.candidates[0].fen).toContain(' b - - 0 1')
  })
})
