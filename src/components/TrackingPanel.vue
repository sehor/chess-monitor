<script setup lang="ts">
import { DEFAULT_POSITION } from '@west-shell/xiangqi.js'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { Orientation, Side } from '../domain/position'
import { RECOGNITION_CLASSES, type RecognitionClass } from '../domain/recognition'
import type { IpcResult, RecognitionSnapshot, RealtimeSnapshot } from '../shared/ipc'
import RealtimeAnalysisPanel from './RealtimeAnalysisPanel.vue'

const props = defineProps<{ ready: boolean; orientation: Orientation }>()

const fen = ref(DEFAULT_POSITION)
const snapshot = ref<RealtimeSnapshot | null>(null)
const multiPv = ref(3)
const depth = ref(16)
const isBusy = ref(false)
const errorMessage = ref<string | null>(null)
const statusMessage = ref<string | null>(null)
const recognition = ref<RecognitionSnapshot | null>(null)
const recognitionSide = ref<Side>('red')
const recognitionCorrections = ref<Record<number, RecognitionClass>>({})
const recognitionBusy = ref(false)
let removeListener: (() => void) | undefined
let suggestedSidePositionKey: string | null = null

const isActive = computed(() => Boolean(snapshot.value?.gameId))
const candidates = computed(() => {
  const state = snapshot.value?.trackerState
  return state && (state.status === 'MOVE_CANDIDATE' || state.status === 'DESYNC') ? state.candidates : []
})
const recognitionCandidates = computed(() => recognition.value?.evaluation?.candidates ?? [])
const lowConfidencePoints = computed(() => recognition.value?.evaluation?.lowConfidencePoints ?? [])

function setSnapshot(value: RealtimeSnapshot): void {
  snapshot.value = value
  if (!value.position) return
  fen.value = value.position.fen
  const positionKey = `${value.gameId ?? 'none'}:${value.position.positionVersion}`
  if (positionKey !== suggestedSidePositionKey) {
    recognitionSide.value = value.position.sideToMove
    suggestedSidePositionKey = positionKey
  }
}

function accept(result: IpcResult<RealtimeSnapshot>, message?: string): void {
  if (!result.ok) {
    errorMessage.value = result.error.message
    return
  }
  setSnapshot(result.value)
  errorMessage.value = null
  statusMessage.value = message ?? null
}

async function start(): Promise<void> {
  isBusy.value = true
  accept(await window.chessMonitor.realtime.start({
    fen: fen.value,
    orientation: props.orientation,
    settings: { multiPv: multiPv.value, depth: depth.value },
  }))
  isBusy.value = false
}

async function pauseOrResume(): Promise<void> {
  isBusy.value = true
  const isPaused = snapshot.value?.monitoringState === 'PAUSED' || snapshot.value?.monitoringState === 'ERROR'
  accept(
    isPaused ? await window.chessMonitor.realtime.resume() : await window.chessMonitor.realtime.pause(),
    isPaused ? '监控已恢复，仅分析当前最新局面。' : '监控已暂停。',
  )
  isBusy.value = false
}

async function resync(): Promise<void> {
  isBusy.value = true
  accept(await window.chessMonitor.realtime.resync(fen.value), '已提交重同步局面。')
  isBusy.value = false
}

function acceptRecognition(result: IpcResult<RecognitionSnapshot>): boolean {
  if (!result.ok) {
    errorMessage.value = result.error.message
    return false
  }
  recognition.value = result.value
  errorMessage.value = null
  recognitionCorrections.value = {}
  const best = result.value.evaluation?.candidates[0]
  if (best) {
    for (const point of result.value.evaluation?.lowConfidencePoints ?? []) {
      recognitionCorrections.value[point] = best.points[point]?.label ?? '_'
    }
  }
  return true
}

async function scanRecognition(): Promise<void> {
  recognitionBusy.value = true
  try {
    const result = await window.chessMonitor.recognition.scan({
      orientation: snapshot.value?.position?.orientation ?? props.orientation,
      sideToMove: recognitionSide.value,
    })
    if (acceptRecognition(result)) statusMessage.value = recognition.value?.message ?? null
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '完整棋盘识别失败'
  } finally {
    recognitionBusy.value = false
  }
}

async function applyRecognitionCorrections(): Promise<void> {
  recognitionBusy.value = true
  try {
    const result = await window.chessMonitor.recognition.correct(
      lowConfidencePoints.value.map((point) => ({
        point,
        label: recognitionCorrections.value[point] ?? '_',
      })),
    )
    if (acceptRecognition(result)) statusMessage.value = recognition.value?.message ?? null
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '识别修正失败'
  } finally {
    recognitionBusy.value = false
  }
}

async function commitRecognition(candidateFen: string): Promise<void> {
  recognitionBusy.value = true
  try {
    const result = await window.chessMonitor.recognition.commit({
      fen: candidateFen,
      settings: { multiPv: multiPv.value, depth: depth.value },
    })
    if (!result.ok) {
      errorMessage.value = result.error.message
    } else {
      recognition.value = result.value.recognition
      setSnapshot(result.value.realtime)
      errorMessage.value = null
      statusMessage.value = result.value.recognition.message
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '识别局面提交失败'
  } finally {
    recognitionBusy.value = false
  }
}

async function confirmCandidate(move: string): Promise<void> {
  isBusy.value = true
  accept(await window.chessMonitor.realtime.confirmCandidate(move), `已手动确认 ${move}。`)
  isBusy.value = false
}

async function undo(): Promise<void> {
  isBusy.value = true
  accept(await window.chessMonitor.realtime.undo(), '已撤销最近确认。')
  isBusy.value = false
}

async function stop(): Promise<void> {
  isBusy.value = true
  accept(await window.chessMonitor.realtime.stop(), '本局监控已结束。')
  isBusy.value = false
}

async function configure(): Promise<void> {
  if (!isActive.value) return
  accept(await window.chessMonitor.realtime.configure({ multiPv: multiPv.value, depth: depth.value }))
}

async function selectEngine(): Promise<void> {
  const result = await window.chessMonitor.analysis.selectEngine()
  if (!result.ok) errorMessage.value = result.error.message
  else if (result.value) statusMessage.value = `已选择 ${result.value.name}`
}

async function retryAnalysis(): Promise<void> {
  accept(await window.chessMonitor.realtime.retryAnalysis())
}

async function exportDiagnostics(): Promise<void> {
  const result = await window.chessMonitor.tracker.exportDiagnostics()
  if (!result.ok) errorMessage.value = result.error.message
  else statusMessage.value = `跟踪诊断已导出：${result.value.fileName}`
}

onMounted(async () => {
  removeListener = window.chessMonitor.realtime.onEvent((value) => {
    setSnapshot(value)
  })
  const recognitionResult = await window.chessMonitor.recognition.getState()
  acceptRecognition(recognitionResult)

  const result = await window.chessMonitor.realtime.getState()
  if (result.ok) {
    setSnapshot(result.value)
    multiPv.value = result.value.settings.multiPv
    depth.value = result.value.settings.depth
  } else errorMessage.value = result.error.message
})
onBeforeUnmount(() => removeListener?.())
</script>

<template>
  <section class="tracking-panel" aria-labelledby="tracking-title">
    <div class="section-heading">
      <div>
        <p class="eyebrow">阶段 5 · 完整识别与失步恢复</p>
        <h2 id="tracking-title">棋盘识别、跟踪与 Pikafish</h2>
      </div>
      <span class="status-pill" :class="{ warning: snapshot?.monitoringState === 'DESYNC' || snapshot?.monitoringState === 'ERROR' }">
        {{ snapshot?.monitoringState ?? 'IDLE' }}
      </span>
    </div>

    <div class="realtime-controls">
      <label class="tracking-fen" for="tracking-fen">
        初始 / 重同步 FEN
        <input id="tracking-fen" v-model="fen" maxlength="512" spellcheck="false" autocomplete="off" />
      </label>
      <label for="live-multipv">变化数
        <select id="live-multipv" v-model.number="multiPv" @change="configure">
          <option v-for="count in 5" :key="count" :value="count">{{ count }}</option>
        </select>
      </label>
      <label for="live-depth">目标深度
        <input id="live-depth" v-model.number="depth" type="number" min="1" max="128" @change="configure" />
      </label>
    </div>

    <div class="action-row">
      <button type="button" class="primary-action" :disabled="!ready || isBusy || isActive" @click="start">开始监控</button>
      <button type="button" class="secondary-action" :disabled="!isActive || isBusy" @click="pauseOrResume">
        {{ snapshot?.monitoringState === 'PAUSED' || snapshot?.monitoringState === 'ERROR' ? '恢复' : '暂停' }}
      </button>
      <button type="button" class="secondary-action" :disabled="!isActive || isBusy" @click="resync">手动重同步</button>
      <button type="button" class="secondary-action" :disabled="!snapshot?.position?.moveHistory.length || isBusy" @click="undo">撤销</button>
      <button type="button" class="secondary-action" :disabled="!isActive" @click="selectEngine">选择引擎</button>
      <button type="button" class="secondary-action" :disabled="!isActive || snapshot?.monitoringState === 'DESYNC'" @click="retryAnalysis">重试引擎</button>
      <button type="button" class="secondary-action" :disabled="!isActive" @click="exportDiagnostics">导出诊断</button>
      <button type="button" class="secondary-action" :disabled="!isActive" @click="stop">结束本局</button>
    </div>

    <p v-if="!ready" class="status-message">请先激活有效 Profile、启动预览并完成两点校准。</p>
    <p v-if="snapshot" class="status-message" role="status">{{ snapshot.monitoringMessage }}</p>
    <p v-if="errorMessage" class="error-message" role="alert">{{ errorMessage }}</p>
    <p v-if="statusMessage" class="status-message" role="status">{{ statusMessage }}</p>

    <section class="recognition-panel" aria-labelledby="recognition-title">
      <div class="section-heading compact-heading">
        <div>
          <p class="eyebrow">Recognition Worker</p>
          <h3 id="recognition-title">完整棋盘识别</h3>
        </div>
        <span class="status-pill" :class="{ warning: recognition?.state === 'ERROR' || recognition?.state === 'REJECTED' || recognition?.state === 'NEEDS_CORRECTION' }">
          {{ recognition?.state ?? 'IDLE' }}
        </span>
      </div>
      <p class="status-message">
        {{ recognition?.message ?? '等待稳定棋盘帧' }} · 稳定帧 {{ recognition?.bufferedFrameCount ?? 0 }}/2
        <template v-if="recognition?.modelVersion"> · 模型 {{ recognition.modelVersion }}</template>
      </p>
      <div class="action-row">
        <label for="recognition-side">当前屏幕局面的行棋方
          <select id="recognition-side" v-model="recognitionSide">
            <option value="red">红方</option>
            <option value="black">黑方</option>
          </select>
        </label>
        <button type="button" class="primary-action" :disabled="!ready || recognitionBusy" @click="scanRecognition">
          {{ isActive ? '完整重扫' : '识别当前局面' }}
        </button>
      </div>

      <div v-if="lowConfidencePoints.length" class="recognition-corrections">
        <p class="status-message">低置信度交叉点：{{ lowConfidencePoints.join(', ') }}。确认这些点后重新校验候选。</p>
        <div class="recognition-point-grid">
          <label v-for="point in lowConfidencePoints" :key="point" :for="`recognition-point-${point}`">
            #{{ point }}
            <select :id="`recognition-point-${point}`" v-model="recognitionCorrections[point]">
              <option v-for="label in RECOGNITION_CLASSES" :key="label" :value="label">{{ label === '_' ? '空' : label }}</option>
            </select>
          </label>
        </div>
        <button type="button" class="secondary-action" :disabled="recognitionBusy" @click="applyRecognitionCorrections">应用修正并重新校验</button>
      </div>

      <ol v-if="recognitionCandidates.length" class="candidate-list" aria-label="识别候选局面">
        <li v-for="candidate in recognitionCandidates" :key="candidate.fen">
          <code>{{ candidate.fen }}</code>
          <span>整盘 {{ candidate.boardConfidence.toFixed(4) }} · 最低点 {{ candidate.minimumConfidence.toFixed(4) }}</span>
          <button
            type="button"
            class="secondary-action"
            :disabled="recognition?.state !== 'READY' || recognitionBusy"
            @click="commitRecognition(candidate.fen)"
          >安全提交</button>
        </li>
      </ol>
    </section>

    <ol v-if="candidates.length" class="candidate-list" aria-label="候选着法">
      <li v-for="candidate in candidates" :key="candidate.move">
        <code>{{ candidate.move }}</code>
        <span>置信度 {{ candidate.confidence.toFixed(3) }}</span>
        <button type="button" class="secondary-action" :disabled="isBusy" @click="confirmCandidate(candidate.move)">手动确认</button>
      </li>
    </ol>

    <RealtimeAnalysisPanel v-if="snapshot?.position" :snapshot="snapshot" />

    <ol v-if="snapshot?.confirmedMoves.length" class="confirmed-list" aria-label="已确认着法">
      <li v-for="event in snapshot.confirmedMoves" :key="`${event.positionVersion}-${event.confirmedAt}`">
        <strong>{{ event.positionVersion }}. {{ event.move }}</strong>
        <small>{{ event.positionHash }} · {{ event.confirmation === 'automatic' ? '自动' : '手动' }}</small>
      </li>
    </ol>
  </section>
</template>
