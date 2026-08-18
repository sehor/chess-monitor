<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { RulesAdapter, type IccsMove } from '../domain/game'
import type { PositionSnapshot } from '../domain/position'
import type { AnalysisInfo, AnalysisState, EngineDescriptor } from '../shared/ipc'
import XiangqiBoard from './XiangqiBoard.vue'

const game = new RulesAdapter()
const position = ref<PositionSnapshot>(game.snapshot())
const fenInput = ref(position.value.fen)
const errorMessage = ref<string | null>(null)
const legalMoves = computed(() => game.legalMoves())
const engineState = ref<AnalysisState>('STOPPED')
const engineMessage = ref('请选择 Pikafish 引擎')
const engine = ref<EngineDescriptor | null>(null)
const analysisLines = ref<AnalysisInfo[]>([])
const bestMove = ref<IccsMove | null>(null)
const multiPv = ref(3)
const displayedBestMove = computed(() => bestMove.value ?? analysisLines.value[0]?.pv[0] as IccsMove | undefined)
let unsubscribe: (() => void) | undefined

function updatePosition(nextPosition: PositionSnapshot): void {
  position.value = nextPosition
  fenInput.value = nextPosition.fen
  errorMessage.value = null
  analysisLines.value = []
  bestMove.value = null
  void startAnalysis()
}

async function startAnalysis(): Promise<void> {
  if (!engine.value) return
  const result = await window.chessMonitor.analysis.start({
    fen: position.value.fen,
    positionVersion: position.value.positionVersion,
    multiPv: multiPv.value,
  })
  if (!result.ok) {
    engineState.value = 'FAILED'
    engineMessage.value = result.error.message
  }
}

async function selectEngine(): Promise<void> {
  const result = await window.chessMonitor.analysis.selectEngine()
  if (!result.ok) {
    engineState.value = 'FAILED'
    engineMessage.value = result.error.message
    return
  }
  if (!result.value) return

  engine.value = result.value
  engineState.value = 'STOPPED'
  engineMessage.value = `已选择 ${result.value.name}`
  void startAnalysis()
}

async function retryAnalysis(): Promise<void> {
  analysisLines.value = []
  bestMove.value = null
  const result = await window.chessMonitor.analysis.retry()
  if (!result.ok) {
    engineState.value = 'FAILED'
    engineMessage.value = result.error.message
  }
}

async function stopAnalysis(): Promise<void> {
  const result = await window.chessMonitor.analysis.stop()
  if (!result.ok) {
    engineState.value = 'FAILED'
    engineMessage.value = result.error.message
  }
}

function applyFen(): void {
  try {
    updatePosition(game.reset(fenInput.value))
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '无法应用 FEN。'
  }
}

function applyMove(move: IccsMove): void {
  try {
    updatePosition(game.apply(move))
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '该走法不可用。'
  }
}

function undo(): void {
  updatePosition(game.undo())
}

function resetGame(): void {
  updatePosition(game.reset())
}

function flipOrientation(): void {
  position.value = game.setOrientation(
    position.value.orientation === 'red-bottom' ? 'black-bottom' : 'red-bottom',
  )
}

onMounted(async () => {
  unsubscribe = window.chessMonitor.analysis.onEvent((event) => {
    const eventVersion = event.type === 'info' ? event.value.positionVersion : event.positionVersion
    if (eventVersion !== position.value.positionVersion) return

    if (event.type === 'state') {
      engineState.value = event.state
      const stateMessages: Record<AnalysisState, string> = {
        STARTING: '正在启动引擎',
        ANALYZING: '正在分析当前局面',
        STOPPED: '分析已停止',
        RESTARTING: '引擎异常，正在自动恢复',
        FAILED: '引擎恢复失败，请手动重试',
      }
      engineMessage.value = event.message ?? stateMessages[event.state]
      return
    }

    if (event.type === 'bestmove') {
      bestMove.value = event.move && /^[a-i][0-9][a-i][0-9]$/.test(event.move)
        ? event.move as IccsMove
        : null
      return
    }

    const index = event.value.multiPv - 1
    analysisLines.value[index] = event.value
  })
  const result = await window.chessMonitor.analysis.getEngine()
  if (result.ok && result.value) {
    engine.value = result.value
    engineMessage.value = `已选择 ${result.value.name}`
    void startAnalysis()
  }
})

onBeforeUnmount(() => {
  unsubscribe?.()
  void window.chessMonitor.analysis.stop()
})
</script>

<template>
  <section class="analysis-workspace" aria-labelledby="analysis-title">
    <header class="workspace-header">
      <div>
        <p class="eyebrow">阶段 1 · 本地分析底座</p>
        <h1 id="analysis-title">局面与合法走子</h1>
      </div>
      <div class="engine-controls">
        <p class="engine-status" role="status">{{ engineMessage }}</p>
        <button type="button" class="secondary-action" @click="selectEngine">选择引擎</button>
        <label class="compact-field" for="multipv">变化数
          <select id="multipv" v-model.number="multiPv" @change="startAnalysis">
            <option v-for="count in 5" :key="count" :value="count">{{ count }}</option>
          </select>
        </label>
        <button type="button" class="secondary-action" @click="stopAnalysis">停止</button>
        <button type="button" class="secondary-action" @click="retryAnalysis">重试引擎</button>
      </div>
    </header>

    <form class="fen-form" @submit.prevent="applyFen">
      <label for="fen">FEN</label>
      <input id="fen" v-model="fenInput" spellcheck="false" autocomplete="off" />
      <button type="submit" class="primary-action">应用局面</button>
    </form>
    <p v-if="errorMessage" class="error-message" role="alert">{{ errorMessage }}</p>

    <div class="analysis-layout">
      <XiangqiBoard :position="position" :legal-moves="legalMoves" :best-move="displayedBestMove" @move="applyMove" />
      <aside class="position-panel" aria-label="局面信息">
        <dl>
          <div><dt>当前行棋方</dt><dd>{{ position.sideToMove === 'red' ? '红方' : '黑方' }}</dd></div>
          <div><dt>局面版本</dt><dd>{{ position.positionVersion }}</dd></div>
          <div><dt>最近着法</dt><dd>{{ position.lastMove ?? '—' }}</dd></div>
          <div><dt>着法数</dt><dd>{{ position.moveHistory.length }}</dd></div>
        </dl>
        <div class="action-row">
          <button type="button" class="secondary-action" @click="undo">撤销</button>
          <button type="button" class="secondary-action" @click="resetGame">重置</button>
          <button type="button" class="secondary-action" @click="flipOrientation">翻转棋盘</button>
        </div>
        <section class="analysis-lines" aria-labelledby="engine-title">
          <h2 id="engine-title">Pikafish（{{ engineState }}）</h2>
          <p v-if="engine" class="engine-fingerprint">{{ engine.name }} · SHA-256 {{ engine.sha256.slice(0, 12) }}…</p>
          <p v-if="analysisLines.length === 0" class="status-message">尚无分析结果。</p>
          <ol v-else>
            <li v-for="line in analysisLines.filter(Boolean)" :key="line.multiPv">
              <strong>#{{ line.multiPv }}</strong>
              <span>{{ line.score.cp !== undefined ? `${line.score.cp > 0 ? '+' : ''}${line.score.cp} cp` : `将杀 ${line.score.mateIn}` }}</span>
              <span>深度 {{ line.depth }}</span>
              <span>节点 {{ line.nodes ?? '—' }}</span>
              <span>最佳着 {{ line.pv[0] ?? '—' }}</span>
              <code>{{ line.pv.join(' ') }}</code>
            </li>
          </ol>
        </section>
      </aside>
    </div>
  </section>
</template>
