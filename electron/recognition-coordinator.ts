import {
  evaluateRecognition,
  fuseProbabilityFrames,
  type RecognitionCorrection,
  type RecognitionEvaluation,
  type RecognitionProbabilityFrame,
} from '../src/domain/recognition'
import type { Orientation, Side } from '../src/domain/position'
import {
  RecognitionWorkerError,
  RecognitionWorkerManager,
  type LoadedRecognitionModelManifest,
  type RecognitionFrameInput,
  type RecognitionInferenceBackend,
} from './recognition-worker'

export type RecognitionState =
  | 'IDLE'
  | 'READY_FOR_SCAN'
  | 'SCANNING'
  | 'READY'
  | 'NEEDS_CORRECTION'
  | 'REJECTED'
  | 'ERROR'
  | 'COMMITTED'

export interface RecognitionScanInput {
  orientation: Orientation
  sideToMove: Side
}

export interface RecognitionAcceptedCandidate {
  fen: string
  orientation: Orientation
  sideToMove: Side
}

export interface RecognitionSnapshot {
  state: RecognitionState
  message: string
  bufferedFrameCount: number
  modelVersion: string | null
  evaluation: RecognitionEvaluation | null
  error: {
    code: string
    retryable: boolean
  } | null
}

export interface RecognitionCoordinatorOptions {
  backend?: RecognitionInferenceBackend
  manifest?: LoadedRecognitionModelManifest
  timeoutMs?: number
}

export class RecognitionCoordinator {
  private readonly worker: RecognitionWorkerManager
  private readonly modelVersion: string | null
  private frames: RecognitionFrameInput[] = []
  private state: RecognitionState = 'IDLE'
  private message = '等待稳定棋盘帧'
  private evaluation: RecognitionEvaluation | null = null
  private error: RecognitionSnapshot['error'] = null
  private probabilities: RecognitionProbabilityFrame | null = null
  private scanInput: RecognitionScanInput | null = null
  private corrections: RecognitionCorrection[] = []
  private generation = 0

  constructor(options: RecognitionCoordinatorOptions) {
    this.worker = new RecognitionWorkerManager(options)
    this.modelVersion = options.manifest?.modelVersion ?? null
  }

  capture(frame: RecognitionFrameInput, eligible: boolean): RecognitionSnapshot {
    if (!eligible || this.state === 'SCANNING') return this.snapshot()
    this.frames.push({
      ...frame,
      pixels: new Uint8Array(frame.pixels),
      topLeft: { ...frame.topLeft },
      bottomRight: { ...frame.bottomRight },
    })
    if (this.frames.length > 2) this.frames.shift()
    if (this.frames.length >= 1 && ['IDLE', 'READY_FOR_SCAN', 'COMMITTED'].includes(this.state)) {
      this.state = 'READY_FOR_SCAN'
      this.message = this.frames.length >= 2 ? '已缓存两张稳定帧，可开始完整识别' : '已缓存稳定帧，等待第二帧以提高可靠性'
      this.error = null
    }
    return this.snapshot()
  }

  async scan(input: RecognitionScanInput): Promise<RecognitionSnapshot> {
    if (this.state === 'SCANNING') throw new Error('Recognition scan is already in progress')
    if (this.frames.length < 1) {
      this.state = 'ERROR'
      this.message = '没有可用于完整识别的稳定棋盘帧'
      this.error = { code: 'NO_STABLE_FRAME', retryable: true }
      return this.snapshot()
    }

    this.state = 'SCANNING'
    this.message = '正在进行完整棋盘识别'
    this.error = null
    this.evaluation = null
    this.probabilities = null
    this.scanInput = { ...input }
    this.corrections = []
    const scanGeneration = this.generation
    try {
      const frames = this.frames.slice(-2)
      const outputs = await Promise.all(frames.map((frame) => this.worker.infer(frame)))
      if (scanGeneration !== this.generation) return this.snapshot()
      this.probabilities = fuseProbabilityFrames(outputs)
      this.evaluation = evaluateRecognition({
        probabilities: this.probabilities,
        orientation: input.orientation,
        sideToMove: input.sideToMove,
      })
      this.applyEvaluationState()
    } catch (error) {
      if (scanGeneration !== this.generation) return this.snapshot()
      this.state = 'ERROR'
      this.evaluation = null
      this.probabilities = null
      if (error instanceof RecognitionWorkerError) {
        this.message = error.message
        this.error = { code: error.code, retryable: error.retryable }
      } else {
        this.message = error instanceof Error ? error.message : '完整棋盘识别失败'
        this.error = { code: 'INFERENCE_FAILED', retryable: true }
      }
    }
    return this.snapshot()
  }

  correct(corrections: RecognitionCorrection[]): RecognitionSnapshot {
    if (!this.probabilities || !this.scanInput) throw new Error('No recognition result is available for correction')
    const mergedCorrections = new Map(this.corrections.map((item) => [item.point, { ...item }]))
    for (const correction of corrections) mergedCorrections.set(correction.point, { ...correction })
    this.corrections = [...mergedCorrections.values()].sort((left, right) => left.point - right.point)
    this.evaluation = evaluateRecognition({
      probabilities: this.probabilities,
      orientation: this.scanInput.orientation,
      sideToMove: this.scanInput.sideToMove,
      corrections: this.corrections,
    })
    this.error = null
    this.applyEvaluationState()
    return this.snapshot()
  }

  accept(fen: string): RecognitionAcceptedCandidate {
    if (!this.evaluation || !this.scanInput) throw new Error('No recognition candidate is ready to commit')
    if (this.evaluation.status !== 'READY') throw new Error('Recognition candidate still requires correction')
    const candidate = this.evaluation.candidates.find((item) => item.fen === fen)
    if (!candidate) throw new Error('FEN is not the accepted recognition candidate')
    return {
      fen: candidate.fen,
      orientation: this.scanInput.orientation,
      sideToMove: this.scanInput.sideToMove,
    }
  }

  markCommitted(): RecognitionSnapshot {
    if (this.state !== 'READY') throw new Error('Recognition candidate is not ready to commit')
    this.clearBufferedRecognition()
    this.state = 'COMMITTED'
    this.message = '识别局面已原子提交，等待新的稳定图像基线'
    this.error = null
    return this.snapshot()
  }

  reset(): RecognitionSnapshot {
    this.clearBufferedRecognition()
    this.state = 'IDLE'
    this.message = this.frames.length > 0 ? '已有稳定帧，可重新识别' : '等待稳定棋盘帧'
    return this.snapshot()
  }

  snapshot(): RecognitionSnapshot {
    return {
      state: this.state,
      message: this.message,
      bufferedFrameCount: this.frames.length,
      modelVersion: this.modelVersion,
      evaluation: this.evaluation ? structuredClone(this.evaluation) : null,
      error: this.error ? { ...this.error } : null,
    }
  }

  async dispose(): Promise<void> {
    await this.worker.dispose()
  }

  private applyEvaluationState(): void {
    if (!this.evaluation) return
    if (this.evaluation.status === 'READY') {
      this.state = 'READY'
      this.message = '识别到唯一高置信度合法局面，可安全提交'
    } else if (this.evaluation.status === 'NEEDS_CORRECTION') {
      this.state = 'NEEDS_CORRECTION'
      this.message = '识别结果存在低置信度或多个合法候选，需要人工修正'
    } else {
      this.state = 'REJECTED'
      this.message = this.evaluation.issues[0] ?? '识别结果未通过规则校验'
    }
  }

  private clearBufferedRecognition(): void {
    this.generation += 1
    this.frames = []
    this.evaluation = null
    this.probabilities = null
    this.scanInput = null
    this.corrections = []
    this.error = null
  }
}
