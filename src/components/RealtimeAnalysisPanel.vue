<script setup lang="ts">
import { computed } from 'vue'
import type { IccsMove } from '../domain/game'
import type { RealtimeSnapshot } from '../shared/ipc'
import XiangqiBoard from './XiangqiBoard.vue'

const props = defineProps<{ snapshot: RealtimeSnapshot }>()

const visibleLines = computed(() => props.snapshot.analysis.isTrusted
  && props.snapshot.analysis.positionVersion === props.snapshot.position?.positionVersion
  ? props.snapshot.analysis.lines
  : [])
const bestMove = computed<IccsMove | null>(() => {
  if (visibleLines.value.length === 0) return null
  const move = props.snapshot.analysis.bestMove ?? visibleLines.value[0]?.pv[0]
  return move && /^[a-i][0-9][a-i][0-9]$/.test(move) ? move as IccsMove : null
})
const evaluation = computed(() => visibleLines.value[0]?.score)
const redPercent = computed(() => {
  const score = evaluation.value
  if (!score) return 50
  if (score.mateIn !== undefined) return score.mateIn > 0 ? 100 : 0
  return 50 + Math.max(-45, Math.min(45, (score.cp ?? 0) / 20))
})

function scoreLabel(line: RealtimeSnapshot['analysis']['lines'][number]): string {
  if (line.score.cp !== undefined) return `${line.score.cp > 0 ? '+' : ''}${line.score.cp} cp`
  return `将杀 ${line.score.mateIn}`
}
</script>

<template>
  <div v-if="snapshot.position" class="realtime-analysis-layout">
    <div class="live-board-column">
      <XiangqiBoard
        :position="snapshot.position"
        :legal-moves="[]"
        :best-move="bestMove"
      />
      <div class="evaluation-bar" aria-label="红方视角评估">
        <span class="evaluation-red" :style="{ width: `${redPercent}%` }" />
        <strong>{{ evaluation ? scoreLabel(visibleLines[0]!) : '等待评估' }}</strong>
      </div>
    </div>

    <section class="live-analysis-lines" aria-labelledby="live-analysis-title">
      <div class="section-heading compact-heading">
        <div>
          <p class="eyebrow">当前局面 v{{ snapshot.position.positionVersion }}</p>
          <h3 id="live-analysis-title">Pikafish Top {{ snapshot.settings.multiPv }}</h3>
        </div>
        <span class="status-pill" :class="{ warning: !snapshot.analysis.isTrusted }">
          {{ snapshot.analysis.state }}
        </span>
      </div>
      <p class="status-message" role="status">{{ snapshot.analysis.message }}</p>
      <p v-if="visibleLines.length === 0" class="empty-analysis">当前局面尚无可信分析结果。</p>
      <ol v-else>
        <li v-for="line in visibleLines" :key="`${line.positionVersion}-${line.multiPv}`">
          <div class="analysis-line-heading">
            <strong>#{{ line.multiPv }} · {{ scoreLabel(line) }}</strong>
            <span>深度 {{ line.depth }} · 节点 {{ line.nodes ?? '—' }}</span>
          </div>
          <code>{{ line.pv.length ? line.pv.join(' ') : 'PV 不完整' }}</code>
        </li>
      </ol>
    </section>
  </div>
</template>
