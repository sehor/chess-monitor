import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type { CaptureProfile } from '../src/shared/profile'
import {
  loadRecognitionManifest,
  RecognitionWorkerError,
  type LoadedRecognitionModelManifest,
} from './recognition-worker'

type ProfileModelBinding = Pick<CaptureProfile, 'model'>

export async function loadProfileRecognitionManifest(
  recognitionRoot: string,
  profile: ProfileModelBinding | null,
): Promise<LoadedRecognitionModelManifest> {
  const root = resolve(recognitionRoot)
  const manifestPath = resolve(
    root,
    profile?.model.strategy === 'dedicated' ? profile.model.manifestPath : 'manifest.json',
  )
  const relativeManifestPath = relative(root, manifestPath)
  if (relativeManifestPath.startsWith('..') || isAbsolute(relativeManifestPath)) {
    throw new RecognitionWorkerError(
      'MODEL_MANIFEST_INVALID',
      'Profile recognition manifest must stay inside the recognition resource directory',
      false,
    )
  }

  if (profile?.model.strategy === 'dedicated') {
    let manifestBytes: Uint8Array
    try {
      manifestBytes = await readFile(manifestPath)
    } catch {
      throw new RecognitionWorkerError('MODEL_MISSING', 'Profile recognition manifest is missing or unreadable', false)
    }
    const actualManifestSha256 = createHash('sha256').update(manifestBytes).digest('hex')
    if (actualManifestSha256 !== profile.model.manifestSha256) {
      throw new RecognitionWorkerError('MODEL_HASH_MISMATCH', 'Profile recognition manifest hash does not match', false)
    }
  }

  const manifest = await loadRecognitionManifest(manifestPath)
  const expectedVersion = profile?.model.modelVersion
  if (expectedVersion && manifest.modelVersion !== expectedVersion) {
    throw new RecognitionWorkerError(
      'MODEL_MANIFEST_INVALID',
      'Profile recognition model version does not match its manifest',
      false,
    )
  }
  return manifest
}
