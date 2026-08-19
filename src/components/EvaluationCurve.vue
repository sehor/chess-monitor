<script setup lang="ts">
import { computed } from 'vue'
import { studyBranchToNode } from '../domain/study'
import type { StudyAnalysis, StudyNode } from '../shared/study'

const props = defineProps<{
  nodes: StudyNode[]
  analyses: StudyAnalysis[]
  selectedNodeId: string | null
}>()

const emit = defineEmits<{ select: [nodeId: string] }>()

interface CurvePoint {
  node: StudyNode
  analysis: StudyAnalysis
  cp: number
  x: number
  y: number
}

const branchNodes = computed<StudyNode[]>(() => {
  return studyBranchToNode(props.nodes, props.selectedNodeId)
})

const points = computed<CurvePoint[]>(() => {
  const byNode = new Map(props.analyses.filter((item) => item.nodeId).map((item) => [item.nodeId!, item]))
  const raw = branchNodes.value.flatMap((node) => {
    const analysis = byNode.get(node.id)
    const cp = analysis?.lines.find((line) => line.multiPv === 1)?.score.cp
    return analysis && cp !== undefined ? [{ node, analysis, cp }] : []
  })
  if (raw.length === 0) return []
  const stride = Math.max(1, Math.ceil(raw.length / 200))
  const sampled = raw.filter((_item, index) => index % stride === 0 || index === raw.length - 1)
  const limit = Math.max(100, ...sampled.map((item) => Math.abs(item.cp)))
  return sampled.map((item, index) => ({
    ...item,
    x: sampled.length === 1 ? 50 : (index / (sampled.length - 1)) * 100,
    y: 50 - (Math.max(-limit, Math.min(limit, item.cp)) / limit) * 46,
  }))
})

const polyline = computed(() => points.value.map((point) => `${point.x},${point.y}`).join(' '))
const mateNodes = computed(() => {
  const byNode = new Map(props.analyses.filter((item) => item.nodeId).map((item) => [item.nodeId!, item]))
  return branchNodes.value.flatMap((node) => {
    const analysis = byNode.get(node.id)
    const mateIn = analysis?.lines.find((line) => line.multiPv === 1)?.score.mateIn
    return mateIn === undefined ? [] : [{ node, mateIn }]
  })
})
</script>

<template>
  <section class="evaluation-card" aria-labelledby="curve-title">
    <div class="section-heading-row">
      <div>
        <h2 id="curve-title">历史评估曲线</h2>
        <p>仅绘制 cp；将杀以独立标记显示。最多采样 200 个点。</p>
      </div>
      <span>{{ points.length }} 个曲线点</span>
    </div>
    <div v-if="points.length" class="evaluation-chart">
      <svg viewBox="0 0 100 100" role="img" aria-label="红方视角历史评估曲线" preserveAspectRatio="none">
        <line x1="0" y1="50" x2="100" y2="50" class="evaluation-zero" />
        <polyline :points="polyline" class="evaluation-line" />
        <circle
          v-for="point in points"
          :key="point.node.id"
          :cx="point.x"
          :cy="point.y"
          :r="point.node.id === selectedNodeId ? 2.2 : 1.3"
          :class="['evaluation-point', { selected: point.node.id === selectedNodeId }]"
          tabindex="0"
          role="button"
          :aria-label="`第 ${point.node.ply} 层，${point.cp} cp`"
          @click="emit('select', point.node.id)"
          @keydown.enter="emit('select', point.node.id)"
        >
          <title>{{ point.node.fen }} · {{ point.analysis.engine.name }} · 深度 {{ point.analysis.settings.depth }} · {{ point.cp }} cp</title>
        </circle>
      </svg>
    </div>
    <p v-else class="empty-analysis">完成单步分析或整盘复盘后显示曲线。</p>
    <div v-if="mateNodes.length" class="mate-strip" aria-label="将杀评估">
      <button v-for="item in mateNodes" :key="item.node.id" type="button" @click="emit('select', item.node.id)">
        第 {{ item.node.ply }} 层 · 将杀 {{ item.mateIn }}
      </button>
    </div>
  </section>
</template>
