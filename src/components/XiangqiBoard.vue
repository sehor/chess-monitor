<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Xiangqiground } from 'xiangqiground'
import type { Api } from 'xiangqiground/api'
import type { IccsMove } from '../domain/game'
import type { PositionSnapshot } from '../domain/position'
import { createBoardConfig } from '../lib/board-adapter'

const props = defineProps<{
  position: PositionSnapshot
  legalMoves: IccsMove[]
  bestMove?: IccsMove | null
}>()

const emit = defineEmits<{ move: [move: IccsMove] }>()
const root = ref<HTMLElement | null>(null)
let board: Api | undefined

function configuration() {
  return createBoardConfig({
    position: props.position,
    legalMoves: props.legalMoves,
    bestMove: props.bestMove,
    onMove: (move) => emit('move', move),
  })
}

onMounted(() => {
  if (root.value) board = Xiangqiground(root.value, configuration())
})

watch(
  () => [props.position, props.legalMoves, props.bestMove] as const,
  () => board?.set(configuration()),
)

onBeforeUnmount(() => board?.destroy())
</script>

<template>
  <div ref="root" class="xiangqi-board" aria-label="象棋棋盘" />
</template>
