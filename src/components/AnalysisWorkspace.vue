<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { DEFAULT_POSITION } from '@west-shell/xiangqi.js'
import { RulesAdapter, type IccsMove } from '../domain/game'
import { createPositionSnapshot, type Orientation, type PositionSnapshot } from '../domain/position'
import type { AnalysisInfo, EngineDescriptor, RealtimeSnapshot } from '../shared/ipc'
import type { StudyEvent, StudyGameSummary, StudyNode, StudySnapshot } from '../shared/study'
import EvaluationCurve from './EvaluationCurve.vue'
import StudyTree from './StudyTree.vue'
import XiangqiBoard from './XiangqiBoard.vue'

const games = ref<StudyGameSummary[]>([])
const study = ref<StudySnapshot | null>(null)
const selectedNodeId = ref<string | null>(null)
const followingLive = ref(true)
const realtime = ref<RealtimeSnapshot | null>(null)
const orientation = ref<Orientation>('red-bottom')
const fenDraft = ref(DEFAULT_POSITION)
const importExportText = ref('')
const message = ref('选择已保存棋局，或导入 FEN / ICCS 棋谱开始研究。')
const errorMessage = ref<string | null>(null)
const engine = ref<EngineDescriptor | null>(null)
const multiPv = ref(1)
const depth = ref(16)
const activeAnalysisNodeId = ref<string | null>(null)
const activeAnalysisLines = ref<AnalysisInfo[]>([])
const activeBestMove = ref<string | null>(null)
const activeAnalysisMessage = ref('尚未分析当前节点')
let unsubscribeStudy: (() => void) | undefined
let unsubscribeRealtime: (() => void) | undefined

const selectedNode = computed(() => study.value?.nodes.find((node) => node.id === selectedNodeId.value) ?? null)
const liveNode = computed(() => {
  const current = study.value
  if (!current) return null
  const liveVersion = realtime.value?.gameId === current.game.id
    ? realtime.value.position?.positionVersion
    : current.game.currentVersion
  return current.nodes.find((node) => node.livePositionVersion === liveVersion) ??
    [...current.nodes].reverse().find((node) => node.livePositionVersion !== null) ?? null
})
const isViewingHistory = computed(() => Boolean(
  realtime.value?.gameId === study.value?.game.id && selectedNode.value && selectedNode.value.id !== liveNode.value?.id,
))
const position = computed<PositionSnapshot | null>(() => {
  const node = selectedNode.value
  if (!node) return null
  return {
    ...createPositionSnapshot(node.fen, node.ply, orientation.value),
    lastMove: node.move,
    moveHistory: branchMoves(node.id),
  }
})
const legalMoves = computed<IccsMove[]>(() => {
  if (!selectedNode.value) return []
  try {
    return new RulesAdapter(selectedNode.value.fen).legalMoves()
  } catch {
    return []
  }
})
const storedAnalysis = computed(() => {
  if (!study.value || !selectedNode.value) return null
  return [...study.value.analyses].reverse().find((item) => item.nodeId === selectedNode.value?.id) ?? null
})
const displayedLines = computed(() => activeAnalysisNodeId.value === selectedNodeId.value
  ? activeAnalysisLines.value
  : storedAnalysis.value?.lines ?? [])
const displayedBestMove = computed(() => {
  const raw = activeAnalysisNodeId.value === selectedNodeId.value
    ? activeBestMove.value
    : storedAnalysis.value?.bestMove
  return raw && /^[a-i][0-9][a-i][0-9]$/.test(raw) ? raw as IccsMove : null
})
const review = computed(() => study.value?.review ?? null)
const selectedMark = computed(() => study.value?.marks.find((mark) => mark.nodeId === selectedNodeId.value) ?? null)
const children = computed(() => study.value?.nodes.filter((node) => node.parentId === selectedNodeId.value) ?? [])

function branchMoves(nodeId: string): string[] {
  if (!study.value) return []
  const nodes = new Map(study.value.nodes.map((node) => [node.id, node]))
  const moves: string[] = []
  let cursor = nodes.get(nodeId)
  while (cursor?.parentId) {
    if (cursor.move) moves.push(cursor.move)
    cursor = nodes.get(cursor.parentId)
  }
  return moves.reverse()
}

function selectNode(nodeId: string, follow = false): void {
  const node = study.value?.nodes.find((item) => item.id === nodeId)
  if (!node) return
  selectedNodeId.value = node.id
  followingLive.value = follow || node.id === liveNode.value?.id
  fenDraft.value = node.fen
  errorMessage.value = null
  activeAnalysisNodeId.value = null
  activeAnalysisLines.value = []
  activeBestMove.value = null
  activeAnalysisMessage.value = storedAnalysis.value ? '已加载缓存分析' : '尚未分析当前节点'
}

async function refreshGames(): Promise<void> {
  const result = await window.chessMonitor.study.listGames()
  if (!result.ok) {
    errorMessage.value = result.error.message
    return
  }
  games.value = result.value
}

async function loadStudy(gameId: string, preserveSelection = false): Promise<void> {
  const previousSelection = preserveSelection ? selectedNodeId.value : null
  const result = await window.chessMonitor.study.get(gameId)
  if (!result.ok) {
    errorMessage.value = result.error.message
    return
  }
  study.value = result.value
  orientation.value = result.value.game.orientation
  const preferred = previousSelection && result.value.nodes.some((node) => node.id === previousSelection)
    ? previousSelection
    : result.value.nodes.find((node) => node.livePositionVersion === result.value.game.currentVersion)?.id ?? result.value.nodes.at(-1)?.id ?? null
  if (followingLive.value && liveNode.value) selectNode(liveNode.value.id, true)
  else if (preferred) selectNode(preferred)
  message.value = `已加载 ${result.value.nodes.length} 个局面节点。`
}

async function chooseGame(event: Event): Promise<void> {
  const gameId = (event.target as HTMLSelectElement).value
  if (!gameId) return
  followingLive.value = true
  await loadStudy(gameId)
}

async function applyVariation(move: IccsMove): Promise<void> {
  if (!study.value || !selectedNode.value) return
  const result = await window.chessMonitor.study.createVariation(study.value.game.id, selectedNode.value.id, move)
  if (!result.ok) {
    errorMessage.value = result.error.message
    return
  }
  followingLive.value = false
  await loadStudy(study.value.game.id, true)
  selectNode(result.value.id)
  message.value = `已保存分支着法 ${move}。`
}

async function saveFenDraft(): Promise<void> {
  if (!study.value) {
    importExportText.value = fenDraft.value
    await importRecord()
    return
  }
  const result = await window.chessMonitor.study.createFen(study.value.game.id, fenDraft.value)
  if (!result.ok) {
    errorMessage.value = `草稿保留但未提交：${result.error.message}`
    return
  }
  followingLive.value = false
  await loadStudy(study.value.game.id, true)
  selectNode(result.value.id)
  message.value = 'FEN 已作为独立可信研究节点保存；实时局面未被修改。'
}

async function importRecord(): Promise<void> {
  const text = importExportText.value.trim() || fenDraft.value.trim()
  if (!text) return
  const result = await window.chessMonitor.study.importRecord(text)
  if (!result.ok) {
    errorMessage.value = result.error.message
    return
  }
  study.value = result.value
  followingLive.value = false
  orientation.value = result.value.game.orientation
  const last = result.value.nodes.at(-1)
  if (last) selectNode(last.id)
  await refreshGames()
  message.value = `导入完成：${result.value.nodes.length} 个局面节点。`
}

async function exportBranch(): Promise<void> {
  if (!selectedNode.value) return
  const result = await window.chessMonitor.study.exportBranch(selectedNode.value.id)
  if (!result.ok) {
    errorMessage.value = result.error.message
    return
  }
  importExportText.value = result.value
  message.value = '当前分支已导出到文本框。'
}

async function analyzeSelected(): Promise<void> {
  if (!selectedNode.value) return
  activeAnalysisNodeId.value = selectedNode.value.id
  activeAnalysisLines.value = []
  activeBestMove.value = null
  activeAnalysisMessage.value = '正在提交分析任务…'
  const result = await window.chessMonitor.study.analyze(selectedNode.value.id, { multiPv: multiPv.value, depth: depth.value })
  if (!result.ok) {
    errorMessage.value = result.error.message
    activeAnalysisMessage.value = '分析启动失败'
  } else if (result.value.cached) {
    await loadStudy(study.value!.game.id, true)
    activeAnalysisMessage.value = '已命中分析缓存'
  }
}

async function selectEngine(): Promise<void> {
  const result = await window.chessMonitor.analysis.selectEngine()
  if (!result.ok) {
    errorMessage.value = result.error.message
    return
  }
  if (result.value) {
    engine.value = result.value
    message.value = `已选择 ${result.value.name}；实时与研究使用隔离的引擎进程。`
  }
}

async function startReview(): Promise<void> {
  if (!study.value) return
  const result = await window.chessMonitor.study.startReview(study.value.game.id, { multiPv: multiPv.value, depth: depth.value })
  if (!result.ok) errorMessage.value = result.error.message
  else await loadStudy(study.value.game.id, true)
}

async function pauseReview(): Promise<void> {
  if (!study.value) return
  const result = await window.chessMonitor.study.pauseReview(study.value.game.id)
  if (!result.ok) errorMessage.value = result.error.message
  else await loadStudy(study.value.game.id, true)
}

async function resumeReview(): Promise<void> {
  if (!study.value) return
  const result = await window.chessMonitor.study.resumeReview(study.value.game.id)
  if (!result.ok) errorMessage.value = result.error.message
  else await loadStudy(study.value.game.id, true)
}

function returnLive(): void {
  if (liveNode.value) selectNode(liveNode.value.id, true)
}

function goBack(): void {
  const parentId = selectedNode.value?.parentId
  if (parentId) selectNode(parentId)
}

function goForward(): void {
  if (children.value[0]) selectNode(children.value[0].id)
}

function flipOrientation(): void {
  orientation.value = orientation.value === 'red-bottom' ? 'black-bottom' : 'red-bottom'
}

function scoreLabel(line: AnalysisInfo): string {
  if (line.score.cp !== undefined) return `${line.score.cp > 0 ? '+' : ''}${line.score.cp} cp`
  return `将杀 ${line.score.mateIn}`
}

async function handleStudyEvent(event: StudyEvent): Promise<void> {
  if (event.type === 'analysis') {
    if (event.value.nodeId === selectedNodeId.value) {
      activeAnalysisNodeId.value = event.value.nodeId
      activeAnalysisLines.value = event.value.lines
      activeBestMove.value = event.value.bestMove
      activeAnalysisMessage.value = event.value.message
    }
    return
  }
  if (study.value?.game.id === (event.type === 'study-updated' ? event.gameId : event.value.gameId)) {
    await loadStudy(study.value.game.id, true)
  }
}

watch(liveNode, (next, previous) => {
  if (next && followingLive.value && next.id !== previous?.id) selectNode(next.id, true)
})

onMounted(async () => {
  unsubscribeStudy = window.chessMonitor.study.onEvent((event) => void handleStudyEvent(event))
  unsubscribeRealtime = window.chessMonitor.realtime.onEvent((snapshot) => {
    const oldGameId = realtime.value?.gameId
    realtime.value = snapshot
    if (snapshot.gameId && study.value?.game.id === snapshot.gameId) void loadStudy(snapshot.gameId, true)
    else if (snapshot.gameId && !study.value && snapshot.gameId !== oldGameId) void loadStudy(snapshot.gameId)
  })
  const [engineResult, realtimeResult] = await Promise.all([
    window.chessMonitor.analysis.getEngine(),
    window.chessMonitor.realtime.getState(),
  ])
  if (engineResult.ok) engine.value = engineResult.value
  if (realtimeResult.ok) realtime.value = realtimeResult.value
  await refreshGames()
  const initialGameId = realtime.value?.gameId ?? games.value[0]?.id
  if (initialGameId) await loadStudy(initialGameId)
})

onBeforeUnmount(() => {
  unsubscribeStudy?.()
  unsubscribeRealtime?.()
})
</script>

<template>
  <section class="analysis-workspace study-workspace" aria-labelledby="analysis-title">
    <header class="workspace-header study-header">
      <div>
        <p class="eyebrow">阶段 08 · 高级分析</p>
        <h1 id="analysis-title">变化树与整盘复盘</h1>
        <p class="intro">研究视图不会停止 Board Tracker；历史分析、分支和复盘使用独立研究引擎，不覆盖实时 positionVersion。</p>
      </div>
      <div class="engine-controls">
        <span class="engine-status">{{ engine ? `${engine.name} · ${engine.sha256.slice(0, 10)}…` : '未选择 Pikafish' }}</span>
        <button type="button" class="secondary-action" @click="selectEngine">选择引擎</button>
        <label class="compact-field">深度 <input v-model.number="depth" type="number" min="1" max="128" /></label>
        <label class="compact-field">变化数
          <select v-model.number="multiPv"><option v-for="count in 5" :key="count" :value="count">{{ count }}</option></select>
        </label>
      </div>
    </header>

    <div v-if="isViewingHistory" class="history-banner" role="status">
      <strong>正在查看历史局面</strong>
      <span>实时监控继续接收局面，不会被当前分支或分析覆盖。</span>
      <button type="button" class="primary-action" @click="returnLive">回到实时局面</button>
    </div>

    <div class="study-toolbar">
      <label>已保存棋局
        <select :value="study?.game.id ?? ''" @change="chooseGame">
          <option value="" disabled>选择棋局</option>
          <option v-for="game in games" :key="game.id" :value="game.id">{{ game.id.slice(0, 8) }} · v{{ game.currentVersion }} · {{ game.status }}</option>
        </select>
      </label>
      <button type="button" class="secondary-action" :disabled="!selectedNode?.parentId" @click="goBack">后退</button>
      <button type="button" class="secondary-action" :disabled="children.length === 0" @click="goForward">前进</button>
      <button type="button" class="secondary-action" :disabled="!liveNode" @click="returnLive">当前局面</button>
      <button type="button" class="secondary-action" :disabled="!position" @click="flipOrientation">翻转棋盘</button>
    </div>

    <p class="status-message" role="status">{{ message }}</p>
    <p v-if="errorMessage" class="error-message" role="alert">{{ errorMessage }}</p>

    <div v-if="study && position && selectedNode" class="study-grid">
      <div class="study-board-column">
        <XiangqiBoard :position="position" :legal-moves="legalMoves" :best-move="displayedBestMove" @move="applyVariation" />
        <div class="node-inspector">
          <div><strong>节点</strong><code>{{ selectedNode.id.slice(0, 12) }}</code></div>
          <div><strong>来源</strong><span>{{ selectedNode.source }}</span></div>
          <div><strong>实时版本</strong><span>{{ selectedNode.livePositionVersion ?? '非实时节点' }}</span></div>
          <div><strong>最近着法</strong><span>{{ selectedNode.move ?? '—' }}</span></div>
        </div>
        <div class="action-row">
          <button type="button" class="primary-action" @click="analyzeSelected">单步重分析</button>
          <button type="button" class="secondary-action" @click="exportBranch">导出当前分支</button>
        </div>
        <p class="status-message">{{ activeAnalysisMessage }}</p>
        <ol v-if="displayedLines.length" class="study-analysis-lines">
          <li v-for="line in displayedLines" :key="line.multiPv">
            <strong>#{{ line.multiPv }} · {{ scoreLabel(line) }}</strong>
            <span>深度 {{ line.depth }} · 节点 {{ line.nodes ?? '—' }}</span>
            <code>{{ line.pv.join(' ') || '无合法 PV' }}</code>
          </li>
        </ol>
      </div>

      <StudyTree :nodes="study.nodes" :marks="study.marks" :selected-node-id="selectedNodeId" :live-node-id="liveNode?.id ?? null" @select="selectNode" />
    </div>

    <div class="study-editor-grid">
      <section class="study-editor-card" aria-labelledby="fen-editor-title">
        <h2 id="fen-editor-title">局面 / FEN 编辑器</h2>
        <p>非法 FEN 会保留在草稿中但拒绝提交；保存研究节点不会重同步实时棋局。</p>
        <textarea v-model="fenDraft" rows="4" maxlength="512" spellcheck="false" />
        <button type="button" class="secondary-action" @click="saveFenDraft">校验并保存研究节点</button>
      </section>
      <section class="study-editor-card" aria-labelledby="record-title">
        <h2 id="record-title">棋谱导入 / 导出</h2>
        <p>支持标准 FEN 与离线 <code>CHESS-MONITOR-ICCS 1</code>；其他格式和字段会明确拒绝。</p>
        <textarea v-model="importExportText" rows="7" maxlength="1048576" spellcheck="false" placeholder="粘贴 FEN 或 CHESS-MONITOR-ICCS 1 棋谱" />
        <div class="action-row">
          <button type="button" class="secondary-action" @click="importRecord">导入并自动保存</button>
          <button type="button" class="secondary-action" :disabled="!selectedNode" @click="exportBranch">导出选中分支</button>
        </div>
      </section>
    </div>

    <EvaluationCurve v-if="study" :nodes="study.nodes" :analyses="study.analyses" :selected-node-id="selectedNodeId" @select="selectNode" />

    <section v-if="study" class="review-card" aria-labelledby="review-title">
      <div class="section-heading-row">
        <div>
          <h2 id="review-title">整盘复盘队列</h2>
          <p>顺序分析、单并发、可暂停并从 nextIndex 断点继续；交互分析可抢占且不会推进断点。</p>
        </div>
        <span v-if="review">{{ review.completedNodes }}/{{ review.totalNodes }} · {{ review.status }}</span>
      </div>
      <div class="action-row">
        <button type="button" class="primary-action" @click="startReview">开始 / 重新复盘</button>
        <button type="button" class="secondary-action" :disabled="review?.status !== 'running'" @click="pauseReview">暂停</button>
        <button type="button" class="secondary-action" :disabled="review?.status !== 'paused' && review?.status !== 'failed'" @click="resumeReview">继续</button>
      </div>
      <p v-if="review" class="status-message">{{ review.message }}</p>
      <div v-if="study.marks.length" class="mark-list">
        <article v-for="mark in study.marks" :key="mark.nodeId" :class="['move-quality-mark', mark.kind]">
          <strong>{{ mark.kind === 'blunder' ? '漏着' : '疑问手' }} · {{ mark.actualMove }}</strong>
          <span>最佳着 {{ mark.bestMove }} · {{ mark.mateSwing ? '进入强制将杀' : `损失 ${mark.lossCp} cp` }}</span>
          <p>{{ mark.explanation }}</p>
        </article>
      </div>
      <p v-else class="empty-analysis">复盘完成后，将按 ≥80 cp 标记疑问手、≥180 cp 标记漏着；进入不利强制将杀直接标记为漏着。</p>
      <article v-if="selectedMark" class="selected-mark-detail">
        <strong>当前节点标记说明</strong>
        <p>{{ selectedMark.explanation }}</p>
      </article>
    </section>
  </section>
</template>
