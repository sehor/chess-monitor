import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  RecognitionWorkerError,
  RecognitionWorkerManager,
  loadRecognitionManifest,
  type RecognitionInferenceBackend,
} from './recognition-worker'
import { RECOGNITION_CLASSES } from '../src/domain/recognition'

async function fixtureDirectory(): Promise<string> {
  const directory = join(tmpdir(), `chess-monitor-recognition-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  await mkdir(directory, { recursive: true })
  return directory
}

function validManifest(modelSha256: string) {
  return {
    schemaVersion: 1,
    modelVersion: 'test-v1',
    modelFile: 'pieces.onnx',
    modelSha256,
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
  }
}

function frame(): { pixels: Uint8Array; width: number; height: number; topLeft: { x: number; y: number }; bottomRight: { x: number; y: number }; roiScale: number } {
  return {
    pixels: new Uint8Array(40 * 44 * 4).fill(120),
    width: 40,
    height: 44,
    topLeft: { x: 4, y: 4 },
    bottomRight: { x: 36, y: 40 },
    roiScale: 0.6,
  }
}

describe('recognition model manifest', () => {
  it('verifies model hash and exact 15-class mapping', async () => {
    const directory = await fixtureDirectory()
    const modelBytes = new Uint8Array([1, 2, 3, 4, 5])
    const sha256 = createHash('sha256').update(modelBytes).digest('hex')
    await writeFile(join(directory, 'pieces.onnx'), modelBytes)
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(validManifest(sha256)))

    const manifest = await loadRecognitionManifest(join(directory, 'manifest.json'))
    expect(manifest.modelVersion).toBe('test-v1')
    expect(manifest.classes).toEqual(RECOGNITION_CLASSES)
    expect(manifest.modelPath).toBe(join(directory, 'pieces.onnx'))
  })

  it('rejects a model whose hash does not match the manifest', async () => {
    const directory = await fixtureDirectory()
    await writeFile(join(directory, 'pieces.onnx'), new Uint8Array([9, 9, 9]))
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(validManifest('0'.repeat(64))))

    await expect(loadRecognitionManifest(join(directory, 'manifest.json')))
      .rejects.toMatchObject({ code: 'MODEL_HASH_MISMATCH' })
  })

  it('rejects a class mapping mismatch before inference', async () => {
    const directory = await fixtureDirectory()
    const modelBytes = new Uint8Array([1])
    const sha256 = createHash('sha256').update(modelBytes).digest('hex')
    const manifest = validManifest(sha256)
    manifest.classes = [...manifest.classes].reverse()
    await writeFile(join(directory, 'pieces.onnx'), modelBytes)
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest))

    await expect(loadRecognitionManifest(join(directory, 'manifest.json')))
      .rejects.toMatchObject({ code: 'CLASS_MAPPING_MISMATCH' })
  })
})

describe('RecognitionWorkerManager', () => {
  it('normalizes backend scores into 90 probability rows', async () => {
    const backend: RecognitionInferenceBackend = {
      async infer() {
        return Array.from({ length: 90 }, () => RECOGNITION_CLASSES.map((_, index) => index === 0 ? 4 : 0))
      },
      async dispose() {},
    }
    const manager = new RecognitionWorkerManager({ backend, timeoutMs: 200 })
    const result = await manager.infer(frame())
    expect(result).toHaveLength(90)
    expect(result[0]).toHaveLength(15)
    expect(result[0][0]).toBeGreaterThan(0.7)
    expect(result[0].reduce((sum, value) => sum + value, 0)).toBeCloseTo(1)
    await manager.dispose()
  })

  it('times out without returning a partial recognition result', async () => {
    const backend: RecognitionInferenceBackend = {
      infer: () => new Promise(() => undefined),
      async dispose() {},
    }
    const manager = new RecognitionWorkerManager({ backend, timeoutMs: 20 })
    await expect(manager.infer(frame())).rejects.toEqual(expect.objectContaining({
      name: 'RecognitionWorkerError',
      code: 'WORKER_TIMEOUT',
    }))
    await manager.dispose()
  })

  it('wraps backend crashes as structured worker errors', async () => {
    const backend: RecognitionInferenceBackend = {
      async infer() { throw new Error('backend exploded') },
      async dispose() {},
    }
    const manager = new RecognitionWorkerManager({ backend, timeoutMs: 200 })
    await expect(manager.infer(frame())).rejects.toEqual(expect.objectContaining({
      name: 'RecognitionWorkerError',
      code: 'WORKER_CRASHED',
    }))
  })
})

it('RecognitionWorkerError preserves retryability', () => {
  expect(new RecognitionWorkerError('MODEL_MISSING', 'missing', false)).toMatchObject({ retryable: false })
})
