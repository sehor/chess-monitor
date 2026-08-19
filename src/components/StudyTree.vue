<script setup lang="ts">
import { computed } from 'vue'
import type { StudyMark, StudyNode } from '../shared/study'

const props = defineProps<{
  nodes: StudyNode[]
  marks: StudyMark[]
  selectedNodeId: string | null
  liveNodeId: string | null
}>()

const emit = defineEmits<{ select: [nodeId: string] }>()
const marksByNode = computed(() => new Map(props.marks.map((mark) => [mark.nodeId, mark])))

function sourceLabel(source: StudyNode['source']): string {
  return {
    live: '实时',
    variation: '分支',
    import: '导入',
    fen: 'FEN',
    resync: '重同步',
    undo: '撤销',
  }[source]
}
</script>

<template>
  <section class="study-tree-card" aria-labelledby="tree-title">
    <div class="section-heading-row">
      <div>
        <h2 id="tree-title">变化树</h2>
        <p>{{ nodes.length }} 个不可变局面节点</p>
      </div>
    </div>
    <ol class="study-tree" aria-label="变化树节点">
      <li v-for="node in nodes" :key="node.id">
        <button
          type="button"
          :class="['study-node', { selected: node.id === selectedNodeId, live: node.id === liveNodeId }]"
          :style="{
            marginLeft: `${Math.min(node.ply, 12) * 0.75}rem`,
            width: `calc(100% - ${Math.min(node.ply, 12) * 0.75}rem)`,
          }"
          @click="emit('select', node.id)"
        >
          <span class="node-main">
            <strong>{{ node.move ?? '起始局面' }}</strong>
            <span>{{ sourceLabel(node.source) }}</span>
          </span>
          <span class="node-meta">
            <span>层 {{ node.ply }}</span>
            <span v-if="node.id === liveNodeId">当前实时</span>
            <span v-if="marksByNode.get(node.id)" class="move-mark">
              {{ marksByNode.get(node.id)?.kind === 'blunder' ? '漏着' : '疑问手' }}
            </span>
          </span>
        </button>
      </li>
    </ol>
  </section>
</template>
