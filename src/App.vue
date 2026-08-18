<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { CaptureSource } from './shared/ipc'

const sources = ref<CaptureSource[]>([])
const selectedSourceId = ref<string | null>(null)
const isLoading = ref(false)
const isStartingPreview = ref(false)
const errorMessage = ref<string | null>(null)
const preview = ref<HTMLVideoElement | null>(null)

const selectedSource = computed(
  () => sources.value.find((source) => source.id === selectedSourceId.value) ?? null,
)

async function loadSources(): Promise<void> {
  isLoading.value = true
  errorMessage.value = null
  const result = await window.chessMonitor.capture.listSources()
  isLoading.value = false

  if (!result.ok) {
    errorMessage.value = result.error.message
    return
  }

  sources.value = result.value
  if (!sources.value.some((source) => source.id === selectedSourceId.value)) {
    selectedSourceId.value = null
  }
}

async function selectSource(sourceId: string): Promise<void> {
  const result = await window.chessMonitor.capture.selectSource(sourceId)
  if (!result.ok) {
    errorMessage.value = result.error.message
    return
  }

  errorMessage.value = null
  selectedSourceId.value = sourceId
}

async function startPreview(): Promise<void> {
  if (!selectedSource.value || !preview.value) return

  isStartingPreview.value = true
  errorMessage.value = null

  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      audio: false,
      video: { frameRate: { ideal: 5, max: 10 } },
    })
    preview.value.srcObject = stream
    await preview.value.play()
  } catch {
    errorMessage.value = '无法开始窗口预览，请确认窗口仍存在且允许捕获。'
  } finally {
    isStartingPreview.value = false
  }
}

onMounted(loadSources)
</script>

<template>
  <main class="capture-page">
    <header class="page-header">
      <p class="eyebrow">阶段 0 · 技术验证</p>
      <h1>选择象棋客户端窗口</h1>
      <p class="intro">选择后仅允许捕获该窗口。此阶段只做预览和棋盘校准，不会操作客户端。</p>
    </header>

    <section class="capture-layout" aria-labelledby="source-title">
      <div class="source-panel">
        <div class="section-heading">
          <h2 id="source-title">可用窗口</h2>
          <button type="button" class="secondary-action" :disabled="isLoading" @click="loadSources">
            {{ isLoading ? '正在刷新…' : '刷新列表' }}
          </button>
        </div>

        <p v-if="errorMessage" class="error-message" role="alert">{{ errorMessage }}</p>
        <p v-else-if="isLoading" class="status-message" role="status">正在读取可捕获窗口…</p>
        <p v-else-if="sources.length === 0" class="status-message" role="status">
          未发现可捕获的应用窗口。
        </p>

        <ul v-else class="source-list" aria-label="可捕获窗口列表">
          <li v-for="source in sources" :key="source.id">
            <button
              type="button"
              class="source-option"
              :class="{ selected: selectedSourceId === source.id }"
              :aria-pressed="selectedSourceId === source.id"
              @click="selectSource(source.id)"
            >
              <img
                v-if="source.thumbnailDataUrl"
                :src="source.thumbnailDataUrl"
                alt=""
                class="source-thumbnail"
              />
              <span class="source-name">{{ source.name || '未命名窗口' }}</span>
            </button>
          </li>
        </ul>
      </div>

      <aside class="preview-panel" aria-labelledby="preview-title">
        <div class="section-heading">
          <h2 id="preview-title">捕获预览</h2>
          <span class="capture-state">{{ selectedSource ? '已授权' : '等待选择' }}</span>
        </div>
        <video ref="preview" class="preview" muted playsinline aria-label="所选窗口的捕获预览" />
        <p class="preview-hint">
          {{ selectedSource ? `当前窗口：${selectedSource.name || '未命名窗口'}` : '从左侧选择一个窗口以继续。' }}
        </p>
        <button
          type="button"
          class="primary-action"
          :disabled="!selectedSource || isStartingPreview"
          @click="startPreview"
        >
          {{ isStartingPreview ? '正在启动预览…' : '开始预览' }}
        </button>
      </aside>
    </section>
  </main>
</template>
