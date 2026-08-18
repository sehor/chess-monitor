import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, session, type OpenDialogOptions } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import {
  failure,
  success,
  type CaptureSource,
  type CaptureSampleMetadataInput,
  type IpcResult,
} from '../src/shared/ipc'
import { EngineManager, EngineStartError } from './engine-manager'
import { FrameAnalyzer } from '../src/shared/capture-analysis'
import { assignDatasetSplit, renderCaptureReport, type CaptureSampleRecord } from '../src/shared/capture-report'
import { resolveSelectedSourceId } from '../src/shared/capture-source'
import { XiangqiGame } from '../src/domain/game'
import { ProfileStore } from './profile-store'
import type { CaptureSourceKind } from '../src/shared/profile'
import { evaluateProfileCompatibility } from '../src/shared/profile'
import { BoardTracker, type BoardTrackerEvent, type TrackerOptions } from '../src/domain/board-tracker'
import { parseFen, type Orientation } from '../src/domain/position'

const sourceCache = new Map<string, Electron.DesktopCapturerSource>()
let selectedSourceId: string | undefined
let selectedSourceName: string | undefined
let selectedSourceKind: CaptureSourceKind | undefined
let profileStore: ProfileStore | undefined
let boardTracker: BoardTracker | undefined
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

function isValidIccsMove(value: unknown): value is string {
  return typeof value === 'string' && /^[a-i][0-9][a-i][0-9]$/.test(value)
}

function sourceKind(sourceId: string): CaptureSourceKind {
  return sourceId.startsWith('screen:') ? 'screen' : 'window'
}

function configureFrameAnalyzer(profile: ReturnType<ProfileStore['getActive']>): void {
  frameAnalyzer = new FrameAnalyzer(profile ? {
    lowThreshold: profile.thresholds.low,
    highThreshold: profile.thresholds.high,
    stableFrameRequirement: profile.stableFrameRequirement,
  } : undefined)
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
    (candidate.multiPv as number) <= 5
  )
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
  for (const key of ['animationWaitMs', 'candidateTimeoutMs'] as const) {
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

function emitTrackerEvents(events: BoardTrackerEvent[]): void {
  for (const event of events) {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('tracker:event', event)
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
    if (selectedSourceId && selectedSourceId !== previousSourceId) frameAnalyzer.reset()

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
  frameAnalyzer.reset()
  return success(undefined)
})
ipcMain.handle('capture:clear-source', (): IpcResult<void> => {
  selectedSourceId = undefined
  selectedSourceName = undefined
  selectedSourceKind = undefined
  frameAnalyzer.reset()
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

ipcMain.handle('profile:set-active', (_event, id: unknown) => {
  if (id !== null && !isValidProfileId(id)) return failure('INVALID_INPUT', 'A valid profile ID is required')
  if (!profileStore) return failure('PROFILE_STORAGE_ERROR', 'Profile storage is unavailable', true)
  try {
    profileStore.setActive(id)
    const active = profileStore.getActive()
    selectedSourceId = undefined
    selectedSourceName = active?.source.name
    selectedSourceKind = active?.source.kind
    configureFrameAnalyzer(active)
    return success(active)
  } catch (error) {
    return error instanceof Error && error.message === 'Profile does not exist'
      ? failure('PROFILE_NOT_FOUND', 'Profile does not exist')
      : failure('PROFILE_STORAGE_ERROR', 'Unable to activate the profile', true)
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
    if (boardTracker) {
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
      emitTrackerEvents(boardTracker.observe({
        capturedAt: Date.now(),
        sourceValid,
        profileValid: sourceMatchesProfile && compatibility.state === 'compatible',
        analysis,
      }))
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
  const activeProfile = profileStore?.getActive()
  if (!activeProfile) return failure('PROFILE_NOT_FOUND', 'Activate a valid Profile before starting tracking')
  try {
    boardTracker = new BoardTracker(input.fen, input.orientation, {
      changeThreshold: activeProfile.thresholds.high,
      confirmThreshold: Math.min(1, Math.max(activeProfile.thresholds.high, activeProfile.thresholds.high * 1.5)),
      animationWaitMs: activeProfile.animationWaitMs,
      ...input.options,
    })
    return success(boardTracker.snapshot())
  } catch {
    boardTracker = undefined
    return failure('INVALID_INPUT', 'Tracker configuration is invalid')
  }
})

ipcMain.handle('tracker:stop', () => {
  if (!boardTracker) return success(null)
  emitTrackerEvents(boardTracker.stop())
  const snapshot = boardTracker.snapshot()
  boardTracker = undefined
  return success(snapshot)
})

ipcMain.handle('tracker:resync', (_event, fen: unknown) => {
  if (!boardTracker) return failure('TRACKER_INVALID_STATE', 'Tracker is not running')
  if (typeof fen !== 'string' || fen.length < 1 || fen.length > 512) return failure('INVALID_INPUT', 'FEN is invalid')
  try {
    parseFen(fen)
    emitTrackerEvents(boardTracker.resync(fen, Date.now()))
    return success(boardTracker.snapshot())
  } catch {
    return failure('INVALID_INPUT', 'FEN is invalid')
  }
})

ipcMain.handle('tracker:confirm-candidate', (_event, move: unknown) => {
  if (!boardTracker) return failure('TRACKER_INVALID_STATE', 'Tracker is not running')
  if (!isValidIccsMove(move)) return failure('INVALID_INPUT', 'Candidate move is invalid')
  try {
    emitTrackerEvents(boardTracker.confirmCandidate(move, Date.now()))
    return success(boardTracker.snapshot())
  } catch (error) {
    return failure('TRACKER_INVALID_STATE', error instanceof Error ? error.message : 'Candidate cannot be confirmed')
  }
})

ipcMain.handle('tracker:undo', () => {
  if (!boardTracker) return failure('TRACKER_INVALID_STATE', 'Tracker is not running')
  try {
    emitTrackerEvents(boardTracker.undo(Date.now()))
    return success(boardTracker.snapshot())
  } catch (error) {
    return failure('TRACKER_INVALID_STATE', error instanceof Error ? error.message : 'Move cannot be undone')
  }
})

ipcMain.handle('tracker:get-state', () => success(boardTracker?.snapshot() ?? null))

ipcMain.handle('tracker:export-diagnostics', async () => {
  if (!boardTracker) return failure('TRACKER_INVALID_STATE', 'Tracker is not running')
  try {
    const directory = join(app.getPath('userData'), 'diagnostics')
    await mkdir(directory, { recursive: true })
    const fileName = `tracker-${Date.now()}.json`
    await writeFile(join(directory, fileName), `${JSON.stringify(boardTracker.diagnostics(), null, 2)}\n`)
    return success({ fileName })
  } catch {
    return failure('PROFILE_STORAGE_ERROR', 'Unable to export tracker diagnostics', true)
  }
})
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
    return success(engineManager.selectEngine(result.filePaths[0]))
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

app.whenReady().then(() => {
  try {
    profileStore = new ProfileStore(join(app.getPath('userData'), 'profiles.sqlite3'))
    const activeProfile = profileStore.getActive()
    selectedSourceName = activeProfile?.source.name
    selectedSourceKind = activeProfile?.source.kind
    configureFrameAnalyzer(activeProfile)
  } catch (error) {
    console.error('Unable to initialize profile storage', error)
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
  profileStore?.close()
  profileStore = undefined
})
