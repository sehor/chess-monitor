/// <reference types="vite/client" />

import type { AnalysisApi, CaptureApi, ProfileApi, RealtimeApi, TrackerApi } from './shared/ipc'

declare global {
  interface Window {
    chessMonitor: {
      platform: NodeJS.Platform
      capture: CaptureApi
      analysis: AnalysisApi
      profiles: ProfileApi
      tracker: TrackerApi
      realtime: RealtimeApi
    }
  }
}
