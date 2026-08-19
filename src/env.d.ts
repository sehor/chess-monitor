/// <reference types="vite/client" />

import type { AnalysisApi, CaptureApi, ProfileApi, RecognitionApi, RealtimeApi, StudyApi, TrackerApi } from './shared/ipc'

declare global {
  interface Window {
    chessMonitor: {
      platform: NodeJS.Platform
      capture: CaptureApi
      analysis: AnalysisApi
      profiles: ProfileApi
      tracker: TrackerApi
      recognition: RecognitionApi
      realtime: RealtimeApi
      study: StudyApi
    }
  }
}
