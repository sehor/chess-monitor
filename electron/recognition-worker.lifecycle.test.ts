import { Worker } from 'node:worker_threads'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { RECOGNITION_CLASSES } from '../src/domain/recognition'
import { RecognitionWorkerManager, type LoadedRecognitionModelManifest, type RecognitionFrameInput } from './recognition-worker'

type WorkerCallback = (...args: unknown[]) => void
const handlers = new Map<Worker, Map<string, WorkerCallback>>()
const onSpy = vi.spyOn(Worker.prototype, 'on').mockImplementation(function (this: Worker, event: string | symbol, listener: (...args: any[]) => void) {
  const workerHandlers = handlers.get(this) ?? new Map<string, WorkerCallback>()
  workerHandlers.set(String(event), listener as WorkerCallback)
  handlers.set(this, workerHandlers)
  return this
})
const postMessageSpy = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(() => undefined)

afterEach(() => {
  for (const worker of handlers.keys()) {
    worker.unref()
    void worker.terminate()
  }
  handlers.clear()
})

afterAll(() => {
  onSpy.mockRestore()
  postMessageSpy.mockRestore()
})

const manifest: LoadedRecognitionModelManifest = {
  schemaVersion: 1,
  modelVersion: 'test-v1',
  modelFile: 'pieces.onnx',
  modelSha256: '0'.repeat(64),
  classes: [...RECOGNITION_CLASSES],
  input: {
    width: 32,
    height: 32,
    channels: 3,
    layout: 'NCHW',
    colorSpace: 'RGB',
    scale: 1 / 255,
    mean: [0, 0, 0],
    std: [1, 1, 1],
  },
  manifestPath: 'manifest.json',
  modelPath: 'pieces.onnx',
}

function frame(): RecognitionFrameInput {
  return {
    pixels: new Uint8Array(40 * 44 * 4).fill(120),
    width: 40,
    height: 44,
    topLeft: { x: 4, y: 4 },
    bottomRight: { x: 36, y: 40 },
    roiScale: 0.6,
  }
}

function validRows(): number[][] {
  return Array.from({ length: 90 }, () => Array<number>(RECOGNITION_CLASSES.length).fill(0))
}

function handler(worker: Worker, event: string): WorkerCallback {
  const callback = handlers.get(worker)?.get(event)
  if (!callback) throw new Error(`No ${event} handler registered for worker`)
  return callback
}

describe('Inline recognition worker lifecycle', () => {
  it('disposes a timed-out worker and uses a fresh worker for the next request', async () => {
    const terminateSpy = vi.spyOn(Worker.prototype, 'terminate')
    const manager = new RecognitionWorkerManager({ manifest, timeoutMs: 20 })

    await expect(manager.infer(frame())).rejects.toMatchObject({ code: 'WORKER_TIMEOUT' })
    const [workerA] = [...handlers.keys()]
    expect(workerA).toBeDefined()
    expect(terminateSpy).toHaveBeenCalled()

    const second = manager.infer(frame())
    const workers = [...handlers.keys()]
    const workerB = workers.find((worker) => worker !== workerA)
    expect(workerB).toBeDefined()
    handler(workerB!, 'message')({ id: 2, ok: true, rows: validRows() })

    await expect(second).resolves.toHaveLength(90)
    terminateSpy.mockRestore()
  })

  it('does not let a delayed exit from worker A reject worker B pending inference', async () => {
    const manager = new RecognitionWorkerManager({ manifest, timeoutMs: 200 })
    const first = manager.infer(frame())
    const workerA = [...handlers.keys()][0]
    handler(workerA, 'error')(new Error('worker A failed'))
    await expect(first).rejects.toMatchObject({ code: 'WORKER_CRASHED' })

    const second = manager.infer(frame())
    const workerB = [...handlers.keys()].find((worker) => worker !== workerA)
    expect(workerB).toBeDefined()

    handler(workerA, 'exit')(1)
    handler(workerB!, 'message')({ id: 2, ok: true, rows: validRows() })

    await expect(second).resolves.toHaveLength(90)
  })
})

void onSpy
void postMessageSpy
