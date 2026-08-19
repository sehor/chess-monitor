import type { Orientation, Side } from '../domain/position'
import type { AnalysisInfo, AnalysisState, EngineDescriptor, RealtimeSettings } from './ipc'

export type StudyNodeSource = 'live' | 'variation' | 'import' | 'fen' | 'resync' | 'undo'

export interface StudyNode {
  id: string
  gameId: string
  parentId: string | null
  source: StudyNodeSource
  move: string | null
  fen: string
  ply: number
  livePositionVersion: number | null
  createdAt: string
}

export interface StudyAnalysis {
  cacheKey: string
  nodeId?: string
  fen: string
  engine: EngineDescriptor
  settings: RealtimeSettings
  bestMove: string | null
  lines: AnalysisInfo[]
  createdAt: string
}

export type ReviewStatus = 'idle' | 'running' | 'paused' | 'completed' | 'failed'

export interface ReviewJob {
  gameId: string
  status: ReviewStatus
  depth: number
  multiPv: number
  nextIndex: number
  totalNodes: number
  completedNodes: number
  nodeIds: string[]
  engineSha256: string
  message: string
  updatedAt?: string
}

export interface StudyMark {
  nodeId: string
  kind: 'question' | 'blunder'
  mover: Side
  actualMove: string
  bestMove: string
  lossCp: number | null
  mateSwing: boolean
  explanation: string
  createdAt: string
}

export interface StudyGameSummary {
  id: string
  orientation: Orientation
  currentFen: string
  currentVersion: number
  status: 'active' | 'paused' | 'finished' | 'error'
  createdAt: string
  updatedAt: string
}

export interface StudySnapshot {
  game: StudyGameSummary
  nodes: StudyNode[]
  analyses: StudyAnalysis[]
  marks: StudyMark[]
  review: ReviewJob | null
}

export type StudyAnalysisState = AnalysisState | 'CACHED' | 'COMPLETE'

export interface StudyNodeAnalysisSnapshot {
  nodeId: string
  state: StudyAnalysisState
  message: string
  lines: AnalysisInfo[]
  bestMove: string | null
}

export type StudyEvent =
  | { type: 'analysis'; value: StudyNodeAnalysisSnapshot }
  | { type: 'review'; value: ReviewJob }
  | { type: 'study-updated'; gameId: string }

export interface StudyAnalyzeInput {
  nodeId: string
  settings: RealtimeSettings
}

export interface StudyBranchInput {
  gameId: string
  parentNodeId: string
  move: string
}

export interface StudyFenInput {
  gameId: string
  fen: string
}

export interface StudyReviewInput {
  gameId: string
  settings: RealtimeSettings
}
