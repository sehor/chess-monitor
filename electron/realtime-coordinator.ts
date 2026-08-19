import type {
  BoardTrackerDiagnostics,
  BoardTrackerEvent,
  BoardTrackerSnapshot,
  MoveConfirmedEvent,
  TrackerObservation,
  TrackerOptions,
  TrackerStatus,
} from '../src/domain/board-tracker'
import { BoardTracker } from '../src/domain/board-tracker'
import type {
  AnalysisEvent,
  AnalysisInfo,
  AnalysisStartInput,
  RealtimeSettings,
  RealtimeSnapshot,
  RealtimeStartInput,
} from '../src/shared/ipc'
import { GameStore, type PersistedGameSession } from './game-store'

const DEFAULT_SETTINGS: RealtimeSettings = { multiPv: 3, depth: 16 }

export interface RealtimeEngine {
  onEvent(listener: (event: AnalysisEvent) => void): () => void
  start(request: AnalysisStartInput): number
  stop(): void
}

function trackerMessage(snapshot: BoardTrackerSnapshot | null): string {
  if (!snapshot) return '监控未启动'
  const state = snapshot.state
  if ('message' in state) return state.message
  const labels = {
    STABLE: '棋盘稳定，正在监控',
    MOVE_ANIMATING: '检测到变化，等待动画结束',
    MOVE_CONFIRMED: `已确认着法 ${state.status === 'MOVE_CONFIRMED' ? state.move : ''}`,
  }
  return labels[state.status as keyof typeof labels] ?? state.status
}

export class RealtimeCoordinator {
  private tracker: BoardTracker | undefined
  private session: PersistedGameSession | undefined
  private trackerOptions: Partial<TrackerOptions> = {}
  private isPaused = false
  private storageError: string | null = null
  private analysisState: RealtimeSnapshot['analysis'] = this.emptyAnalysis()
  private currentAnalysisId: number | null = null
  private readonly listeners = new Set<(snapshot: RealtimeSnapshot) => void>()
  private readonly trackerListeners = new Set<(event: BoardTrackerEvent) => void>()
  private readonly removeEngineListener: () => void

  constructor(
    private readonly store: GameStore,
    private readonly engine: RealtimeEngine,
    private readonly now: () => number = Date.now,
  ) {
    this.removeEngineListener = engine.onEvent((event) => this.handleEngineEvent(event))
    const active = store.getActive()
    if (active) this.restore(active)
  }

  onEvent(listener: (snapshot: RealtimeSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onTrackerEvent(listener: (event: BoardTrackerEvent) => void): () => void {
    this.trackerListeners.add(listener)
    return () => this.trackerListeners.delete(listener)
  }

  getSnapshot(): RealtimeSnapshot {
    const trackerSnapshot = this.tracker?.snapshot() ?? null
    const trackerState = trackerSnapshot?.state ?? null
    const monitoringMessage = this.storageError
      ?? (this.isPaused ? '监控已暂停' : trackerMessage(trackerSnapshot))

    return {
      gameId: this.session?.id ?? null,
      monitoringState: this.getMonitoringState(trackerState?.status),
      monitoringMessage,
      trackerState: trackerState ? structuredClone(trackerState) : null,
      position: trackerSnapshot ? structuredClone(trackerSnapshot.position) : null,
      confirmedMoves: structuredClone(this.session?.moves ?? []),
      analysis: structuredClone(this.analysisState),
      settings: { ...(this.session?.settings ?? DEFAULT_SETTINGS) },
    }
  }

  getTrackerSnapshot(): BoardTrackerSnapshot | null {
    return this.tracker?.snapshot() ?? null
  }

  diagnostics(): BoardTrackerDiagnostics | null {
    return this.tracker?.diagnostics() ?? null
  }

  start(input: RealtimeStartInput, options: Partial<TrackerOptions> = {}): RealtimeSnapshot {
    const settings = { ...DEFAULT_SETTINGS, ...input.settings }
    this.assertSettings(settings)
    this.engine.stop()
    this.trackerOptions = options
    this.tracker = new BoardTracker(input.fen, input.orientation, options)
    this.session = this.store.create(this.tracker.snapshot().position.fen, input.orientation, settings)
    this.isPaused = false
    this.storageError = null
    this.analysisState = this.emptyAnalysis(this.tracker.snapshot().position.positionVersion)
    this.currentAnalysisId = null
    this.emit()
    this.startAnalysis()
    return this.getSnapshot()
  }

  observe(observation: TrackerObservation): RealtimeSnapshot {
    if (!this.tracker || this.isPaused || this.storageError) return this.getSnapshot()
    this.commitEvents(this.tracker.observe(observation))
    return this.getSnapshot()
  }

  confirmCandidate(move: string): RealtimeSnapshot {
    const tracker = this.requireTracker()
    this.commitEvents(tracker.confirmCandidate(move, this.now()))
    return this.getSnapshot()
  }

  resync(fen: string): RealtimeSnapshot {
    const tracker = this.requireTracker()
    const wasPaused = this.isPaused
    const events = tracker.resync(fen, this.now())
    try {
      const position = tracker.snapshot().position
      this.session = this.store.replaceBaseline(this.requireSession().id, position.fen, position.positionVersion)
      if (wasPaused) this.session = this.store.setStatus(this.session.id, 'paused')
      this.storageError = null
      this.publishTrackerEvents(events)
      this.positionChanged(!wasPaused)
    } catch {
      this.rollbackAfterStorageFailure('无法持久化重同步局面，监控已暂停')
    }
    return this.getSnapshot()
  }

  undo(): RealtimeSnapshot {
    const tracker = this.requireTracker()
    const events = tracker.undo(this.now())
    try {
      const position = tracker.snapshot().position
      this.session = this.store.undoLatestMove(this.requireSession().id, position.fen, position.positionVersion)
      this.storageError = null
      this.publishTrackerEvents(events)
      this.positionChanged(!this.isPaused)
    } catch {
      this.rollbackAfterStorageFailure('无法持久化撤销操作，监控已暂停')
    }
    return this.getSnapshot()
  }

  pause(): RealtimeSnapshot {
    const session = this.requireSession()
    this.session = this.store.setStatus(session.id, 'paused')
    this.isPaused = true
    this.engine.stop()
    this.analysisState.isTrusted = false
    this.analysisState.message = '监控已暂停；分析结果暂不可信'
    this.emit()
    return this.getSnapshot()
  }

  resume(): RealtimeSnapshot {
    const session = this.requireSession()
    this.session = this.store.setStatus(session.id, 'active')
    this.isPaused = false
    this.storageError = null
    if (this.tracker?.snapshot().state.status !== 'DESYNC') this.startAnalysis()
    else this.emit()
    return this.getSnapshot()
  }

  stop(): RealtimeSnapshot {
    if (this.session) this.store.setStatus(this.session.id, 'finished')
    const events = this.tracker?.stop() ?? []
    this.engine.stop()
    this.publishTrackerEvents(events)
    this.tracker = undefined
    this.session = undefined
    this.isPaused = false
    this.storageError = null
    this.currentAnalysisId = null
    this.analysisState = this.emptyAnalysis()
    this.emit()
    return this.getSnapshot()
  }

  configure(settings: RealtimeSettings): RealtimeSnapshot {
    this.assertSettings(settings)
    const session = this.requireSession()
    this.session = this.store.updateSettings(session.id, settings)
    if (!this.isPaused && this.tracker?.snapshot().state.status !== 'DESYNC') this.startAnalysis()
    else this.emit()
    return this.getSnapshot()
  }

  restartAnalysis(): RealtimeSnapshot {
    if (this.tracker && !this.isPaused && this.tracker.snapshot().state.status !== 'DESYNC') {
      this.startAnalysis()
    }
    return this.getSnapshot()
  }

  dispose(): void {
    this.removeEngineListener()
    this.engine.stop()
  }

  private commitEvents(events: BoardTrackerEvent[]): void {
    const confirmed = events.find((event): event is MoveConfirmedEvent => event.type === 'move-confirmed')
    if (confirmed) {
      try {
        this.session = this.store.confirmMove(this.requireSession().id, confirmed)
        this.storageError = null
      } catch {
        this.rollbackAfterStorageFailure('无法保存已确认着法，监控已暂停')
        return
      }
    }

    this.publishTrackerEvents(events)
    const state = this.tracker?.snapshot().state
    if (confirmed) {
      this.positionChanged(true)
    } else if (state?.status === 'DESYNC') {
      this.engine.stop()
      this.currentAnalysisId = null
      this.analysisState.isTrusted = false
      this.analysisState.message = '跟踪已失步；旧分析不再可信'
      this.emit()
    } else if (events.length > 0) {
      this.emit()
    }
  }

  private positionChanged(shouldAnalyze: boolean): void {
    const version = this.tracker?.snapshot().position.positionVersion ?? null
    this.currentAnalysisId = null
    this.analysisState = this.emptyAnalysis(version)
    this.emit()
    if (shouldAnalyze) this.startAnalysis()
  }

  private startAnalysis(): void {
    const position = this.tracker?.snapshot().position
    const settings = this.session?.settings
    if (!position || !settings || this.isPaused || this.storageError) return

    this.currentAnalysisId = null
    this.analysisState = {
      ...this.emptyAnalysis(position.positionVersion),
      state: 'STARTING',
      message: '正在启动当前局面分析',
      isTrusted: true,
    }
    this.emit()
    try {
      this.currentAnalysisId = this.engine.start({
        fen: position.fen,
        positionVersion: position.positionVersion,
        multiPv: settings.multiPv,
        depth: settings.depth,
      })
    } catch (error) {
      this.analysisState.state = 'FAILED'
      this.analysisState.message = error instanceof Error ? error.message : '无法启动 Pikafish'
      this.analysisState.isTrusted = false
      this.emit()
    }
  }

  private handleEngineEvent(event: AnalysisEvent): void {
    const version = event.type === 'info' ? event.value.positionVersion : event.positionVersion
    const analysisId = event.type === 'info' ? event.value.analysisId : event.analysisId
    const currentVersion = this.tracker?.snapshot().position.positionVersion
    if (version !== currentVersion) return
    if (this.currentAnalysisId === null && event.type === 'state' && event.state === 'STARTING') {
      this.currentAnalysisId = analysisId
    }
    if (analysisId !== this.currentAnalysisId) return

    if (event.type === 'state') {
      this.analysisState.state = event.state
      this.analysisState.message = event.message ?? {
        STARTING: '正在启动 Pikafish',
        ANALYZING: '正在分析当前局面',
        STOPPED: '分析已停止',
        RESTARTING: '引擎异常，正在自动恢复',
        FAILED: '引擎恢复失败，请重试',
      }[event.state]
      if (event.state === 'FAILED') this.analysisState.isTrusted = false
    } else if (event.type === 'info') {
      const lines = [...this.analysisState.lines]
      const index = lines.findIndex((line) => line.multiPv === event.value.multiPv)
      if (index === -1) lines.push(event.value)
      else if (event.value.depth >= lines[index].depth) lines[index] = event.value
      this.analysisState.lines = lines.sort((left, right) => left.multiPv - right.multiPv)
    } else {
      this.analysisState.bestMove = event.move
      const session = this.session
      if (session && this.analysisState.lines.length > 0) {
        try {
          this.store.saveAnalysisSummary(
            session.id,
            version,
            session.settings.depth,
            event.move,
            this.analysisState.lines,
          )
        } catch {
          this.rollbackAfterStorageFailure('无法保存分析摘要，监控已暂停')
          return
        }
      }
    }
    this.emit()
  }

  private rollbackAfterStorageFailure(message: string): void {
    this.engine.stop()
    const persisted = this.store.getActive()
    if (persisted) {
      try {
        this.restore(persisted)
      } catch {
        this.tracker = undefined
        this.session = undefined
      }
      try {
        if (this.session) this.session = this.store.setStatus(this.session.id, 'error')
      } catch {
        // The original storage error remains the actionable failure.
      }
    }
    this.isPaused = true
    this.storageError = message
    this.currentAnalysisId = null
    this.analysisState.isTrusted = false
    this.analysisState.message = message
    this.emit()
  }

  private restore(session: PersistedGameSession): void {
    const replayMoves = session.moves
      .filter((move) => move.positionVersion > session.baselineVersion)
      .map((move) => move.move)
    const tracker = new BoardTracker(session.baselineFen, session.orientation, this.trackerOptions, {
      basePositionVersion: session.baselineVersion,
      moves: replayMoves,
      confirmedMoveCount: session.moves.length,
    })
    if (tracker.snapshot().position.fen !== session.currentFen || tracker.snapshot().position.positionVersion !== session.currentVersion) {
      throw new Error('Persisted game position cannot be reconstructed')
    }
    this.tracker = tracker
    this.session = session
    this.isPaused = session.status !== 'active'
    this.storageError = session.status === 'error' ? '上次持久化失败；请确认后恢复监控' : null
    this.currentAnalysisId = null
    this.analysisState = this.emptyAnalysis(session.currentVersion)
  }

  private publishTrackerEvents(events: BoardTrackerEvent[]): void {
    for (const event of events) {
      for (const listener of this.trackerListeners) listener(event)
    }
  }

  private emit(): void {
    const snapshot = this.getSnapshot()
    for (const listener of this.listeners) listener(snapshot)
  }

  private emptyAnalysis(positionVersion: number | null = null): RealtimeSnapshot['analysis'] {
    return {
      state: 'STOPPED',
      message: '尚未开始分析',
      positionVersion,
      isTrusted: false,
      lines: [],
      bestMove: null,
    }
  }

  private getMonitoringState(trackerStatus?: TrackerStatus): RealtimeSnapshot['monitoringState'] {
    if (this.storageError) return 'ERROR'
    if (!this.tracker) return 'IDLE'
    if (this.isPaused) return 'PAUSED'
    return trackerStatus === 'DESYNC' ? 'DESYNC' : 'RUNNING'
  }

  private requireTracker(): BoardTracker {
    if (!this.tracker) throw new Error('Tracker is not running')
    return this.tracker
  }

  private requireSession(): PersistedGameSession {
    if (!this.session) throw new Error('Game session is not active')
    return this.session
  }

  private assertSettings(settings: RealtimeSettings): void {
    if (
      !Number.isInteger(settings.multiPv) || settings.multiPv < 1 || settings.multiPv > 5 ||
      !Number.isInteger(settings.depth) || settings.depth < 1 || settings.depth > 128
    ) {
      throw new Error('Realtime analysis settings are invalid')
    }
  }
}
