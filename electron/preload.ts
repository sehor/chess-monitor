import { contextBridge, ipcRenderer } from 'electron'
import type { CaptureApi } from '../src/shared/ipc'

const capture: CaptureApi = Object.freeze({
  listSources: () => ipcRenderer.invoke('capture:list-sources'),
  selectSource: (sourceId: string) => ipcRenderer.invoke('capture:select-source', sourceId),
  clearSource: () => ipcRenderer.invoke('capture:clear-source'),
})

contextBridge.exposeInMainWorld('chessMonitor', {
  platform: process.platform,
  capture,
})
