import { describe, expect, it, vi } from 'vitest'
import { parseFen } from '../src/domain/position'
import { RECOGNITION_CLASSES, type RecognitionClass, type RecognitionProbabilityFrame } from '../src/domain/recognition'
import { RecognitionCoordinator } from './recognition-coordinator'
import type { RecognitionInferenceBackend } from './recognition-worker'

const START_FEN = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1'

function expand(fen: string): RecognitionClass[] {
  return parseFen(fen).board.split('/').flatMap((rank) => {
    const result: RecognitionClass[] = []
    for (const character of rank) {
      if (/\d/.test(character)) result.push(...Array<RecognitionClass>(Number(character)).fill('_'))
      else result.push(character as RecognitionClass)
    }
    return result
  })
}

function probabilities(labels = expand(START_FEN), confidence = 0.9995): RecognitionProbabilityFrame {
  return labels.map((label) => {
    const row = Array<number>(RECOGNITION_CLASSES.length).fill((1 - confidence) / (RECOGNITION_CLASSES.length - 1))
    row[RECOGNITION_CLASSES.indexOf(label)] = confidence
    return row
  })
}

function frame(seed: number) {
  const pixels = new Uint8Array(40 * 44 * 4).fill(seed)
  return {
    pixels,
    width: 40,
    height: 44,
    topLeft: { x: 4, y: 4 },
    bottomRight: { x: 36, y: 40 },
    roiScale: 0.6,
  }
}

class FakeBackend implements RecognitionInferenceBackend {
  readonly calls: number[] = []
  constructor(private readonly outputs: RecognitionProbabilityFrame[]) {}
  async infer(input: ReturnType<typeof frame>): Promise<number[][]> {
    this.calls.push(input.pixels[0])
    const output = this.outputs[Math.min(this.calls.length - 1, this.outputs.length - 1)]
    return output.map((row) => row.map((value) => Math.log(value)))
  }
  async dispose() {}
}

describe('RecognitionCoordinator', () => {
  it('keeps only the latest two eligible stable frames and fuses them', async () => {
    const backend = new FakeBackend([probabilities(), probabilities()])
    const coordinator = new RecognitionCoordinator({ backend, timeoutMs: 200 })
    coordinator.capture(frame(10), true)
    coordinator.capture(frame(20), false)
    coordinator.capture(frame(30), true)
    coordinator.capture(frame(40), true)

    const snapshot = await coordinator.scan({ orientation: 'red-bottom', sideToMove: 'red' })
    expect(backend.calls).toEqual([30, 40])
    expect(snapshot.state).toBe('READY')
    expect(snapshot.evaluation?.candidates[0].fen).toBe(START_FEN)
  })

  it('does not accept a candidate before a scan succeeds', () => {
    const coordinator = new RecognitionCoordinator({ backend: new FakeBackend([probabilities()]), timeoutMs: 200 })
    expect(() => coordinator.accept(START_FEN)).toThrow('No recognition candidate is ready to commit')
  })

  it('returns a validated candidate from accept without mutating realtime state itself', async () => {
    const coordinator = new RecognitionCoordinator({ backend: new FakeBackend([probabilities(), probabilities()]), timeoutMs: 200 })
    coordinator.capture(frame(1), true)
    coordinator.capture(frame(2), true)
    await coordinator.scan({ orientation: 'red-bottom', sideToMove: 'red' })

    const accepted = coordinator.accept(START_FEN)
    expect(accepted).toMatchObject({ fen: START_FEN, orientation: 'red-bottom', sideToMove: 'red' })
    expect(coordinator.snapshot().state).toBe('READY')
    expect(coordinator.markCommitted().state).toBe('COMMITTED')
  })

  it('clears the frame generation when a candidate is committed', async () => {
    const backend = new FakeBackend([probabilities(), probabilities()])
    const coordinator = new RecognitionCoordinator({ backend, timeoutMs: 200 })
    coordinator.capture(frame(1), true)
    coordinator.capture(frame(2), true)
    await coordinator.scan({ orientation: 'red-bottom', sideToMove: 'red' })

    expect(coordinator.markCommitted()).toMatchObject({ state: 'COMMITTED', bufferedFrameCount: 0 })

    coordinator.capture(frame(3), true)
    expect(coordinator.snapshot()).toMatchObject({ state: 'READY_FOR_SCAN', bufferedFrameCount: 1 })
    await coordinator.dispose()
  })

  it('clears buffered frames and ignores an in-flight scan after reset', async () => {
    let resolveInference: ((rows: number[][]) => void) | undefined
    const output = probabilities().map((row) => row.map((value) => Math.log(value)))
    const backend: RecognitionInferenceBackend = {
      infer: vi.fn(() => new Promise<number[][]>((resolve) => {
        resolveInference = resolve
      })),
      dispose: vi.fn(async () => undefined),
    }
    const coordinator = new RecognitionCoordinator({ backend, timeoutMs: 200 })
    coordinator.capture(frame(1), true)

    const scan = coordinator.scan({ orientation: 'red-bottom', sideToMove: 'red' })
    expect(coordinator.snapshot().state).toBe('SCANNING')
    expect(coordinator.reset()).toMatchObject({ state: 'IDLE', bufferedFrameCount: 0 })

    resolveInference?.(output)
    const staleResult = await scan
    expect(staleResult).toMatchObject({ state: 'IDLE', bufferedFrameCount: 0, evaluation: null, error: null })
    expect(coordinator.snapshot()).toMatchObject({ state: 'IDLE', bufferedFrameCount: 0, evaluation: null })
    await coordinator.dispose()
  })

  it('requires correction when confidence is below the automatic gate', async () => {
    const low = probabilities(expand(START_FEN), 0.86)
    const coordinator = new RecognitionCoordinator({ backend: new FakeBackend([low, low]), timeoutMs: 200 })
    coordinator.capture(frame(1), true)
    coordinator.capture(frame(2), true)
    const snapshot = await coordinator.scan({ orientation: 'red-bottom', sideToMove: 'red' })
    expect(snapshot.state).toBe('NEEDS_CORRECTION')
    expect(() => coordinator.accept(snapshot.evaluation!.candidates[0].fen)).toThrow('Recognition candidate still requires correction')
  })

  it('re-evaluates the same fused probabilities after user corrections', async () => {
    const wrong = expand(START_FEN)
    wrong[0] = '_'
    const uncertain = probabilities(wrong, 0.9995)
    const rookIndex = RECOGNITION_CLASSES.indexOf('r')
    const emptyIndex = RECOGNITION_CLASSES.indexOf('_')
    uncertain[0] = Array<number>(15).fill(0.000001)
    uncertain[0][emptyIndex] = 0.55
    uncertain[0][rookIndex] = 0.449986

    const coordinator = new RecognitionCoordinator({ backend: new FakeBackend([uncertain, uncertain]), timeoutMs: 200 })
    coordinator.capture(frame(1), true)
    coordinator.capture(frame(2), true)
    expect((await coordinator.scan({ orientation: 'red-bottom', sideToMove: 'red' })).state).toBe('NEEDS_CORRECTION')
    const corrected = coordinator.correct([{ point: 0, label: 'r' }])
    expect(corrected.state).toBe('READY')
    expect(corrected.evaluation?.candidates[0].fen).toBe(START_FEN)
  })
})
