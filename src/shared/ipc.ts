export const IPC_ERROR_CODES = [
  'INVALID_INPUT',
  'SOURCE_GONE',
  'CAPTURE_DENIED',
  'FRAME_TOO_LARGE',
  'ENGINE_NOT_CONFIGURED',
  'ENGINE_START_FAILED',
  'ENGINE_PROTOCOL_ERROR',
  'ENGINE_TIMEOUT',
  'PROFILE_NOT_FOUND',
  'PROFILE_STORAGE_ERROR',
  'TRACKER_INVALID_STATE',
] as const

export type IpcErrorCode = (typeof IPC_ERROR_CODES)[number]

export interface IpcError {
  code: IpcErrorCode
  message: string
  retryable: boolean
}

export type IpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: IpcError }

export interface CaptureSource {
  id: string
  name: string
  kind: 'window' | 'screen'
  thumbnailDataUrl: string | null
  isSelected?: boolean
}

import type { CaptureProfile, CaptureProfileInput, ProfileListResult } from './profile'

export interface ProfileApi {
  list(): Promise<IpcResult<ProfileListResult>>
  save(input: CaptureProfileInput): Promise<IpcResult<CaptureProfile>>
  delete(id: string): Promise<IpcResult<{ deleted: boolean }>>
  setActive(id: string | null): Promise<IpcResult<CaptureProfile | null>>
  getActive(): Promise<IpcResult<CaptureProfile | null>>
  exportDiagnostics(id: string): Promise<IpcResult<{ fileName: string }>>
}

export interface CaptureFrameInput {
  pixels: Uint8Array | Uint8ClampedArray
  width: number
  height: number
  topLeft: { x: number; y: number }
  bottomRight: { x: number; y: number }
  roiScale?: number
  dpi?: number
}

import type { BoardTrackerEvent, BoardTrackerSnapshot, TrackerOptions } from '../domain/board-tracker'
import type { Orientation } from '../domain/position'

export interface TrackerStartInput {
  fen: string
  orientation: Orientation
  options?: Partial<TrackerOptions>
}

export interface TrackerApi {
  start(input: TrackerStartInput): Promise<IpcResult<BoardTrackerSnapshot>>
  stop(): Promise<IpcResult<BoardTrackerSnapshot | null>>
  resync(fen: string): Promise<IpcResult<BoardTrackerSnapshot>>
  confirmCandidate(move: string): Promise<IpcResult<BoardTrackerSnapshot>>
  undo(): Promise<IpcResult<BoardTrackerSnapshot>>
  getState(): Promise<IpcResult<BoardTrackerSnapshot | null>>
  exportDiagnostics(): Promise<IpcResult<{ fileName: string }>>
  onEvent(listener: (event: BoardTrackerEvent) => void): () => void
}

export interface CaptureAnalysis {
  isStable: boolean
  stableFrameCount: number
  changedPointCount: number
  medianScore: number
  pointScores: number[]
}

export interface CaptureSampleInput {
  pngBytes: Uint8Array
  metadata?: CaptureSampleMetadataInput
}

export type CaptureEventType = 'move' | 'capture' | 'highlight' | 'animation' | 'stationary'

export interface CaptureSampleAnnotation {
  gameId: string
  dpi: 100 | 125 | 150
  eventType: CaptureEventType
  expectedChangedPoints: number[]
  gridErrorRatio: number | null
  captureSucceeded: boolean
}

export interface CaptureSampleMetadataInput extends CaptureSampleAnnotation {
  orientation: 'red-bottom' | 'black-bottom'
  roiScale: number
  sourceName: string
  analysis: CaptureAnalysis | null
}

export interface CaptureQualitySummary {
  eventCount: number
  captureSuccessRate: number
  maximumGridErrorRatio: number | null
  changedPointRecall: number | null
  stationaryFalsePositiveRate: number | null
  countsByDpi: Record<'100' | '125' | '150', number>
  trainingEventCount: number
  holdoutEventCount: number
  lowThreshold: number | null
  highThreshold: number | null
  failedSampleIds: string[]
  meetsQualityGate: boolean
}

export interface CaptureApi {
  listSources(): Promise<IpcResult<CaptureSource[]>>
  selectSource(sourceId: string): Promise<IpcResult<void>>
  clearSource(): Promise<IpcResult<void>>
  analyzeFrame(frame: CaptureFrameInput): Promise<IpcResult<CaptureAnalysis>>
  saveSample(sample: CaptureSampleInput): Promise<IpcResult<{
    fileName: string
    metadataFileName?: string
    reportFileNames?: { json: string; markdown: string }
    summary?: CaptureQualitySummary
  }>>
}

export type AnalysisState = 'STARTING' | 'ANALYZING' | 'STOPPED' | 'RESTARTING' | 'FAILED'

export interface NormalizedScore {
  cp?: number
  mateIn?: number
}

export interface AnalysisInfo {
  analysisId: number
  positionVersion: number
  multiPv: number
  depth: number
  score: NormalizedScore
  nodes: string | null
  pv: string[]
}

export type AnalysisEvent =
  | { type: 'state'; analysisId: number; positionVersion: number; state: AnalysisState; message?: string }
  | { type: 'info'; value: AnalysisInfo }
  | { type: 'bestmove'; analysisId: number; positionVersion: number; move: string | null }

export interface AnalysisStartInput {
  fen: string
  positionVersion: number
  multiPv: number
}

export interface EngineDescriptor {
  name: string
  sha256: string
}

export interface AnalysisApi {
  start(input: AnalysisStartInput): Promise<IpcResult<{ analysisId: number }>>
  stop(): Promise<IpcResult<void>>
  retry(): Promise<IpcResult<{ analysisId: number }>>
  selectEngine(): Promise<IpcResult<EngineDescriptor | null>>
  getEngine(): Promise<IpcResult<EngineDescriptor | null>>
  onEvent(listener: (event: AnalysisEvent) => void): () => void
}

export function success<T>(value: T): IpcResult<T> {
  return { ok: true, value }
}

export function failure(
  code: IpcErrorCode,
  message: string,
  retryable = false,
): IpcResult<never> {
  return { ok: false, error: { code, message, retryable } }
}
