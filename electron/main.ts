import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, session, type OpenDialogOptions } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import {
  failure,
  success,
  type CaptureSource,
  type CaptureSampleMetadataInput,
  type IpcResult,
  type RealtimeSettings,
  type RealtimeSnapshot,
  type RealtimeStartInput,
} from '../src/shared/ipc'
import { EngineManager, EngineStartError } from './engine-manager'
import { FrameAnalyzer } from '../src/shared/capture-analysis'
import { assignDatasetSplit, renderCaptureReport, type CaptureSampleRecord } from '../src/shared/capture-report'
import { resolveSelectedSourceId } from '../src/shared/capture-source'
import { XiangqiGame } from '../src/domain/game'
import { ProfileStore } from './profile-store'
import type { CaptureProfile, CaptureSourceKind } from '../src/shared/profile'
import { createProfilePackage, evaluateProfileCompatibility, matchProfileCandidates, parseProfilePackage, type ProfileMatchContext } from '../src/shared/profile'
import type { TrackerOptions } from '../src/domain/board-tracker'
import { parseFen, type Orientation, type Side } from '../src/domain/position'
import type { RecognitionCorrection } from '../src/domain/recognition'
import { GameStore } from './game-store'
import { RealtimeCoordinator } from './realtime-coordinator'
import { RecognitionCoordinator } from './recognition-coordinator'
import { loadRecognitionManifest, RecognitionWorkerError } from './recognition-worker'

const sourceCache = new Map<string, Electron.DesktopCapturerSource>()
let selectedSourceId: string | undefined
let selectedSourceName: string | undefined
let selectedSourceKind: CaptureSourceKind | undefined
let profileStore: ProfileStore | undefined
let gameStore: GameStore | undefined
let realtimeCoordinator: RealtimeCoordinator | undefined
let recognitionCoordinator: RecognitionCoordinator | undefined
let recognitionStartupError: RecognitionWorkerError | undefined
const engineManager = new EngineManager()
let frameAnalyzer = new FrameAnalyzer()
let captureSampleRecords: CaptureSampleRecord[] = []

engineManager.onEvent((event) => {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('analysis:event', event)
  }
})

function isValidSourceId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
}

function isValidProfileId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
}

function isProfileMatchContext(value: unknown): value is ProfileMatchContext {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  const source = candidate.source as Record<string, unknown> | undefined
  const frame = candidate.frame as Record<string, unknown> | undefined
  return Boolean(
    source && ['window', 'screen'].includes(source.kind as string) && typeof source.name === 'string' && source.name.length <= 256 &&
    frame && Number.isInteger(frame.width) && Number.isInteger(frame.height) && typeof frame.dpi === 'number' && Number.isFinite(frame.dpi),
  )
}

function isValidIccsMove(value: unknown): value is string {
  return typeof value === 'string' && /^[a-i][0-9][a-i][0-9]$/.test(value)
}

function sourceKind(sourceId: string): CaptureSourceKind {
  return sourceId.startsWith('screen:') ? 'screen' : 'window'
}

function recognitionResourceRoot(): string {
  return app.isPackaged ? join(process.resourcesPath, 'recognition') : join(process.cwd(), 'resources', 'recognition')
}

async function loadProfileRecognitionManifest(profile: CaptureProfile | null) {
  const root = recognitionResourceRoot()
  const manifestPath = profile?.model.strategy === 'dedicated'
    ? join(root, profile.model.manifestPath)
    : join(root, 'manifest.json')
  if (profile?.model.strategy === 'dedicated') {
    const manifestBytes = await readFile(manifestPath)
    const actualManifestSha256 = createHash('sha256').update(manifestBytes).digest('hex')
    if (actualManifestSha256 !== profile.model.manifestSha256) {
      throw new RecognitionWorkerError('MODEL_HASH_MISMATCH', 'Profile recognition manifest hash does not match', false)
    }
  }
  const manifest = await loadRecognitionManifest(manifestPath)
  const expectedVersion = profile?.model.modelVersion
  if (expectedVersion && manifest.modelVersion !== expectedVersion) {
    throw new RecognitionWorkerError('MODEL_MANIFEST_INVALID', 'Profile recognition model version does not match its manifest', false)
  }
  return manifest
}

async function switchRecognitionCoordinator(profile: CaptureProfile | null): Promise<void> {
  const manifest = await loadProfileRecognitionManifest(profile)
  const next = new RecognitionCoordinator({ manifest, timeoutMs: 1_500 })
  const previous = recognitionCoordinator
  recognitionCoordinator = next
  recognitionStartupError = undefined
  await previous?.dispose()
}

function configureFrameAnalyzer(profile: ReturnType<ProfileStore['getActive']>): void {
  frameAnalyzer = new FrameAnalyzer(profile ? {
    lowThreshold: profile.thresholds.low,
    highThreshold: profile.thresholds.high,
    stableFrameRequirement: profile.stableFrameRequirement,
  } : undefined)
  recognitionCoordinator?.reset()
}

function resetFrameBaseline(): void {
  frameAnalyzer.reset()
  recognitionCoordinator?.reset()
}

function isAnalysisStartInput(value: unknown): value is { fen: string; positionVersion: number; multiPv: number } {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.fen === 'string' &&
    candidate.fen.length > 0 &&
    candidate.fen.length <= 512 &&
    Number.isSafeInteger(candidate.positionVersion) &&
    (candidate.positionVersion as number) >= 0 &&
    Number.isInteger(candidate.multiPv) &&
    (candidate.multiPv as number) >= 1 &&
    (candidate.multiPv as number) <= 5 &&
    (candidate.depth === undefined || (
      Number.isInteger(candidate.depth) &&
      (candidate.depth as number) >= 1 &&
      (candidate.depth as number) <= 128
    ))
  )
}

function parseRecognitionScanInput(value: unknown): { orientation: Orientation; sideToMove: Side } | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Record<string, unknown>
  if (!['red-bottom', 'black-bottom'].includes(candidate.orientation as string)) return null
  if (!['red', 'black'].includes(candidate.sideToMove as string)) return null
  return { orientation: candidate.orientation as Orientation, sideToMove: candidate.sideToMove as Side }
}

function parseRecognitionCorrections(value: unknown): RecognitionCorrection[] | null {
  if (!Array.isArray(value) || value.length > 90) return null
  const corrections: RecognitionCorrection[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') return null
    const candidate = item as Record<string, unknown>
    if (!Number.isInteger(candidate.point) || (candidate.point as number) < 0 || (candidate.point as number) >= 90) return null
    if (typeof candidate.label !== 'string' || !['_', 'R', 'N', 'B', 'A', 'K', 'C', 'P', 'r', 'n', 'b', 'a', 'k', 'c', 'p'].includes(candidate.label)) return null
    corrections.push({ point: candidate.point as number, label: candidate.label as RecognitionCorrection['label'] })
  }
  if (new Set(corrections.map((item) => item.point)).size !== corrections.length) return null
  return corrections
}

function recognitionFailure(error: unknown) {
  if (error instanceof RecognitionWorkerError) {
    if (['MODEL_MISSING', 'MODEL_HASH_MISMATCH', 'MODEL_MANIFEST_INVALID', 'CLASS_MAPPING_MISMATCH'].includes(error.code)) {
      return failure('RECOGNITION_MODEL_ERROR', error.message, error.retryable)
    }
    if (error.code === 'RUNTIME_MISSING') return failure('RECOGNITION_RUNTIME_ERROR', error.message, error.retryable)
    if (error.code === 'WORKER_TIMEOUT') return failure('RECOGNITION_TIMEOUT', error.message, true)
    if (error.code === 'INVALID_OUTPUT') return failure('RECOGNITION_INVALID_OUTPUT', error.message, error.retryable)
    if (error.code === 'WORKER_CRASHED') return failure('RECOGNITION_WORKER_CRASHED', error.message, error.retryable)
    if (error.code === 'INFERENCE_FAILED') return failure('RECOGNITION_INFERENCE_FAILED', error.message, error.retryable)
    return failure('RECOGNITION_FAILED', error.message, error.retryable)
  }
  return failure('RECOGNITION_FAILED', error instanceof Error ? error.message : 'Recognition failed', true)
}

function recognitionSnapshotFailure(snapshot: { message: string; error: { code: string; retryable: boolean } | null }) {
  const code = snapshot.error?.code
  const retryable = snapshot.error?.retryable ?? true
  if (['MODEL_MISSING', 'MODEL_HASH_MISMATCH', 'MODEL_MANIFEST_INVALID', 'CLASS_MAPPING_MISMATCH'].includes(code ?? '')) {
    return failure('RECOGNITION_MODEL_ERROR', snapshot.message, retryable)
  }
  if (code === 'RUNTIME_MISSING') return failure('RECOGNITION_RUNTIME_ERROR', snapshot.message, retryable)
  if (code === 'WORKER_TIMEOUT') return failure('RECOGNITION_TIMEOUT', snapshot.message, true)
  if (code === 'INVALID_OUTPUT') return failure('RECOGNITION_INVALID_OUTPUT', snapshot.message, retryable)
  if (code === 'WORKER_CRASHED') return failure('RECOGNITION_WORKER_CRASHED', snapshot.message, retryable)
  if (code === 'INFERENCE_FAILED') return failure('RECOGNITION_INFERENCE_FAILED', snapshot.message, retryable)
  return failure('RECOGNITION_FAILED', snapshot.message, retryable)
}

function parseRealtimeSettings(value: unknown): RealtimeSettings | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Record<string, unknown>
  if (
    !Number.isInteger(candidate.multiPv) || (candidate.multiPv as number) < 1 || (candidate.multiPv as number) > 5 ||
    !Number.isInteger(candidate.depth) || (candidate.depth as number) < 1 || (candidate.depth as number) > 128
  ) return null
  return { multiPv: candidate.multiPv as number, depth: candidate.depth as number }
}

function parseTrackerStartInput(value: unknown): { fen: string; orientation: Orientation; options?: Partial<TrackerOptions> } | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Record<string, unknown>
  if (typeof candidate.fen !== 'string' || candidate.fen.length < 1 || candidate.fen.length > 512) return null
  if (!['red-bottom', 'black-bottom'].includes(candidate.orientation as string)) return null
  try {
    parseFen(candidate.fen)
  } catch {
    return null
  }
  if (candidate.options !== undefined && (!candidate.options || typeof candidate.options !== 'object' || Array.isArray(candidate.options))) return null
  const rawOptions = (candidate.options ?? {}) as Record<string, unknown>
  const options: Partial<TrackerOptions> = {}
  for (const key of ['changeThreshold', 'confirmThreshold', 'ambiguityMargin'] as const) {
    if (rawOptions[key] !== undefined) {
      if (typeof rawOptions[key] !== 'number' || !Number.isFinite(rawOptions[key])) return null
      options[key] = rawOptions[key]
    }
  }
  for (const key of ['animationWaitMs', 'candidateTimeoutMs', 'maximumFrameGapMs'] as const) {
    if (rawOptions[key] !== undefined) {
      if (!Number.isInteger(rawOptions[key])) return null
      options[key] = rawOptions[key] as number
    }
  }
  return {
    fen: candidate.fen,
    orientation: candidate.orientation as Orientation,
    ...(Object.keys(options).length ? { options } : {}),
  }
}

function parseRealtimeStartInput(value: unknown): RealtimeStartInput | null {
  const trackerInput = parseTrackerStartInput(value)
  if (!trackerInput || !value || typeof value !== 'object') return null
  const settingsValue = (value as Record<string, unknown>).settings
  if (settingsValue === undefined) return trackerInput
  if (!settingsValue || typeof settingsValue !== 'object' || Array.isArray(settingsValue)) return null
  const settings = parseRealtimeSettings({ multiPv: 3, depth: 16, ...settingsValue })
  return settings ? { ...trackerInput, settings } : null
}

function broadcast(channel: string, value: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send(channel, value)
}

function startRealtimeTracking(input: RealtimeStartInput): IpcResult<RealtimeSnapshot> {
  const activeProfile = profileStore?.getActive()
  if (!activeProfile) return failure('PROFILE_NOT_FOUND', 'Activate a valid Profile before starting tracking')
  if (!realtimeCoordinator) return failure('GAME_STORAGE_ERROR', 'Game storage is unavailable', true)
  try {
    return success(realtimeCoordinator.start(
      input,
      {
        changeThreshold: activeProfile.thresholds.high,
        confirmThreshold: Math.min(1, Math.max(activeProfile.thresholds.high, activeProfile.thresholds.high * 1.5)),
        animationWaitMs: activeProfile.animationWaitMs,
        ...input.options,
      },
      {
        profileId: activeProfile.id,
        profileVersion: activeProfile.profileVersion,
        modelVersion: activeProfile.model.modelVersion ?? recognitionCoordinator?.snapshot().modelVersion ?? null,
      },
    ))
  } catch (error) {
    return failure(
      'GAME_STORAGE_ERROR',
      error instanceof Error ? error.message : 'Unable to start realtime tracking',
      true,
    )
  }
}

function isCaptureFrameInput(value: unknown): value is {
  pixels: Uint8Array | Uint8ClampedArray
  width: number
  height: number
  topLeft: { x: number; y: number }
  bottomRight: { x: number; y: number }
  roiScale?: number
  dpi?: number
} {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  const hasPoint = (point: unknown): point is { x: number; y: number } =>
    Boolean(point) &&
    typeof point === 'object' &&
    Number.isFinite((point as Record<string, unknown>).x) &&
    Number.isFinite((point as Record<string, unknown>).y)

  return (
    (candidate.pixels instanceof Uint8Array || candidate.pixels instanceof Uint8ClampedArray) &&
    Number.isInteger(candidate.width) &&
    Number.isInteger(candidate.height) &&
    (candidate.roiScale === undefined ||
      (typeof candidate.roiScale === 'number' && candidate.roiScale >= 0.4 && candidate.roiScale <= 0.8)) &&
    (candidate.dpi === undefined ||
      (typeof candidate.dpi === 'number' && Number.isFinite(candidate.dpi) && candidate.dpi >= 50 && candidate.dpi <= 300)) &&
    hasPoint(candidate.topLeft) &&
    hasPoint(candidate.bottomRight)
  )
}

function isCaptureMetadata(value: unknown): value is CaptureSampleMetadataInput {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  const analysis = candidate.analysis as Record<string, unknown> | null
  const validAnalysis = analysis === null || Boolean(
    analysis &&
    typeof analysis.isStable === 'boolean' &&
    Number.isInteger(analysis.stableFrameCount) && (analysis.stableFrameCount as number) >= 0 &&
    Number.isInteger(analysis.changedPointCount) && (analysis.changedPointCount as number) >= 0 && (analysis.changedPointCount as number) <= 90 &&
    typeof analysis.medianScore === 'number' && Number.isFinite(analysis.medianScore) && (analysis.medianScore as number) >= 0 && (analysis.medianScore as number) <= 1 &&
    Array.isArray(analysis.pointScores) &&
    analysis.pointScores.length === 90 &&
    analysis.pointScores.every((score) => typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= 1),
  )
  return (
    typeof candidate.gameId === 'string' && candidate.gameId.length > 0 && candidate.gameId.length <= 128 &&
    [100, 125, 150].includes(candidate.dpi as number) &&
    ['move', 'capture', 'highlight', 'animation', 'stationary'].includes(candidate.eventType as string) &&
    Array.isArray(candidate.expectedChangedPoints) &&
    candidate.expectedChangedPoints.length <= 90 &&
    candidate.expectedChangedPoints.every((point) => Number.isInteger(point) && point >= 0 && point < 90) &&
    new Set(candidate.expectedChangedPoints).size === candidate.expectedChangedPoints.length &&
    (candidate.gridErrorRatio === null || (typeof candidate.gridErrorRatio === 'number' && candidate.gridErrorRatio >= 0 && candidate.gridErrorRatio <= 1)) &&
    typeof candidate.captureSucceeded === 'boolean' &&
    ['red-bottom', 'black-bottom'].includes(candidate.orientation as string) &&
    typeof candidate.roiScale === 'number' && candidate.roiScale >= 0.4 && candidate.roiScale <= 0.8 &&
    typeof candidate.sourceName === 'string' && candidate.sourceName.length <= 256 &&
    validAnalysis
  )
}

function isPngSample(value: unknown): value is { pngBytes: Uint8Array; metadata?: CaptureSampleMetadataInput } {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return candidate.pngBytes instanceof Uint8Array &&
    (candidate.metadata === undefined || isCaptureMetadata(candidate.metadata))
}

async function listCaptureSources(): Promise<IpcResult<CaptureSource[]>> {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['window', 'screen'],
      thumbnailSize: { width: 240, height: 135 },
      fetchWindowIcons: false,
    })

    sourceCache.clear()
    for (const source of sources) sourceCache.set(source.id, source)

    const previousSourceId = selectedSourceId
    const namedSources = sources.map((source) => ({ ...source, kind: sourceKind(source.id) }))
    selectedSourceId = resolveSelectedSourceId(namedSources, selectedSourceId, selectedSourceName, selectedSourceKind)
    if (selectedSourceId !== previousSourceId) resetFrameBaseline()

    return success(
      sources.map((source) => ({
        id: source.id,
        name: source.name,
        kind: sourceKind(source.id),
        thumbnailDataUrl: source.thumbnail.isEmpty()
          ? null
          : source.thumbnail.toDataURL(),
        isSelected: source.id === selectedSourceId,
      })),
    )
  } catch {
    return failure('CAPTURE_DENIED', 'Unable to enumerate capture sources', true)
  }
}

ipcMain.handle('capture:list-sources', listCaptureSources)
ipcMain.handle('capture:select-source', (_event, sourceId: unknown): IpcResult<void> => {
  if (!isValidSourceId(sourceId)) {
    return failure('INVALID_INPUT', 'A valid capture source ID is required')
  }

  if (!sourceCache.has(sourceId)) {
    return failure('SOURCE_GONE', 'The selected capture source is no longer available', true)
  }

  selectedSourceId = sourceId
  selectedSourceName = sourceCache.get(sourceId)?.name
  selectedSourceKind = sourceKind(sourceId)
  resetFrameBaseline()
  return success(undefined)
})
ipcMain.handle('capture:clear-source', (): IpcResult<void> => {
  selectedSourceId = undefined
  selectedSourceName = undefined
  selectedSourceKind = undefined
  resetFrameBaseline()
  return success(undefined)
})

ipcMain.handle('profile:list', () => {
  if (!profileStore) return failure('PROFILE_STORAGE_ERROR', 'Profile storage is unavailable', true)
  try {
    return success(profileStore.list())
  } catch {
    return failure('PROFILE_STORAGE_ERROR', 'Unable to read profiles', true)
  }
})

ipcMain.handle('profile:save', (_event, input: unknown) => {
  if (!profileStore) return failure('PROFILE_STORAGE_ERROR', 'Profile storage is unavailable', true)
  try {
    return success(profileStore.save(input))
  } catch (error) {
    return error instanceof TypeError
      ? failure('INVALID_INPUT', error.message)
      : failure('PROFILE_STORAGE_ERROR', 'Unable to save the profile', true)
  }
})

ipcMain.handle('profile:delete', (_event, id: unknown) => {
  if (!isValidProfileId(id)) return failure('INVALID_INPUT', 'A valid profile ID is required')
  if (!profileStore) return failure('PROFILE_STORAGE_ERROR', 'Profile storage is unavailable', true)
  try {
    return success({ deleted: profileStore.delete(id) })
  } catch {
    return failure('PROFILE_STORAGE_ERROR', 'Unable to delete the profile', true)
  }
})

ipcMain.handle('profile:duplicate', (_event, id: unknown) => {
  if (!isValidProfileId(id)) return failure('INVALID_INPUT', 'A valid profile ID is required')
  if (!profileStore) return failure('PROFILE_STORAGE_ERROR', 'Profile storage is unavailable', true)
  try { return success(profileStore.duplicate(id)) }
  catch (error) { return failure('PROFILE_STORAGE_ERROR', error instanceof Error ? error.message : 'Unable to duplicate profile', true) }
})

ipcMain.handle('profile:set-enabled', (_event, id: unknown, enabled: unknown) => {
  if (!isValidProfileId(id) || typeof enabled !== 'boolean') return failure('INVALID_INPUT', 'Profile enabled state is invalid')
  if (!profileStore) return failure('PROFILE_STORAGE_ERROR', 'Profile storage is unavailable', true)
  try { return success(profileStore.setEnabled(id, enabled)) }
  catch (error) { return failure('PROFILE_STORAGE_ERROR', error instanceof Error ? error.message : 'Unable to update profile', true) }
})

ipcMain.handle('profile:list-versions', (_event, id: unknown) => {
  if (!isValidProfileId(id)) return failure('INVALID_INPUT', 'A valid profile ID is required')
  if (!profileStore) return failure('PROFILE_STORAGE_ERROR', 'Profile storage is unavailable', true)
  return success(profileStore.listVersions(id))
})

ipcMain.handle('profile:rollback', (_event, id: unknown, profileVersion: unknown) => {
  if (!isValidProfileId(id) || !Number.isInteger(profileVersion) || (profileVersion as number) < 1) return failure('INVALID_INPUT', 'Profile rollback target is invalid')
  if (!profileStore) return failure('PROFILE_STORAGE_ERROR', 'Profile storage is unavailable', true)
  try { return success(profileStore.rollback(id, profileVersion as number)) }
  catch (error) { return failure('PROFILE_STORAGE_ERROR', error instanceof Error ? error.message : 'Unable to rollback profile', true) }
})

ipcMain.handle('profile:match', (_event, context: unknown) => {
  if (!isProfileMatchContext(context)) return failure('INVALID_INPUT', 'Profile match context is invalid')
  if (!profileStore) return failure('PROFILE_STORAGE_ERROR', 'Profile storage is unavailable', true)
  return success(matchProfileCandidates(profileStore.list().profiles, context))
})

ipcMain.handle('profile:set-active', async (_event, id: unknown) => {
  if (id !== null && !isValidProfileId(id)) return failure('INVALID_INPUT', 'A valid profile ID is required')
  if (!profileStore) return failure('PROFILE_STORAGE_ERROR', 'Profile storage is unavailable', true)
  const candidate = id === null ? null : profileStore.get(id)
  if (id !== null && !candidate) return failure('PROFILE_NOT_FOUND', 'Profile does not exist')
  if (candidate && !candidate.isEnabled) return failure('INVALID_INPUT', 'Profile is disabled')
  try {
    await switchRecognitionCoordinator(candidate)
    profileStore.setActive(id)
    const active = profileStore.getActive()
    selectedSourceId = undefined
    selectedSourceName = active?.source.name
    selectedSourceKind = active?.source.kind
    configureFrameAnalyzer(active)
    return success(active)
  } catch (error) {
    if (error instanceof RecognitionWorkerError) return recognitionFailure(error)
    return failure('PROFILE_STORAGE_ERROR', 'Unable to activate the profile', true)
  }
})

ipcMain.handle('profile:get-active', () => {
  if (!profileStore) return failure('PROFILE_STORAGE_ERROR', 'Profile storage is unavailable', true)
  try {
    return success(profileStore.getActive())
  } catch {
    return failure('PROFILE_STORAGE_ERROR', 'Unable to read the active profile', true)
  }
})

ipcMain.handle('profile:export', async (_event, id: unknown) => {
  if (!isValidProfileId(id)) return failure('INVALID_INPUT', 'A valid profile ID is required')
  if (!profileStore) return failure('PROFILE_STORAGE_ERROR', 'Profile storage is unavailable', true)
  const profile = profileStore.get(id)
  if (!profile) return failure('PROFILE_NOT_FOUND', 'Profile does not exist')
  const result = await dialog.showSaveDialog({
    defaultPath: `${profile.name.replace(/[\\/:*?"<>|]/g, '_')}-v${profile.profileVersion}.json`,
    filters: [{ name: 'Chess Monitor Profile', extensions: ['json'] }],
  })
  if (result.canceled || !result.filePath) return success({ fileName: '' })
  try {
    await writeFile(result.filePath, `${JSON.stringify(createProfilePackage(profile), null, 2)}\n`)
    return success({ fileName: result.filePath })
  } catch (error) {
    return failure('PROFILE_STORAGE_ERROR', error instanceof Error ? error.message : 'Unable to export profile', true)
  }
})

ipcMain.handle('profile:import', async () => {
  if (!profileStore) return failure('PROFILE_STORAGE_ERROR', 'Profile storage is unavailable', true)
  const result = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'Chess Monitor Profile', extensions: ['json'] }] })
  if (result.canceled || result.filePaths.length !== 1) return success(null)
  try {
    const bytes = await readFile(result.filePaths[0])
    if (bytes.byteLength > 512 * 1024) return failure('INVALID_INPUT', 'Profile package is too large')
    const parsedJson = JSON.parse(bytes.toString('utf8'))
    const parsed = parseProfilePackage(parsedJson)
    if (!parsed.ok) return failure('INVALID_INPUT', parsed.error)
    if (parsed.value.profile.model.strategy === 'dedicated') {
      const root = app.isPackaged ? join(process.resourcesPath, 'recognition') : join(process.cwd(), 'resources', 'recognition')
      const manifestBytes = await readFile(join(root, parsed.value.profile.model.manifestPath))
      const actual = createHash('sha256').update(manifestBytes).digest('hex')
      if (actual !== parsed.value.profile.model.manifestSha256) return failure('INVALID_INPUT', 'Profile model manifest hash does not match')
    }
    return success(profileStore.importPackage(parsed.value))
  } catch (error) {
    return failure('INVALID_INPUT', error instanceof Error ? error.message : 'Profile package cannot be imported')
  }
})

ipcMain.handle('profile:export-diagnostics', async (_event, id: unknown) => {
  if (!isValidProfileId(id)) return failure('INVALID_INPUT', 'A valid profile ID is required')
  if (!profileStore) return failure('PROFILE_STORAGE_ERROR', 'Profile storage is unavailable', true)
  try {
    const diagnostics = profileStore.diagnostics(id)
    if (!diagnostics) return failure('PROFILE_NOT_FOUND', 'Profile does not exist')
    const directory = join(app.getPath('userData'), 'diagnostics')
    await mkdir(directory, { recursive: true })
    const fileName = `profile-${id}-${Date.now()}.json`
    await writeFile(join(directory, fileName), `${JSON.stringify(diagnostics, null, 2)}\n`)
    return success({ fileName })
  } catch {
    return failure('PROFILE_STORAGE_ERROR', 'Unable to export profile diagnostics', true)
  }
})
ipcMain.handle('capture:analyze-frame', (_event, frame: unknown) => {
  if (!isCaptureFrameInput(frame)) {
    return failure('INVALID_INPUT', 'Capture frame is invalid')
  }

  try {
    const analysis = frameAnalyzer.analyze(frame)
    const activeProfile = profileStore?.getActive()
    const sourceValid = Boolean(selectedSourceId && sourceCache.has(selectedSourceId))
    const sourceMatchesProfile = Boolean(
      activeProfile &&
      activeProfile.source.name === selectedSourceName &&
      activeProfile.source.kind === selectedSourceKind,
    )
    const compatibility = activeProfile
      ? evaluateProfileCompatibility(activeProfile, {
          width: frame.width,
          height: frame.height,
          dpi: frame.dpi ?? activeProfile.frame.dpi,
        })
      : { state: 'recalibration-required' as const }
    const profileValid = sourceMatchesProfile && compatibility.state === 'compatible'

    recognitionCoordinator?.capture(frame, sourceValid && profileValid && analysis.isStable)
    if (realtimeCoordinator?.getTrackerSnapshot()) {
      realtimeCoordinator.observe({
        capturedAt: Date.now(),
        sourceValid,
        profileValid,
        analysis,
      })
    }
    return success(analysis)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to analyze capture frame'
    const code = message.includes('maximum') ? 'FRAME_TOO_LARGE' : 'INVALID_INPUT'
    return failure(code, message, code === 'FRAME_TOO_LARGE')
  }
})

ipcMain.handle('tracker:start', (_event, value: unknown) => {
  const input = parseTrackerStartInput(value)
  if (!input) return failure('INVALID_INPUT', 'Tracker start input is invalid')
  const result = startRealtimeTracking(input)
  return result.ok ? success(realtimeCoordinator!.getTrackerSnapshot()!) : result
})

ipcMain.handle('tracker:stop', () => {
  if (!realtimeCoordinator?.getTrackerSnapshot()) return success(null)
  const snapshot = realtimeCoordinator.getTrackerSnapshot()
  realtimeCoordinator.stop()
  return success(snapshot)
})

ipcMain.handle('tracker:resync', (_event, fen: unknown) => {
  if (!realtimeCoordinator?.getTrackerSnapshot()) return failure('TRACKER_INVALID_STATE', 'Tracker is not running')
  if (typeof fen !== 'string' || fen.length < 1 || fen.length > 512) return failure('INVALID_INPUT', 'FEN is invalid')
  try {
    parseFen(fen)
    realtimeCoordinator.resync(fen)
    return success(realtimeCoordinator.getTrackerSnapshot()!)
  } catch {
    return failure('INVALID_INPUT', 'FEN is invalid')
  }
})

ipcMain.handle('tracker:confirm-candidate', (_event, move: unknown) => {
  if (!realtimeCoordinator?.getTrackerSnapshot()) return failure('TRACKER_INVALID_STATE', 'Tracker is not running')
  if (!isValidIccsMove(move)) return failure('INVALID_INPUT', 'Candidate move is invalid')
  try {
    realtimeCoordinator.confirmCandidate(move)
    return success(realtimeCoordinator.getTrackerSnapshot()!)
  } catch (error) {
    return failure('TRACKER_INVALID_STATE', error instanceof Error ? error.message : 'Candidate cannot be confirmed')
  }
})

ipcMain.handle('tracker:undo', () => {
  if (!realtimeCoordinator?.getTrackerSnapshot()) return failure('TRACKER_INVALID_STATE', 'Tracker is not running')
  try {
    realtimeCoordinator.undo()
    return success(realtimeCoordinator.getTrackerSnapshot()!)
  } catch (error) {
    return failure('TRACKER_INVALID_STATE', error instanceof Error ? error.message : 'Move cannot be undone')
  }
})

ipcMain.handle('tracker:get-state', () => success(realtimeCoordinator?.getTrackerSnapshot() ?? null))

ipcMain.handle('tracker:export-diagnostics', async () => {
  const diagnostics = realtimeCoordinator?.diagnostics()
  if (!diagnostics) return failure('TRACKER_INVALID_STATE', 'Tracker is not running')
  try {
    const directory = join(app.getPath('userData'), 'diagnostics')
    await mkdir(directory, { recursive: true })
    const fileName = `tracker-${Date.now()}.json`
    await writeFile(join(directory, fileName), `${JSON.stringify(diagnostics, null, 2)}\n`)
    return success({ fileName })
  } catch {
    return failure('PROFILE_STORAGE_ERROR', 'Unable to export tracker diagnostics', true)
  }
})

ipcMain.handle('recognition:get-state', () => {
  if (recognitionStartupError) return recognitionFailure(recognitionStartupError)
  if (!recognitionCoordinator) return failure('RECOGNITION_INVALID_STATE', 'Recognition service is unavailable', true)
  return success(recognitionCoordinator.snapshot())
})

ipcMain.handle('recognition:reset', () => {
  if (recognitionStartupError) return recognitionFailure(recognitionStartupError)
  if (!recognitionCoordinator) return failure('RECOGNITION_INVALID_STATE', 'Recognition service is unavailable', true)
  return success(recognitionCoordinator.reset())
})

ipcMain.handle('recognition:scan', async (_event, value: unknown) => {
  if (recognitionStartupError) return recognitionFailure(recognitionStartupError)
  if (!recognitionCoordinator) return failure('RECOGNITION_INVALID_STATE', 'Recognition service is unavailable', true)
  const input = parseRecognitionScanInput(value)
  if (!input) return failure('INVALID_INPUT', 'Recognition scan input is invalid')
  const current = realtimeCoordinator?.getTrackerSnapshot()?.position
  if (current && current.orientation !== input.orientation) {
    return failure('INVALID_INPUT', 'Recognition scan must preserve the current orientation')
  }
  try {
    const snapshot = await recognitionCoordinator.scan(input)
    return snapshot.state === 'ERROR'
      ? recognitionSnapshotFailure(snapshot)
      : success(snapshot)
  } catch (error) {
    return recognitionFailure(error)
  }
})

ipcMain.handle('recognition:correct', (_event, value: unknown) => {
  if (recognitionStartupError) return recognitionFailure(recognitionStartupError)
  if (!recognitionCoordinator) return failure('RECOGNITION_INVALID_STATE', 'Recognition service is unavailable', true)
  const corrections = parseRecognitionCorrections(value)
  if (!corrections) return failure('INVALID_INPUT', 'Recognition corrections are invalid')
  try {
    return success(recognitionCoordinator.correct(corrections))
  } catch (error) {
    return failure('RECOGNITION_INVALID_STATE', error instanceof Error ? error.message : 'Recognition correction failed')
  }
})

ipcMain.handle('recognition:commit', (_event, value: unknown) => {
  if (recognitionStartupError) return recognitionFailure(recognitionStartupError)
  if (!recognitionCoordinator) return failure('RECOGNITION_INVALID_STATE', 'Recognition service is unavailable', true)
  if (!value || typeof value !== 'object') return failure('INVALID_INPUT', 'Recognition commit input is invalid')
  const candidate = value as Record<string, unknown>
  if (typeof candidate.fen !== 'string' || candidate.fen.length < 1 || candidate.fen.length > 512) {
    return failure('INVALID_INPUT', 'Recognition candidate FEN is invalid')
  }
  let settings: RealtimeSettings | undefined
  if (candidate.settings !== undefined) {
    if (!candidate.settings || typeof candidate.settings !== 'object' || Array.isArray(candidate.settings)) {
      return failure('INVALID_INPUT', 'Recognition commit settings are invalid')
    }
    settings = parseRealtimeSettings({ multiPv: 3, depth: 16, ...(candidate.settings as Record<string, unknown>) }) ?? undefined
    if (!settings) return failure('INVALID_INPUT', 'Recognition commit settings are invalid')
  }

  try {
    const accepted = recognitionCoordinator.accept(candidate.fen)
    let realtime: RealtimeSnapshot
    if (realtimeCoordinator?.getTrackerSnapshot()) {
      realtime = realtimeCoordinator.resync(accepted.fen)
      if (realtime.monitoringState === 'ERROR') {
        return failure('GAME_STORAGE_ERROR', realtime.monitoringMessage, true)
      }
    } else {
      const result = startRealtimeTracking({
        fen: accepted.fen,
        orientation: accepted.orientation,
        ...(settings ? { settings } : {}),
      })
      if (!result.ok) return result
      realtime = result.value
    }
    const recognition = recognitionCoordinator.markCommitted()
    frameAnalyzer.reset()
    return success({ recognition, realtime })
  } catch (error) {
    return failure('RECOGNITION_INVALID_STATE', error instanceof Error ? error.message : 'Recognition candidate cannot be committed')
  }
})

ipcMain.handle('realtime:start', (_event, value: unknown) => {
  const input = parseRealtimeStartInput(value)
  return input ? startRealtimeTracking(input) : failure('INVALID_INPUT', 'Realtime start input is invalid')
})

ipcMain.handle('realtime:pause', () => {
  if (!realtimeCoordinator?.getTrackerSnapshot()) return failure('TRACKER_INVALID_STATE', 'Tracker is not running')
  try {
    return success(realtimeCoordinator.pause())
  } catch {
    return failure('GAME_STORAGE_ERROR', 'Unable to pause realtime tracking', true)
  }
})

ipcMain.handle('realtime:resume', () => {
  if (!realtimeCoordinator?.getTrackerSnapshot()) return failure('TRACKER_INVALID_STATE', 'Tracker is not running')
  try {
    return success(realtimeCoordinator.resume())
  } catch {
    return failure('GAME_STORAGE_ERROR', 'Unable to resume realtime tracking', true)
  }
})

ipcMain.handle('realtime:stop', () => {
  if (!realtimeCoordinator) return failure('GAME_STORAGE_ERROR', 'Game storage is unavailable', true)
  try {
    return success(realtimeCoordinator.stop())
  } catch {
    return failure('GAME_STORAGE_ERROR', 'Unable to stop realtime tracking', true)
  }
})

ipcMain.handle('realtime:resync', (_event, fen: unknown) => {
  if (!realtimeCoordinator?.getTrackerSnapshot()) return failure('TRACKER_INVALID_STATE', 'Tracker is not running')
  if (typeof fen !== 'string' || fen.length < 1 || fen.length > 512) return failure('INVALID_INPUT', 'FEN is invalid')
  try {
    parseFen(fen)
    return success(realtimeCoordinator.resync(fen))
  } catch {
    return failure('INVALID_INPUT', 'FEN is invalid')
  }
})

ipcMain.handle('realtime:confirm-candidate', (_event, move: unknown) => {
  if (!realtimeCoordinator?.getTrackerSnapshot()) return failure('TRACKER_INVALID_STATE', 'Tracker is not running')
  if (!isValidIccsMove(move)) return failure('INVALID_INPUT', 'Candidate move is invalid')
  try {
    return success(realtimeCoordinator.confirmCandidate(move))
  } catch (error) {
    return failure('TRACKER_INVALID_STATE', error instanceof Error ? error.message : 'Candidate cannot be confirmed')
  }
})

ipcMain.handle('realtime:undo', () => {
  if (!realtimeCoordinator?.getTrackerSnapshot()) return failure('TRACKER_INVALID_STATE', 'Tracker is not running')
  try {
    return success(realtimeCoordinator.undo())
  } catch (error) {
    return failure('TRACKER_INVALID_STATE', error instanceof Error ? error.message : 'Move cannot be undone')
  }
})

ipcMain.handle('realtime:configure', (_event, value: unknown) => {
  if (!realtimeCoordinator?.getTrackerSnapshot()) return failure('TRACKER_INVALID_STATE', 'Tracker is not running')
  const settings = parseRealtimeSettings(value)
  if (!settings) return failure('INVALID_INPUT', 'Realtime analysis settings are invalid')
  try {
    return success(realtimeCoordinator.configure(settings))
  } catch {
    return failure('GAME_STORAGE_ERROR', 'Unable to save realtime analysis settings', true)
  }
})

ipcMain.handle('realtime:retry-analysis', () => {
  if (!realtimeCoordinator?.getTrackerSnapshot()) return failure('TRACKER_INVALID_STATE', 'Tracker is not running')
  try {
    return success(realtimeCoordinator.restartAnalysis())
  } catch {
    return failure('ENGINE_START_FAILED', 'Unable to restart Pikafish', true)
  }
})

ipcMain.handle('realtime:get-state', () =>
  realtimeCoordinator
    ? success(realtimeCoordinator.getSnapshot())
    : failure('GAME_STORAGE_ERROR', 'Game storage is unavailable', true),
)
ipcMain.handle('capture:save-sample', async (_event, sample: unknown) => {
  if (!isPngSample(sample)) {
    return failure('INVALID_INPUT', 'Capture sample is invalid')
  }
  if (sample.pngBytes.byteLength > 8 * 1024 * 1024) {
    return failure('FRAME_TOO_LARGE', 'Capture sample exceeds the maximum permitted size', true)
  }
  const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10]
  if (!pngSignature.every((byte, index) => sample.pngBytes[index] === byte)) {
    return failure('INVALID_INPUT', 'Capture sample must be a PNG image')
  }

  try {
    const directory = join(app.getPath('userData'), 'samples')
    await mkdir(directory, { recursive: true })
    const sampleId = randomUUID()
    const fileName = `${sampleId}.png`
    await writeFile(join(directory, fileName), sample.pngBytes)
    if (!sample.metadata) return success({ fileName })

    const record: CaptureSampleRecord = {
      ...sample.metadata,
      sampleId,
      fileName,
      capturedAt: new Date().toISOString(),
      datasetSplit: assignDatasetSplit(sample.metadata.gameId, sample.metadata.dpi),
    }
    const nextRecords = [...captureSampleRecords, record]
    const metadataFileName = `${sampleId}.json`
    const reportFileNames = { json: 'metrics.json', markdown: 'metrics.md' }
    const report = renderCaptureReport(nextRecords)
    await writeFile(join(directory, metadataFileName), `${JSON.stringify(record, null, 2)}\n`)
    await writeFile(join(directory, reportFileNames.json), report.json)
    await writeFile(join(directory, reportFileNames.markdown), report.markdown)
    captureSampleRecords = nextRecords
    return success({ fileName, metadataFileName, reportFileNames, summary: report.summary })
  } catch {
    return failure('CAPTURE_DENIED', 'Unable to save the capture sample', true)
  }
})

ipcMain.handle('analysis:start', (_event, input: unknown): IpcResult<{ analysisId: number }> => {
  if (!isAnalysisStartInput(input)) {
    return failure('INVALID_INPUT', 'Analysis input is invalid')
  }

  try {
    new XiangqiGame(input.fen)
    return success({ analysisId: engineManager.start(input) })
  } catch (error) {
    if (error instanceof EngineStartError) {
      return failure(error.code, error.message, error.retryable)
    }
    return failure('INVALID_INPUT', 'Analysis FEN is invalid')
  }
})
ipcMain.handle('analysis:stop', (): IpcResult<void> => {
  engineManager.stop()
  return success(undefined)
})
ipcMain.handle('analysis:retry', (): IpcResult<{ analysisId: number }> => {
  try {
    return success({ analysisId: engineManager.retry() })
  } catch (error) {
    if (error instanceof EngineStartError) {
      return failure(error.code, error.message, error.retryable)
    }
    return failure('ENGINE_START_FAILED', 'Unable to restart Pikafish', true)
  }
})
ipcMain.handle('analysis:select-engine', async () => {
  const options: OpenDialogOptions = {
    title: '选择 Pikafish 引擎',
    defaultPath: join(process.cwd(), 'engines'),
    properties: ['openFile'],
    filters: [{ name: 'Windows executable', extensions: ['exe'] }],
  }
  const parent = BrowserWindow.getFocusedWindow()
  const result = parent
    ? await dialog.showOpenDialog(parent, options)
    : await dialog.showOpenDialog(options)
  if (result.canceled || !result.filePaths[0]) return success(null)

  try {
    const descriptor = engineManager.selectEngine(result.filePaths[0])
    realtimeCoordinator?.restartAnalysis()
    return success(descriptor)
  } catch (error) {
    if (error instanceof EngineStartError) {
      return failure(error.code, error.message, error.retryable)
    }
    return failure('ENGINE_NOT_CONFIGURED', 'Unable to select Pikafish', false)
  }
})
ipcMain.handle('analysis:get-engine', (): IpcResult<ReturnType<EngineManager['getEngine']>> =>
  success(engineManager.getEngine()),
)

function createWindow(): BrowserWindow {
  const devServerUrl = process.env.VITE_DEV_SERVER_URL
  const appFilesRoot = resolve(import.meta.dirname, '../dist')
  const window = new BrowserWindow({
    width: 960,
    height: 640,
    minWidth: 720,
    minHeight: 480,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(import.meta.dirname, 'preload.mjs'),
    },
  })

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, targetUrl) => {
    const target = new URL(targetUrl)
    const isAllowedDevNavigation = devServerUrl
      ? target.origin === new URL(devServerUrl).origin
      : false
    const targetPath = target.protocol === 'file:' ? fileURLToPath(target) : ''
    const localRelativePath = targetPath ? relative(appFilesRoot, targetPath) : '..'
    const isAllowedLocalNavigation =
      target.protocol === 'file:' &&
      localRelativePath !== '' &&
      !localRelativePath.startsWith('..') &&
      !isAbsolute(localRelativePath)

    if (!isAllowedDevNavigation && !isAllowedLocalNavigation) event.preventDefault()
  })

  if (devServerUrl) {
    void window.loadURL(devServerUrl)
  } else {
    void window.loadFile(join(import.meta.dirname, '../dist/index.html'))
  }

  return window
}

app.whenReady().then(async () => {
  try {
    profileStore = new ProfileStore(join(app.getPath('userData'), 'profiles.sqlite3'))
    const activeProfile = profileStore.getActive()
    selectedSourceName = activeProfile?.source.name
    selectedSourceKind = activeProfile?.source.kind
    configureFrameAnalyzer(activeProfile)
  } catch (error) {
    console.error('Unable to initialize profile storage', error)
  }

  try {
    await switchRecognitionCoordinator(profileStore?.getActive() ?? null)
  } catch (error) {
    recognitionStartupError = error instanceof RecognitionWorkerError
      ? error
      : new RecognitionWorkerError('MODEL_MANIFEST_INVALID', error instanceof Error ? error.message : 'Recognition initialization failed', true)
    console.warn('Recognition service is unavailable', recognitionStartupError.message)
  }

  try {
    gameStore = new GameStore(join(app.getPath('userData'), 'games.sqlite3'))
    realtimeCoordinator = new RealtimeCoordinator(gameStore, engineManager)
    realtimeCoordinator.onEvent((snapshot) => broadcast('realtime:event', snapshot))
    realtimeCoordinator.onTrackerEvent((event) => broadcast('tracker:event', event))
  } catch (error) {
    console.error('Unable to initialize game storage', error)
  }

  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    const selectedSource = selectedSourceId
      ? sourceCache.get(selectedSourceId)
      : undefined

    callback(selectedSource ? { video: selectedSource } : {})
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  engineManager.dispose()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  void recognitionCoordinator?.dispose()
  recognitionCoordinator = undefined
  realtimeCoordinator?.dispose()
  realtimeCoordinator = undefined
  gameStore?.close()
  gameStore = undefined
  profileStore?.close()
  profileStore = undefined
})
