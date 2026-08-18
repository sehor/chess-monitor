import { app, BrowserWindow, desktopCapturer, ipcMain, session } from 'electron'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  failure,
  success,
  type CaptureSource,
  type IpcResult,
} from '../src/shared/ipc'

const sourceCache = new Map<string, Electron.DesktopCapturerSource>()
let selectedSourceId: string | undefined

function isValidSourceId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
}

async function listCaptureSources(): Promise<IpcResult<CaptureSource[]>> {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 240, height: 135 },
      fetchWindowIcons: false,
    })

    sourceCache.clear()
    for (const source of sources) sourceCache.set(source.id, source)

    if (selectedSourceId && !sourceCache.has(selectedSourceId)) {
      selectedSourceId = undefined
    }

    return success(
      sources.map((source) => ({
        id: source.id,
        name: source.name,
        thumbnailDataUrl: source.thumbnail.isEmpty()
          ? null
          : source.thumbnail.toDataURL(),
      })),
    )
  } catch {
    return failure('CAPTURE_DENIED', 'Unable to enumerate application windows', true)
  }
}

ipcMain.handle('capture:list-sources', listCaptureSources)
ipcMain.handle('capture:select-source', (_event, sourceId: unknown): IpcResult<void> => {
  if (!isValidSourceId(sourceId)) {
    return failure('INVALID_INPUT', 'A valid capture source ID is required')
  }

  if (!sourceCache.has(sourceId)) {
    return failure('SOURCE_GONE', 'The selected window is no longer available', true)
  }

  selectedSourceId = sourceId
  return success(undefined)
})
ipcMain.handle('capture:clear-source', (): IpcResult<void> => {
  selectedSourceId = undefined
  return success(undefined)
})

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
  if (process.platform !== 'darwin') app.quit()
})
