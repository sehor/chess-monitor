import { contextBridge, ipcRenderer } from 'electron'
import type {
  AnalysisApi,
  AnalysisEvent,
  AnalysisStartInput,
  CaptureApi,
  CaptureFrameInput,
  CaptureSampleInput,
  ProfileApi,
  RecognitionApi,
  RecognitionCommitInput,
  RecognitionScanInput,
  RealtimeApi,
  RealtimeSettings,
  RealtimeSnapshot,
  RealtimeStartInput,
  TrackerApi,
  TrackerStartInput,
} from '../src/shared/ipc'
import type { CaptureProfileInput } from '../src/shared/profile'
import type { BoardTrackerEvent } from '../src/domain/board-tracker'
import type { RecognitionCorrection } from '../src/domain/recognition'

const capture: CaptureApi = Object.freeze({
  listSources: () => ipcRenderer.invoke('capture:list-sources'),
  selectSource: (sourceId: string) => ipcRenderer.invoke('capture:select-source', sourceId),
  clearSource: () => ipcRenderer.invoke('capture:clear-source'),
  analyzeFrame: (frame: CaptureFrameInput) => ipcRenderer.invoke('capture:analyze-frame', frame),
  saveSample: (sample: CaptureSampleInput) => ipcRenderer.invoke('capture:save-sample', sample),
})

const analysis: AnalysisApi = Object.freeze({
  start: (input: AnalysisStartInput) => ipcRenderer.invoke('analysis:start', input),
  stop: () => ipcRenderer.invoke('analysis:stop'),
  retry: () => ipcRenderer.invoke('analysis:retry'),
  selectEngine: () => ipcRenderer.invoke('analysis:select-engine'),
  getEngine: () => ipcRenderer.invoke('analysis:get-engine'),
  onEvent: (listener: (event: AnalysisEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, event: AnalysisEvent) => listener(event)
    ipcRenderer.on('analysis:event', handler)
    return () => ipcRenderer.removeListener('analysis:event', handler)
  },
})

const profiles: ProfileApi = Object.freeze({
  list: () => ipcRenderer.invoke('profile:list'),
  save: (input: CaptureProfileInput) => ipcRenderer.invoke('profile:save', input),
  delete: (id: string) => ipcRenderer.invoke('profile:delete', id),
  setActive: (id: string | null) => ipcRenderer.invoke('profile:set-active', id),
  getActive: () => ipcRenderer.invoke('profile:get-active'),
  exportDiagnostics: (id: string) => ipcRenderer.invoke('profile:export-diagnostics', id),
})

const tracker: TrackerApi = Object.freeze({
  start: (input: TrackerStartInput) => ipcRenderer.invoke('tracker:start', input),
  stop: () => ipcRenderer.invoke('tracker:stop'),
  resync: (fen: string) => ipcRenderer.invoke('tracker:resync', fen),
  confirmCandidate: (move: string) => ipcRenderer.invoke('tracker:confirm-candidate', move),
  undo: () => ipcRenderer.invoke('tracker:undo'),
  getState: () => ipcRenderer.invoke('tracker:get-state'),
  exportDiagnostics: () => ipcRenderer.invoke('tracker:export-diagnostics'),
  onEvent: (listener: (event: BoardTrackerEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, event: BoardTrackerEvent) => listener(event)
    ipcRenderer.on('tracker:event', handler)
    return () => ipcRenderer.removeListener('tracker:event', handler)
  },
})

const recognition: RecognitionApi = Object.freeze({
  scan: (input: RecognitionScanInput) => ipcRenderer.invoke('recognition:scan', input),
  correct: (corrections: RecognitionCorrection[]) => ipcRenderer.invoke('recognition:correct', corrections),
  commit: (input: RecognitionCommitInput) => ipcRenderer.invoke('recognition:commit', input),
  reset: () => ipcRenderer.invoke('recognition:reset'),
  getState: () => ipcRenderer.invoke('recognition:get-state'),
})

const realtime: RealtimeApi = Object.freeze({
  start: (input: RealtimeStartInput) => ipcRenderer.invoke('realtime:start', input),
  pause: () => ipcRenderer.invoke('realtime:pause'),
  resume: () => ipcRenderer.invoke('realtime:resume'),
  stop: () => ipcRenderer.invoke('realtime:stop'),
  resync: (fen: string) => ipcRenderer.invoke('realtime:resync', fen),
  confirmCandidate: (move: string) => ipcRenderer.invoke('realtime:confirm-candidate', move),
  undo: () => ipcRenderer.invoke('realtime:undo'),
  configure: (settings: RealtimeSettings) => ipcRenderer.invoke('realtime:configure', settings),
  retryAnalysis: () => ipcRenderer.invoke('realtime:retry-analysis'),
  getState: () => ipcRenderer.invoke('realtime:get-state'),
  onEvent: (listener: (snapshot: RealtimeSnapshot) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: RealtimeSnapshot) => listener(snapshot)
    ipcRenderer.on('realtime:event', handler)
    return () => ipcRenderer.removeListener('realtime:event', handler)
  },
})

contextBridge.exposeInMainWorld('chessMonitor', {
  platform: process.platform,
  capture,
  analysis,
  profiles,
  tracker,
  recognition,
  realtime,
})
