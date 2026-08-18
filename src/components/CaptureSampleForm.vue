<script setup lang="ts">
import { ref } from 'vue'
import type { CaptureEventType, CaptureSampleAnnotation } from '../shared/ipc'

defineProps<{ disabled: boolean }>()
const emit = defineEmits<{ save: [annotation: CaptureSampleAnnotation] }>()

const gameId = ref(`game-${new Date().toISOString().slice(0, 10)}`)
const dpi = ref<100 | 125 | 150>(100)
const eventType = ref<CaptureEventType>('move')
const changedPoints = ref('')
const gridErrorPercent = ref<number | null>(null)
const captureSucceeded = ref(true)
const validationMessage = ref<string | null>(null)

function submit(): void {
  const parsedPoints = changedPoints.value.trim() === ''
    ? []
    : changedPoints.value.split(',').map((value) => Number(value.trim()))
  if (parsedPoints.some((point) => !Number.isInteger(point) || point < 1 || point > 90)) {
    validationMessage.value = '变化点请使用 1–90 的编号，以逗号分隔。'
    return
  }
  if (gridErrorPercent.value !== null && (gridErrorPercent.value < 0 || gridErrorPercent.value > 100)) {
    validationMessage.value = '网格误差必须在 0%–100% 之间。'
    return
  }

  validationMessage.value = null
  emit('save', {
    gameId: gameId.value.trim(),
    dpi: dpi.value,
    eventType: eventType.value,
    expectedChangedPoints: [...new Set(parsedPoints.map((point) => point - 1))],
    gridErrorRatio: gridErrorPercent.value === null ? null : gridErrorPercent.value / 100,
    captureSucceeded: captureSucceeded.value,
  })
}
</script>

<template>
  <form class="sample-form" aria-labelledby="sample-form-title" @submit.prevent="submit">
    <h2 id="sample-form-title">事件标注与质量样本</h2>
    <label>对局组<input v-model="gameId" required maxlength="128" /></label>
    <label>DPI
      <select v-model.number="dpi"><option :value="100">100%</option><option :value="125">125%</option></select>
    </label>
    <label>事件
      <select v-model="eventType">
        <option value="move">走子</option><option value="capture">吃子</option><option value="highlight">高亮</option>
        <option value="animation">动画</option><option value="stationary">静止</option>
      </select>
    </label>
    <label>预期变化点（1–90）<input v-model="changedPoints" placeholder="例如 12, 48；静止帧留空" /></label>
    <label>网格误差 %（可选）<input v-model.number="gridErrorPercent" type="number" min="0" max="100" step="0.1" /></label>
    <label class="check-field"><input v-model="captureSucceeded" type="checkbox" /> 抓帧成功</label>
    <button type="submit" class="secondary-action" :disabled="disabled">保存标注样本并更新报告</button>
    <p v-if="validationMessage" class="error-message" role="alert">{{ validationMessage }}</p>
  </form>
</template>
