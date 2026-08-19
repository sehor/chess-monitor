import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize } from 'node:path'
import { Worker } from 'node:worker_threads'
import { RECOGNITION_CLASSES, type RecognitionProbabilityFrame } from '../src/domain/recognition'

export type RecognitionWorkerErrorCode =
  | 'MODEL_MISSING'
  | 'MODEL_HASH_MISMATCH'
  | 'MODEL_MANIFEST_INVALID'
  | 'CLASS_MAPPING_MISMATCH'
  | 'RUNTIME_MISSING'
  | 'WORKER_TIMEOUT'
  | 'WORKER_CRASHED'
  | 'INFERENCE_FAILED'
  | 'INVALID_OUTPUT'

export class RecognitionWorkerError extends Error {
  readonly name = 'RecognitionWorkerError'

  constructor(
    readonly code: RecognitionWorkerErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message)
  }
}

export interface RecognitionModelManifest {
  schemaVersion: 1
  modelVersion: string
  modelFile: string
  modelSha256: string
  classes: string[]
  input: {
    width: number
    height: number
    channels: 3
    layout: 'NCHW'
    colorSpace: 'RGB'
    scale: number
    mean: [number, number, number]
    std: [number, number, number]
  }
}

export interface LoadedRecognitionModelManifest extends RecognitionModelManifest {
  manifestPath: string
  modelPath: string
}

export interface RecognitionFrameInput {
  pixels: Uint8Array | Uint8ClampedArray
  width: number
  height: number
  topLeft: { x: number; y: number }
  bottomRight: { x: number; y: number }
  roiScale?: number
}

export interface RecognitionInferenceBackend {
  infer(frame: RecognitionFrameInput): Promise<number[][]>
  dispose(): Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function manifestError(message: string): RecognitionWorkerError {
  return new RecognitionWorkerError('MODEL_MANIFEST_INVALID', message, false)
}

function parseManifest(value: unknown): RecognitionModelManifest {
  if (!isRecord(value) || value.schemaVersion !== 1) throw manifestError('Recognition manifest schema version is unsupported')
  const input = value.input
  if (
    typeof value.modelVersion !== 'string' || value.modelVersion.length < 1 || value.modelVersion.length > 128 ||
    typeof value.modelFile !== 'string' || value.modelFile.length < 1 || value.modelFile.length > 255 ||
    isAbsolute(value.modelFile) || normalize(value.modelFile).startsWith('..') ||
    typeof value.modelSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(value.modelSha256) ||
    !Array.isArray(value.classes) || !value.classes.every((item) => typeof item === 'string') ||
    !isRecord(input) ||
    !Number.isInteger(input.width) || (input.width as number) < 8 || (input.width as number) > 512 ||
    !Number.isInteger(input.height) || (input.height as number) < 8 || (input.height as number) > 512 ||
    input.channels !== 3 || input.layout !== 'NCHW' || input.colorSpace !== 'RGB' ||
    typeof input.scale !== 'number' || !Number.isFinite(input.scale) || input.scale <= 0 || input.scale > 1 ||
    !Array.isArray(input.mean) || input.mean.length !== 3 || input.mean.some((item) => typeof item !== 'number' || !Number.isFinite(item)) ||
    !Array.isArray(input.std) || input.std.length !== 3 || input.std.some((item) => typeof item !== 'number' || !Number.isFinite(item) || item === 0)
  ) {
    throw manifestError('Recognition manifest fields are invalid')
  }
  if (value.classes.length !== RECOGNITION_CLASSES.length || value.classes.some((label, index) => label !== RECOGNITION_CLASSES[index])) {
    throw new RecognitionWorkerError(
      'CLASS_MAPPING_MISMATCH',
      'Recognition model class mapping does not match the application mapping',
      false,
    )
  }
  return {
    schemaVersion: 1,
    modelVersion: value.modelVersion,
    modelFile: value.modelFile,
    modelSha256: value.modelSha256.toLowerCase(),
    classes: [...value.classes],
    input: {
      width: input.width as number,
      height: input.height as number,
      channels: 3,
      layout: 'NCHW',
      colorSpace: 'RGB',
      scale: input.scale,
      mean: [...input.mean] as [number, number, number],
      std: [...input.std] as [number, number, number],
    },
  }
}

export async function loadRecognitionManifest(manifestPath: string): Promise<LoadedRecognitionModelManifest> {
  let raw: string
  try {
    raw = await readFile(manifestPath, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    throw new RecognitionWorkerError(
      'MODEL_MISSING',
      code === 'ENOENT' ? 'Recognition model manifest is missing' : 'Recognition model manifest cannot be read',
      code !== 'ENOENT',
    )
  }

  let manifest: RecognitionModelManifest
  try {
    manifest = parseManifest(JSON.parse(raw))
  } catch (error) {
    if (error instanceof RecognitionWorkerError) throw error
    throw manifestError('Recognition model manifest is not valid JSON')
  }

  const modelPath = join(dirname(manifestPath), manifest.modelFile)
  let modelBytes: Uint8Array
  try {
    modelBytes = await readFile(modelPath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    throw new RecognitionWorkerError(
      'MODEL_MISSING',
      code === 'ENOENT' ? 'Recognition ONNX model is missing' : 'Recognition ONNX model cannot be read',
      code !== 'ENOENT',
    )
  }
  const actualSha256 = createHash('sha256').update(modelBytes).digest('hex')
  if (actualSha256 !== manifest.modelSha256) {
    throw new RecognitionWorkerError(
      'MODEL_HASH_MISMATCH',
      'Recognition ONNX model hash does not match its manifest',
      false,
    )
  }
  return { ...manifest, manifestPath, modelPath }
}

function validateFrame(frame: RecognitionFrameInput): void {
  if (
    !Number.isInteger(frame.width) || !Number.isInteger(frame.height) ||
    frame.width < 5 || frame.height < 5 || frame.width > 2048 || frame.height > 2048 ||
    frame.pixels.byteLength !== frame.width * frame.height * 4 ||
    !Number.isFinite(frame.topLeft.x) || !Number.isFinite(frame.topLeft.y) ||
    !Number.isFinite(frame.bottomRight.x) || !Number.isFinite(frame.bottomRight.y) ||
    frame.topLeft.x >= frame.bottomRight.x || frame.topLeft.y >= frame.bottomRight.y ||
    frame.topLeft.x < 0 || frame.topLeft.y < 0 ||
    frame.bottomRight.x > frame.width || frame.bottomRight.y > frame.height ||
    (frame.roiScale !== undefined && (!Number.isFinite(frame.roiScale) || frame.roiScale < 0.4 || frame.roiScale > 0.8))
  ) {
    throw new RecognitionWorkerError('INFERENCE_FAILED', 'Recognition frame is invalid', false)
  }
}

function softmaxRows(rows: number[][]): RecognitionProbabilityFrame {
  if (!Array.isArray(rows) || rows.length !== 90) {
    throw new RecognitionWorkerError('INVALID_OUTPUT', 'Recognition worker must return 90 output rows', true)
  }
  return rows.map((row) => {
    if (
      !Array.isArray(row) || row.length !== RECOGNITION_CLASSES.length ||
      row.some((value) => !Number.isFinite(value))
    ) {
      throw new RecognitionWorkerError('INVALID_OUTPUT', 'Recognition worker returned an invalid class vector', true)
    }
    const maximum = Math.max(...row)
    const exponentials = row.map((value) => Math.exp(value - maximum))
    const total = exponentials.reduce((sum, value) => sum + value, 0)
    if (!Number.isFinite(total) || total <= 0) {
      throw new RecognitionWorkerError('INVALID_OUTPUT', 'Recognition worker output cannot be normalized', true)
    }
    return exponentials.map((value) => value / total)
  })
}

const INLINE_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
let ortPromise;
let sessionPromise;

function send(id, ok, payload) { parentPort.postMessage({ id, ok, ...payload }); }
function clamp(value, minimum, maximum) { return Math.max(minimum, Math.min(maximum, value)); }
function sample(frame, sourceX, sourceY, channel) {
  const x = clamp(Math.round(sourceX), 0, frame.width - 1);
  const y = clamp(Math.round(sourceY), 0, frame.height - 1);
  return frame.pixels[(y * frame.width + x) * 4 + channel];
}
function preprocess(frame, manifest) {
  const pointSpacingX = (frame.bottomRight.x - frame.topLeft.x) / 8;
  const pointSpacingY = (frame.bottomRight.y - frame.topLeft.y) / 9;
  const radiusX = pointSpacingX * (frame.roiScale || 0.6) / 2;
  const radiusY = pointSpacingY * (frame.roiScale || 0.6) / 2;
  const width = manifest.input.width;
  const height = manifest.input.height;
  const plane = width * height;
  const tensor = new Float32Array(90 * 3 * plane);
  for (let point = 0; point < 90; point += 1) {
    const row = Math.floor(point / 9);
    const file = point % 9;
    const centerX = frame.topLeft.x + file * pointSpacingX;
    const centerY = frame.topLeft.y + row * pointSpacingY;
    for (let targetY = 0; targetY < height; targetY += 1) {
      const sourceY = centerY - radiusY + ((targetY + 0.5) / height) * radiusY * 2;
      for (let targetX = 0; targetX < width; targetX += 1) {
        const sourceX = centerX - radiusX + ((targetX + 0.5) / width) * radiusX * 2;
        const targetIndex = targetY * width + targetX;
        for (let channel = 0; channel < 3; channel += 1) {
          const raw = sample(frame, sourceX, sourceY, channel);
          tensor[point * 3 * plane + channel * plane + targetIndex] =
            (raw * manifest.input.scale - manifest.input.mean[channel]) / manifest.input.std[channel];
        }
      }
    }
  }
  return tensor;
}
async function ort() {
  if (!ortPromise) ortPromise = import('onnxruntime-node');
  return ortPromise;
}
async function session() {
  if (!sessionPromise) sessionPromise = ort().then((runtime) => runtime.InferenceSession.create(workerData.modelPath, {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all',
  }));
  return sessionPromise;
}
parentPort.on('message', async (message) => {
  const { id, frame } = message;
  try {
    const runtime = await ort();
    const activeSession = await session();
    const inputName = activeSession.inputNames[0];
    const values = preprocess(frame, workerData.manifest);
    const input = new runtime.Tensor('float32', values, [90, 3, workerData.manifest.input.height, workerData.manifest.input.width]);
    const result = await activeSession.run({ [inputName]: input });
    const outputName = activeSession.outputNames[0];
    const output = result[outputName];
    const dimensions = output.dims.map(Number);
    if (dimensions.length !== 2 || dimensions[0] !== 90 || dimensions[1] !== workerData.manifest.classes.length) {
      throw Object.assign(new Error('Unexpected recognition model output dimensions: ' + dimensions.join('x')), { code: 'INVALID_OUTPUT' });
    }
    const raw = Array.from(output.data, Number);
    const rows = Array.from({ length: 90 }, (_, point) => raw.slice(point * 15, (point + 1) * 15));
    send(id, true, { rows });
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    const runtimeMissing = /onnxruntime-node|Cannot find package|Cannot find module/.test(messageText);
    send(id, false, {
      error: {
        code: runtimeMissing ? 'RUNTIME_MISSING' : (error && error.code === 'INVALID_OUTPUT' ? 'INVALID_OUTPUT' : 'INFERENCE_FAILED'),
        message: runtimeMissing ? 'onnxruntime-node is not installed' : messageText,
      },
    });
  }
});
`

class InlineOnnxWorkerBackend implements RecognitionInferenceBackend {
  private worker: Worker | undefined
  private sequence = 0
  private readonly pending = new Map<number, {
    resolve: (rows: number[][]) => void
    reject: (error: Error) => void
  }>()

  constructor(private readonly manifest: LoadedRecognitionModelManifest) {}

  async infer(frame: RecognitionFrameInput): Promise<number[][]> {
    validateFrame(frame)
    const worker = this.ensureWorker()
    const id = ++this.sequence
    const pixels = new Uint8Array(frame.pixels)
    return new Promise<number[][]>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      worker.postMessage({
        id,
        frame: {
          ...frame,
          pixels,
        },
      }, [pixels.buffer])
    })
  }

  async dispose(): Promise<void> {
    const worker = this.worker
    this.worker = undefined
    if (worker) await worker.terminate()
    const error = new RecognitionWorkerError('WORKER_CRASHED', 'Recognition worker was disposed', true)
    for (const item of this.pending.values()) item.reject(error)
    this.pending.clear()
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    const worker = new Worker(INLINE_WORKER_SOURCE, {
      eval: true,
      workerData: {
        modelPath: this.manifest.modelPath,
        manifest: this.manifest,
      },
    })
    worker.on('message', (message: unknown) => this.handleMessage(message))
    worker.on('error', (error) => this.handleCrash(error))
    worker.on('exit', (code) => {
      if (this.worker === worker) this.worker = undefined
      if (code !== 0 && this.pending.size > 0) {
        this.handleCrash(new Error(`Recognition worker exited with code ${code}`))
      }
    })
    this.worker = worker
    return worker
  }

  private handleMessage(message: unknown): void {
    if (!isRecord(message) || !Number.isInteger(message.id)) return
    const item = this.pending.get(message.id as number)
    if (!item) return
    this.pending.delete(message.id as number)
    if (message.ok === true && Array.isArray(message.rows)) {
      item.resolve(message.rows as number[][])
      return
    }
    const error = isRecord(message.error) ? message.error : {}
    const code = typeof error.code === 'string' ? error.code : 'INFERENCE_FAILED'
    const normalizedCode: RecognitionWorkerErrorCode = [
      'RUNTIME_MISSING', 'INFERENCE_FAILED', 'INVALID_OUTPUT',
    ].includes(code) ? code as RecognitionWorkerErrorCode : 'INFERENCE_FAILED'
    item.reject(new RecognitionWorkerError(
      normalizedCode,
      typeof error.message === 'string' ? error.message : 'Recognition inference failed',
      normalizedCode !== 'RUNTIME_MISSING',
    ))
  }

  private handleCrash(error: Error): void {
    this.worker = undefined
    const wrapped = new RecognitionWorkerError('WORKER_CRASHED', error.message || 'Recognition worker crashed', true)
    for (const item of this.pending.values()) item.reject(wrapped)
    this.pending.clear()
  }
}

export interface RecognitionWorkerManagerOptions {
  backend?: RecognitionInferenceBackend
  manifest?: LoadedRecognitionModelManifest
  timeoutMs?: number
}

export class RecognitionWorkerManager {
  private readonly backend: RecognitionInferenceBackend
  private readonly timeoutMs: number

  constructor(options: RecognitionWorkerManagerOptions) {
    if (!options.backend && !options.manifest) {
      throw new Error('Recognition worker requires either a backend or a loaded model manifest')
    }
    this.backend = options.backend ?? new InlineOnnxWorkerBackend(options.manifest!)
    this.timeoutMs = options.timeoutMs ?? 1_500
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 10 || this.timeoutMs > 30_000) {
      throw new Error('Recognition worker timeout is invalid')
    }
  }

  async infer(frame: RecognitionFrameInput): Promise<RecognitionProbabilityFrame> {
    validateFrame(frame)
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const rows = await Promise.race([
        this.backend.infer(frame),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new RecognitionWorkerError(
            'WORKER_TIMEOUT',
            'Recognition worker timed out',
            true,
          )), this.timeoutMs)
        }),
      ])
      return softmaxRows(rows)
    } catch (error) {
      if (error instanceof RecognitionWorkerError) throw error
      throw new RecognitionWorkerError(
        'WORKER_CRASHED',
        error instanceof Error ? error.message : 'Recognition worker crashed',
        true,
      )
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }

  async dispose(): Promise<void> {
    await this.backend.dispose()
  }
}
