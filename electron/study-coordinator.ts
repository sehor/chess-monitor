import { createHash } from 'node:crypto'
import { RulesAdapter } from '../src/domain/game'
import { classifyMoveQuality, parseStudyRecord, serializeStudyRecord } from '../src/domain/study'
import { parseFen } from '../src/domain/position'
import type {
  AnalysisEvent,
  AnalysisInfo,
  AnalysisStartInput,
  EngineDescriptor,
  RealtimeSettings,
} from '../src/shared/ipc'
import type {
  ReviewJob,
  StudyAnalysis,
  StudyEvent,
  StudyNode,
  StudySnapshot,
} from '../src/shared/study'
import { GameStore } from './game-store'

export interface StudyEngine {
  onEvent(listener: (event: AnalysisEvent) => void): () => void
  start(request: AnalysisStartInput): number
  stop(): void
  getEngine(): EngineDescriptor | null
}

type AnalysisPurpose = 'interactive' | 'review'

interface ActiveStudyAnalysis {
  purpose: AnalysisPurpose
  node: StudyNode
  settings: RealtimeSettings
  cacheKey: string
  analysisId: number | null
  lines: AnalysisInfo[]
  bestMove: string | null
}

function assertSettings(settings: RealtimeSettings): void {
  if (
    !Number.isInteger(settings.multiPv) || settings.multiPv < 1 || settings.multiPv > 5 ||
    !Number.isInteger(settings.depth) || settings.depth < 1 || settings.depth > 128
  ) {
    throw new Error('Study analysis settings are invalid')
  }
}

function cacheKey(engine: EngineDescriptor, fen: string, settings: RealtimeSettings): string {
  return createHash('sha256')
    .update(JSON.stringify({ engineSha256: engine.sha256, fen, settings }))
    .digest('hex')
}

export class StudyCoordinator {
  private active: ActiveStudyAnalysis | null = null
  private pendingReviewGameId: string | null = null
  private suppressStopped = false
  private disposed = false
  private readonly listeners = new Set<(event: StudyEvent) => void>()
  private readonly unsubscribeEngine: () => void

  constructor(
    private readonly store: GameStore,
    private readonly engine: StudyEngine,
  ) {
    this.unsubscribeEngine = engine.onEvent((event) => this.handleEngineEvent(event))
  }

  onEvent(listener: (event: StudyEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    this.disposed = true
    this.unsubscribeEngine()
    this.stopEngine()
    this.active = null
    this.listeners.clear()
  }

  getSnapshot(gameId: string): StudySnapshot {
    const game = this.store.getGameSummary(gameId)
    if (!game) throw new Error('Study game does not exist')
    return {
      game,
      nodes: this.store.getStudyNodes(gameId),
      analyses: this.store.getStudyAnalyses(gameId),
      marks: this.store.getStudyMarks(gameId),
      review: this.store.getReviewJob(gameId),
    }
  }

  importRecord(text: string): StudySnapshot {
    const record = parseStudyRecord(text)
    const game = record.format === 'fen'
      ? this.store.createStudyGame(record.rootFen, 'red-bottom', 'fen')
      : this.store.importStudyGame(record.rootFen, record.moves)
    this.emit({ type: 'study-updated', gameId: game.id })
    return this.getSnapshot(game.id)
  }

  exportBranch(nodeId: string): string {
    const node = this.requireNode(nodeId)
    const nodes = new Map(this.store.getStudyNodes(node.gameId).map((item) => [item.id, item]))
    const moves: string[] = []
    let cursor: StudyNode | undefined = node
    while (cursor?.parentId) {
      if (cursor.move) moves.push(cursor.move)
      cursor = nodes.get(cursor.parentId)
      if (!cursor) throw new Error('Study branch is damaged')
    }
    if (!cursor) throw new Error('Study branch root is missing')
    return serializeStudyRecord({
      format: moves.length === 0 ? 'fen' : 'chess-monitor-iccs-v1',
      rootFen: cursor.fen,
      moves: moves.reverse(),
    })
  }

  createVariation(gameId: string, parentNodeId: string, move: string): StudyNode {
    const node = this.store.createStudyChild(gameId, parentNodeId, move, 'variation')
    this.emit({ type: 'study-updated', gameId })
    return node
  }

  createFen(gameId: string, fen: string): StudyNode {
    const node = this.store.createFenNode(gameId, fen)
    this.emit({ type: 'study-updated', gameId })
    return node
  }

  analyzeNode(nodeId: string, settings: RealtimeSettings): { cached: boolean; analysis: StudyAnalysis | null } {
    assertSettings(settings)
    const node = this.requireNode(nodeId)
    const descriptor = this.requireEngine()
    const key = cacheKey(descriptor, node.fen, settings)
    const cached = this.store.getCachedStudyAnalysis(key)
    if (cached) {
      this.store.attachStudyAnalysis(node.id, key)
      this.emitAnalysis(node.id, 'CACHED', '已使用相同引擎、FEN 和参数的缓存结果', cached.lines, cached.bestMove)
      this.emit({ type: 'study-updated', gameId: node.gameId })
      return { cached: true, analysis: { ...cached, nodeId: node.id } }
    }

    if (this.active) {
      if (this.active.purpose === 'review') this.setPendingReview(this.active.node.gameId)
      this.stopEngine()
      this.active = null
    }
    this.startEngineAnalysis('interactive', node, settings, key)
    return { cached: false, analysis: null }
  }

  startReview(gameId: string, settings: RealtimeSettings): ReviewJob {
    assertSettings(settings)
    const descriptor = this.requireEngine()
    const nodes = this.reviewNodes(gameId)
    if (nodes.length === 0) throw new Error('Study has no positions to review')
    if (this.active) {
      if (this.active.purpose === 'review' && this.active.node.gameId !== gameId) {
        const paused = this.store.updateReviewJob(this.active.node.gameId, { status: 'paused', message: '已被另一盘复盘任务暂停' })
        this.emit({ type: 'review', value: paused })
      }
      this.stopEngine()
      this.active = null
    }
    if (this.pendingReviewGameId && this.pendingReviewGameId !== gameId) {
      const paused = this.store.updateReviewJob(this.pendingReviewGameId, { status: 'paused', message: '已被另一盘复盘任务暂停' })
      this.emit({ type: 'review', value: paused })
    }
    this.pendingReviewGameId = null
    const job = this.store.resetReviewJob({
      gameId,
      status: 'running',
      depth: settings.depth,
      multiPv: settings.multiPv,
      nextIndex: 0,
      totalNodes: nodes.length,
      completedNodes: 0,
      nodeIds: nodes.map((node) => node.id),
      engineSha256: descriptor.sha256,
      message: '整盘复盘进行中',
    })
    this.emit({ type: 'review', value: job })
    this.continueReview(gameId)
    return this.store.getReviewJob(gameId)!
  }

  pauseReview(gameId: string): ReviewJob {
    const job = this.store.getReviewJob(gameId)
    if (!job) throw new Error('Review job does not exist')
    if (this.active?.purpose === 'review' && this.active.node.gameId === gameId) {
      this.stopEngine()
      this.active = null
    }
    if (this.pendingReviewGameId === gameId) this.pendingReviewGameId = null
    const next = this.store.updateReviewJob(gameId, { status: 'paused', message: '整盘复盘已暂停' })
    this.emit({ type: 'review', value: next })
    return next
  }

  resumeReview(gameId: string): ReviewJob {
    let job = this.store.getReviewJob(gameId)
    if (!job) throw new Error('Review job does not exist')
    const descriptor = this.requireEngine()
    if (descriptor.sha256 !== job.engineSha256) throw new Error('Review engine changed; start a new review instead')
    if (job.nodeIds.length === 0) {
      const nodes = this.reviewNodes(gameId)
      job = this.store.updateReviewJob(gameId, { nodeIds: nodes.map((node) => node.id), totalNodes: nodes.length })
    }
    if (this.active?.purpose === 'review' && this.active.node.gameId !== gameId) {
      const paused = this.store.updateReviewJob(this.active.node.gameId, { status: 'paused', message: '已被另一盘复盘任务暂停' })
      this.emit({ type: 'review', value: paused })
      this.stopEngine()
      this.active = null
    }
    const next = this.store.updateReviewJob(gameId, { status: 'running', message: '整盘复盘进行中' })
    this.emit({ type: 'review', value: next })
    if (this.active?.purpose === 'interactive') this.setPendingReview(gameId)
    else if (!this.active) this.continueReview(gameId)
    return next
  }

  private continueReview(gameId: string): void {
    if (this.disposed || this.active) return
    const job = this.store.getReviewJob(gameId)
    if (!job || job.status !== 'running') return
    const nodes = this.reviewNodesForJob(job)
    if (nodes.length !== job.nodeIds.length) return
    if (job.nextIndex >= job.totalNodes) {
      this.finishReview(gameId, nodes)
      return
    }

    const node = nodes[job.nextIndex]
    const settings = { multiPv: job.multiPv, depth: job.depth }
    const descriptor = this.requireEngine()
    if (descriptor.sha256 !== job.engineSha256) {
      const failed = this.store.updateReviewJob(gameId, { status: 'failed', message: '引擎已变更，无法继续原复盘任务' })
      this.emit({ type: 'review', value: failed })
      return
    }
    const key = cacheKey(descriptor, node.fen, settings)
    const cached = this.store.getCachedStudyAnalysis(key)
    if (cached) {
      this.store.attachStudyAnalysis(node.id, key)
      this.advanceReview(gameId)
      this.scheduleReviewContinuation(gameId)
      return
    }
    this.startEngineAnalysis('review', node, settings, key)
  }

  private startEngineAnalysis(
    purpose: AnalysisPurpose,
    node: StudyNode,
    settings: RealtimeSettings,
    key: string,
  ): void {
    const active: ActiveStudyAnalysis = {
      purpose,
      node,
      settings,
      cacheKey: key,
      analysisId: null,
      lines: [],
      bestMove: null,
    }
    this.active = active
    this.emitAnalysis(node.id, 'STARTING', purpose === 'review' ? '正在复盘该局面' : '正在分析历史局面', [], null)
    try {
      active.analysisId = this.engine.start({
        fen: node.fen,
        positionVersion: node.ply,
        multiPv: settings.multiPv,
        depth: settings.depth,
      })
    } catch (error) {
      this.active = null
      if (purpose === 'review') {
        const failed = this.store.updateReviewJob(node.gameId, { status: 'failed', message: error instanceof Error ? error.message : '复盘分析启动失败' })
        this.emit({ type: 'review', value: failed })
      }
      throw error
    }
  }

  private handleEngineEvent(event: AnalysisEvent): void {
    if (this.disposed) return
    const active = this.active
    if (!active) return
    const eventId = event.type === 'info' ? event.value.analysisId : event.analysisId
    if (active.analysisId !== null && eventId !== active.analysisId) return

    if (event.type === 'state') {
      if (event.state === 'STOPPED' && !this.suppressStopped) {
        const purpose = active.purpose
        const gameId = active.node.gameId
        this.active = null
        this.emitAnalysis(active.node.id, 'STOPPED', '分析已停止', active.lines, active.bestMove)
        if (purpose === 'review') {
          const failed = this.store.updateReviewJob(gameId, { status: 'failed', message: '研究引擎已停止；请重新开始复盘' })
          this.emit({ type: 'review', value: failed })
        } else {
          this.resumePendingReview()
        }
        return
      }
      if (event.state === 'FAILED') {
        this.emitAnalysis(active.node.id, 'FAILED', event.message ?? '分析失败', active.lines, active.bestMove)
        const purpose = active.purpose
        const gameId = active.node.gameId
        if (purpose === 'review') {
          const failed = this.store.updateReviewJob(gameId, { status: 'failed', message: event.message ?? '复盘分析失败' })
          this.emit({ type: 'review', value: failed })
        }
        this.active = null
        if (purpose === 'interactive') this.resumePendingReview()
      } else {
        this.emitAnalysis(active.node.id, event.state, event.message ?? '分析进行中', active.lines, active.bestMove)
      }
      return
    }

    if (event.type === 'info') {
      active.lines[event.value.multiPv - 1] = event.value
      this.emitAnalysis(active.node.id, 'ANALYZING', '正在分析', active.lines.filter(Boolean), active.bestMove)
      return
    }

    active.bestMove = event.move
    const descriptor = this.requireEngine()
    const analysis = this.store.saveStudyAnalysis(active.node.id, {
      cacheKey: active.cacheKey,
      nodeId: active.node.id,
      fen: active.node.fen,
      engine: descriptor,
      settings: active.settings,
      bestMove: active.bestMove,
      lines: active.lines.filter(Boolean),
      createdAt: new Date().toISOString(),
    })
    const purpose = active.purpose
    const gameId = active.node.gameId
    this.emitAnalysis(active.node.id, 'COMPLETE', '分析完成', analysis.lines, analysis.bestMove)
    this.emit({ type: 'study-updated', gameId })
    this.active = null

    if (purpose === 'review') {
      this.advanceReview(gameId)
      this.scheduleReviewContinuation(gameId)
    } else {
      this.resumePendingReview()
    }
  }

  private advanceReview(gameId: string): void {
    const job = this.store.getReviewJob(gameId)
    if (!job || job.status !== 'running') return
    const nextIndex = Math.min(job.nextIndex + 1, job.nodeIds.length)
    const next = this.store.updateReviewJob(gameId, {
      nextIndex,
      completedNodes: Math.max(job.completedNodes, nextIndex),
      message: nextIndex >= job.totalNodes ? '正在生成复盘标记' : `已完成 ${nextIndex}/${job.totalNodes} 个局面`,
    })
    this.emit({ type: 'review', value: next })
  }

  private finishReview(gameId: string, nodes: StudyNode[]): void {
    const job = this.store.getReviewJob(gameId)
    if (!job) throw new Error('Review job does not exist')
    const analyses = new Map(
      this.store.getStudyAnalyses(gameId)
        .filter((analysis) =>
          analysis.nodeId &&
          analysis.engine.sha256 === job.engineSha256 &&
          analysis.settings.depth === job.depth &&
          analysis.settings.multiPv === job.multiPv,
        )
        .map((analysis) => [analysis.nodeId!, analysis]),
    )
    const marks = []
    for (let index = 1; index < nodes.length; index += 1) {
      const beforeNode = nodes[index - 1]
      const afterNode = nodes[index]
      if (!afterNode.move || afterNode.parentId !== beforeNode.id) continue
      const before = analyses.get(beforeNode.id)
      const after = analyses.get(afterNode.id)
      const beforeScore = before?.lines.find((line) => line.multiPv === 1)?.score
      const afterScore = after?.lines.find((line) => line.multiPv === 1)?.score
      if (!before || !after || !beforeScore || !afterScore || !before.bestMove) continue
      const mover = parseFen(beforeNode.fen).sideToMove
      const mark = classifyMoveQuality({
        mover,
        actualMove: afterNode.move,
        bestMove: before.bestMove,
        before: beforeScore,
        after: afterScore,
      })
      if (!mark) continue
      marks.push({
        nodeId: afterNode.id,
        kind: mark.kind,
        mover,
        actualMove: afterNode.move,
        bestMove: before.bestMove,
        lossCp: mark.lossCp,
        mateSwing: mark.mateSwing,
        explanation: mark.explanation,
        createdAt: new Date().toISOString(),
      })
    }
    const complete = this.store.completeReviewJob(
      gameId,
      marks,
      nodes.length,
      `整盘复盘完成，共标记 ${marks.length} 个疑问手/漏着`,
    )
    this.emit({ type: 'review', value: complete })
    this.emit({ type: 'study-updated', gameId })
  }

  private reviewNodes(gameId: string): StudyNode[] {
    const live = this.store.getLiveStudyNodes(gameId)
    if (live.length > 0) return live
    const all = this.store.getStudyNodes(gameId)
    if (all.length === 0) return []
    const children = new Map<string | null, StudyNode[]>()
    for (const node of all) children.set(node.parentId, [...(children.get(node.parentId) ?? []), node])
    const root = (children.get(null) ?? []).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
    if (!root) return []
    const line = [root]
    let cursor = root
    while (true) {
      const next = (children.get(cursor.id) ?? [])
        .filter((node) => node.source === 'import' || node.source === 'variation')
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
      if (!next) break
      line.push(next)
      cursor = next
    }
    return line
  }

  private reviewNodesForJob(job: ReviewJob): StudyNode[] {
    const byId = new Map(this.store.getStudyNodes(job.gameId).map((node) => [node.id, node]))
    const nodes = job.nodeIds.map((nodeId) => byId.get(nodeId)).filter((node): node is StudyNode => Boolean(node))
    if (nodes.length !== job.nodeIds.length) {
      const failed = this.store.updateReviewJob(job.gameId, { status: 'failed', message: '复盘节点快照已损坏，无法继续' })
      this.emit({ type: 'review', value: failed })
      return []
    }
    return nodes
  }

  private resumePendingReview(): void {
    const gameId = this.pendingReviewGameId
    this.pendingReviewGameId = null
    if (gameId) this.scheduleReviewContinuation(gameId)
  }

  private scheduleReviewContinuation(gameId: string): void {
    queueMicrotask(() => {
      try {
        this.continueReview(gameId)
      } catch (error) {
        this.failBackgroundReview(gameId, error)
      }
    })
  }

  private failBackgroundReview(gameId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : '后台复盘任务失败'
    try {
      const job = this.store.getReviewJob(gameId)
      if (!job || job.status !== 'running') return
      const failed = this.store.updateReviewJob(gameId, {
        status: 'failed',
        message: `后台复盘任务失败：${message}`,
      })
      this.emit({ type: 'review', value: failed })
    } catch (statusError) {
      console.error('Unable to persist failed Study review state', statusError)
    }
  }

  private setPendingReview(gameId: string): void {
    if (this.pendingReviewGameId && this.pendingReviewGameId !== gameId) {
      const paused = this.store.updateReviewJob(this.pendingReviewGameId, { status: 'paused', message: '已被另一盘复盘任务暂停' })
      this.emit({ type: 'review', value: paused })
    }
    this.pendingReviewGameId = gameId
  }

  private stopEngine(): void {
    this.suppressStopped = true
    try {
      this.engine.stop()
    } finally {
      this.suppressStopped = false
    }
  }

  private requireNode(nodeId: string): StudyNode {
    const node = this.store.getStudyNode(nodeId)
    if (!node) throw new Error('Study node does not exist')
    return node
  }

  private requireEngine(): EngineDescriptor {
    const descriptor = this.engine.getEngine()
    if (!descriptor) throw new Error('Choose a Pikafish engine before study analysis')
    return descriptor
  }

  private emitAnalysis(
    nodeId: string,
    state: Parameters<typeof this.emitAnalysisState>[1],
    message: string,
    lines: AnalysisInfo[],
    bestMove: string | null,
  ): void {
    this.emitAnalysisState(nodeId, state, message, lines, bestMove)
  }

  private emitAnalysisState(
    nodeId: string,
    state: 'STARTING' | 'ANALYZING' | 'STOPPED' | 'RESTARTING' | 'FAILED' | 'CACHED' | 'COMPLETE',
    message: string,
    lines: AnalysisInfo[],
    bestMove: string | null,
  ): void {
    this.emit({ type: 'analysis', value: { nodeId, state, message, lines: [...lines], bestMove } })
  }

  private emit(event: StudyEvent): void {
    if (this.disposed) return
    for (const listener of this.listeners) listener(event)
  }
}
