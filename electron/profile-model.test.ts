import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RECOGNITION_CLASSES } from '../src/domain/recognition'
import { loadProfileRecognitionManifest } from './profile-model'

const fixtureDirectories: string[] = []

async function fixtureDirectory(): Promise<string> {
  const directory = join(tmpdir(), `chess-monitor-profile-model-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  await mkdir(directory, { recursive: true })
  fixtureDirectories.push(directory)
  return directory
}

function manifest(modelSha256: string, modelVersion = 'test-v1') {
  return {
    schemaVersion: 1 as const,
    modelVersion,
    modelFile: 'pieces.onnx',
    modelSha256,
    classes: [...RECOGNITION_CLASSES],
    input: {
      width: 32,
      height: 32,
      channels: 3 as const,
      layout: 'NCHW' as const,
      colorSpace: 'RGB' as const,
      scale: 1 / 255,
      mean: [0, 0, 0] as [number, number, number],
      std: [1, 1, 1] as [number, number, number],
    },
  }
}

async function dedicatedFixture(modelVersion = 'test-v1') {
  const directory = await fixtureDirectory()
  const modelBytes = new Uint8Array([1, 2, 3, 4, 5])
  const modelSha256 = createHash('sha256').update(modelBytes).digest('hex')
  const manifestBytes = Buffer.from(JSON.stringify(manifest(modelSha256, modelVersion)))
  const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex')
  await writeFile(join(directory, 'pieces.onnx'), modelBytes)
  await writeFile(join(directory, 'client.json'), manifestBytes)
  return {
    directory,
    profile: {
      model: {
        strategy: 'dedicated' as const,
        manifestPath: 'client.json',
        manifestSha256,
        modelVersion,
      },
    },
  }
}

afterEach(async () => {
  await Promise.all(fixtureDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('Profile recognition model validation', () => {
  it('accepts a dedicated manifest only after both hashes and the version match', async () => {
    const fixture = await dedicatedFixture()
    const loaded = await loadProfileRecognitionManifest(fixture.directory, fixture.profile)
    expect(loaded.modelVersion).toBe('test-v1')
  })

  it('rejects a model file changed after the manifest was signed', async () => {
    const fixture = await dedicatedFixture()
    await writeFile(join(fixture.directory, 'pieces.onnx'), new Uint8Array([9, 9, 9]))
    await expect(loadProfileRecognitionManifest(fixture.directory, fixture.profile))
      .rejects.toMatchObject({ code: 'MODEL_HASH_MISMATCH' })
  })

  it('rejects a manifest changed after its hash was recorded', async () => {
    const fixture = await dedicatedFixture()
    await writeFile(join(fixture.directory, 'client.json'), JSON.stringify(manifest('0'.repeat(64))))
    await expect(loadProfileRecognitionManifest(fixture.directory, fixture.profile))
      .rejects.toMatchObject({ code: 'MODEL_HASH_MISMATCH' })
  })

  it('rejects a Profile modelVersion that disagrees with its manifest', async () => {
    const fixture = await dedicatedFixture('manifest-v1')
    const mismatchedProfile = {
      model: { ...fixture.profile.model, modelVersion: 'profile-v2' },
    }
    await expect(loadProfileRecognitionManifest(fixture.directory, mismatchedProfile))
      .rejects.toMatchObject({ code: 'MODEL_MANIFEST_INVALID' })
  })

  it('rejects manifests outside the recognition resource directory', async () => {
    const directory = await fixtureDirectory()
    const profile = {
      model: {
        strategy: 'dedicated' as const,
        manifestPath: '../outside.json',
        manifestSha256: '0'.repeat(64),
        modelVersion: 'test-v1',
      },
    }
    await expect(loadProfileRecognitionManifest(directory, profile))
      .rejects.toMatchObject({ code: 'MODEL_MANIFEST_INVALID' })
  })
})
