<script setup lang="ts">
import { DEFAULT_POSITION } from '@west-shell/xiangqi.js'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { BoardTrackerSnapshot, MoveConfirmedEvent, TrackerStatus } from '../domain/board-tracker'
import type { Orientation } from '../domain/position'

const props = defineProps<{ ready: boolean; orientation: Orientation }>()

const fen = ref(DEFAULT_POSITION)
const snapshot = ref<BoardTrackerSnapshot | null>(null)
const confirmedMoves = ref<MoveConfirmedEvent[]>([])
const isBusy = ref(false)
const errorMessage = ref<string | null>(null)
const statusMessage = ref<string | null>(null)
let removeListener: (() => void) | undefined

const statusLabels: Record<TrackerStatus, string> = {
  NO_BOARD: '无棋盘',
  CALIBRATING: '需要校准',
  STABLE: '稳定监控',
  MOVE_ANIMATING: '等待动画结束',
  MOVE_CANDIDATE: '候选待确认',
  MOVE_CONFIRMED: '着法已确认',
  DESYNC: '已失步',
  RESCANNING: '正在重同步',
}
const statusLabel = computed(() => snapshot.value ? statusLabels[snapshot.value.state.status] : '未启动')

async function refresh(): Promise<void> {
  const result = await window.chessMonitor.tracker.getState()
  if (result.ok) snapshot.value = result.value
}

async function start(): Promise<void> {
  isBusy.value = true
  errorMessage.value = null
  statusMessage.value = null
  const result = await window.chessMonitor.tracker.start({ fen: fen.value, orientation: props.orientation })
  isBusy.value = false
  if (!result.ok) return void (errorMessage.value = result.error.message)
  snapshot.value = result.value
  confirmedMoves.value = []
}

async function stop(): Promise<void> {
  const result = await window.chessMonitor.tracker.stop()
  if (!result.ok) return void (errorMessage.value = result.error.message)
  snapshot.value = null
}

async function resync(): Promise<void> {
  isBusy.value = true
  const result = await window.chessMonitor.tracker.resync(fen.value)
  isBusy.value = false
  if (!result.ok) return void (errorMessage.value = result.error.message)
  snapshot.value = result.value
  errorMessage.value = null
  statusMessage.value = '已提交重同步，等待画面重新稳定。'
}

async function confirmCandidate(move: string): Promise<void> {
  isBusy.value = true
  errorMessage.value = null
  const result = await window.chessMonitor.tracker.confirmCandidate(move)
  isBusy.value = false
  if (!result.ok) return void (errorMessage.value = result.error.message)
  snapshot.value = result.value
  fen.value = result.value.position.fen
  statusMessage.value = `已手动确认 ${move}。`
}

async function undo(): Promise<void> {
  isBusy.value = true
  errorMessage.value = null
  const result = await window.chessMonitor.tracker.undo()
  isBusy.value = false
  if (!result.ok) return void (errorMessage.value = result.error.message)
  snapshot.value = result.value
  fen.value = result.value.position.fen
  confirmedMoves.value = confirmedMoves.value.slice(0, -1)
  statusMessage.value = '已撤销最近确认，等待画面重新稳定。'
}

async function exportDiagnostics(): Promise<void> {
  const result = await window.chessMonitor.tracker.exportDiagnostics()
  if (!result.ok) return void (errorMessage.value = result.error.message)
  errorMessage.value = null
  statusMessage.value = `跟踪诊断已导出：${result.value.fileName}`
}

onMounted(() => {
  removeListener = window.chessMonitor.tracker.onEvent((event) => {
    if (event.type === 'move-confirmed') {
      confirmedMoves.value = [...confirmedMoves.value.slice(-19), event]
      fen.value = event.fen
    }
    void refresh()
  })
  void refresh()
})
onBeforeUnmount(() => removeListener?.())
</script>

<template>
  <section class="tracking-panel" aria-labelledby="tracking-title">
    <div class="section-heading">
      <div>
        <p class="eyebrow">阶段 3 · 轻量跟踪</p>
        <h2 id="tracking-title">ROI 变化 → 唯一合法着法</h2>
      </div>
      <span class="status-pill">{{ statusLabel }}</span>
    </div>

    <label class="tracking-fen" for="tracking-fen">
      初始/重同步 FEN
      <input id="tracking-fen" v-model="fen" maxlength="512" spellcheck="false" />
    </label>
    <div class="action-row">
      <button type="button" class="primary-action" :disabled="!ready || isBusy || Boolean(snapshot)" @click="start">开始监控</button>
      <button type="button" class="secondary-action" :disabled="!snapshot || isBusy" @click="resync">手动重同步</button>
      <button type="button" class="secondary-action" :disabled="!snapshot?.position.moveHistory.length || isBusy" @click="undo">撤销最近确认</button>
      <button type="button" class="secondary-action" :disabled="!snapshot" @click="stop">停止</button>
      <button type="button" class="secondary-action" :disabled="!snapshot" @click="exportDiagnostics">导出诊断</button>
    </div>

    <p v-if="!ready" class="status-message">请先激活有效 Profile、启动预览并恢复两点校准。</p>
    <p v-if="errorMessage" class="error-message" role="alert">{{ errorMessage }}</p>
    <p v-if="statusMessage" class="status-message" role="status">{{ statusMessage }}</p>
    <p v-if="snapshot" class="status-message" role="status">
      已处理 {{ snapshot.observationCount }} 帧；确认 {{ snapshot.confirmedMoveCount }} 着；当前版本 {{ snapshot.position.positionVersion }}。
    </p>

    <ol v-if="snapshot?.candidates.length" class="candidate-list" aria-label="候选着法">
      <li v-for="candidate in snapshot.candidates" :key="candidate.move">
        <code>{{ candidate.move }}</code>
        <span>置信度 {{ candidate.confidence.toFixed(3) }}</span>
        <span>未解释点 {{ candidate.unexplainedPointCount }}</span>
        <button
          type="button"
          class="secondary-action"
          :disabled="isBusy || !['MOVE_CANDIDATE', 'DESYNC'].includes(snapshot?.state.status ?? '')"
          @click="confirmCandidate(candidate.move)"
        >手动确认</button>
      </li>
    </ol>
    <ol v-if="confirmedMoves.length" class="confirmed-list" aria-label="已确认着法">
      <li v-for="event in confirmedMoves" :key="`${event.positionVersion}-${event.confirmedAt}`">
        <strong>{{ event.positionVersion }}. {{ event.move }}</strong>
        <small>{{ event.positionHash }}</small>
      </li>
    </ol>
  </section>
</template>
