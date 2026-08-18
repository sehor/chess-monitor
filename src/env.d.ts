/// <reference types="vite/client" />

import type { CaptureApi } from './shared/ipc'

declare global {
  interface Window {
    chessMonitor: {
      platform: NodeJS.Platform
      capture: CaptureApi
    }
  }
}
