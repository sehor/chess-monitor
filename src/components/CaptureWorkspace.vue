<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { deriveIntersectionPoints, type Point } from '../lib/calibration'
import { CAPTURE_QUALITY_EVENT_MINIMUM } from '../shared/capture-report'
import type { CaptureAnalysis, CaptureSampleAnnotation, CaptureSource } from '../shared/ipc'
import { evaluateProfileCompatibility, type CaptureProfile, type CaptureProfileInput } from '../shared/profile'
import CaptureSampleForm from './CaptureSampleForm.vue'
import ProfilePanel from './ProfilePanel.vue'
import TrackingPanel from './TrackingPanel.vue'

const sources = ref<CaptureSource[]>([])
const selectedSourceId = ref<string | null>(null)
const isLoading = ref(false)
const isStartingPreview = ref(false)
const errorMessage = ref<string | null>(null)
const preview = ref<HTMLVideoElement | null>(null)
const calibrationPoints = ref<Point[]>([])
const frameAnalysis = ref<CaptureAnalysis | null>(null)
const sampleMessage = ref<string | null>(null)
const roiScale = ref(0.6)
const orientation = ref<'red-bottom' | 'black-bottom'>('red-bottom')
const profileMessage = ref<string | null>(null)
const selectedSource = computed(() => sources.value.find((source) => source.id === selectedSourceId.value) ?? null)
const gridPoints = computed(() => calibrationPoints.value.length === 2
  ? deriveIntersectionPoints(calibrationPoints.value[0], calibrationPoints.value[1])
  : [])
const roiSize = computed(() => {
  const [topLeft, bottomRight] = calibrationPoints.value
  if (!topLeft || !bottomRight) return null
  return {
    width: ((bottomRight.x - topLeft.x) / 8) * roiScale.value,
    height: ((bottomRight.y - topLeft.y) / 9) * roiScale.value,
  }
})
const roiBoundaryWarning = computed(() => {
  const video = preview.value
  const size = roiSize.value
  if (!video || !size || gridPoints.value.length !== 90) return null
  const outside = gridPoints.value.some((point) => (
    point.x - size.width / 2 < 0 || point.y - size.height / 2 < 0 ||
    point.x + size.width / 2 > video.videoWidth || point.y + size.height / 2 > video.videoHeight
  ))
  return outside ? 'ROI 超出捕获边界，必须重新校准或减小 ROI。' : null
})

function roiMarkerStyle(point: Point, index: number): Record<string, string> {
  const video = preview.value
  const size = roiSize.value
  const score = frameAnalysis.value?.pointScores[index] ?? 0
  if (!video || !size || video.videoWidth === 0 || video.videoHeight === 0) return {}
  return {
    left: `${(point.x / video.videoWidth) * 100}%`,
    top: `${(point.y / video.videoHeight) * 100}%`,
    width: `${(size.width / video.videoWidth) * 100}%`,
    height: `${(size.height / video.videoHeight) * 100}%`,
    '--roi-score': String(Math.min(0.75, score * 8)),
  }
}
const profileDraft = computed<CaptureProfileInput | null>(() => {
  const video = preview.value
  const source = selectedSource.value
  const [topLeft, bottomRight] = calibrationPoints.value
  if (!video || !source || !topLeft || !bottomRight || video.videoWidth === 0 || video.videoHeight === 0 || roiBoundaryWarning.value) return null
  return {
    name: `${source.name || '捕获来源'} Profile`,
    source: { kind: source.kind, name: source.name },
    frame: {
      width: video.videoWidth,
      height: video.videoHeight,
      dpi: Math.round(window.devicePixelRatio * 100),
    },
    calibration: { topLeft, bottomRight },
    orientation: orientation.value,
    theme: '木纹',
    roiScale: roiScale.value,
    thresholds: { low: 0, high: 0.0076 },
    stableFrameRequirement: 3,
    animationWaitMs: 300,
  }
})
let activeStream: MediaStream | undefined
let sampleTimer: number | undefined
let isAnalyzingFrame = false
let isRecoveringSource = false
let disposed = false
const sampleCanvas = document.createElement('canvas')

async function loadSources(): Promise<boolean> {
  isLoading.value = true
  errorMessage.value = null
  const result = await window.chessMonitor.capture.listSources()
  isLoading.value = false
  if (!result.ok) {
    errorMessage.value = result.error.message
    return false
  }
  sources.value = result.value
  const authorizedSource = sources.value.find((source) => source.isSelected)
  if (authorizedSource) selectedSourceId.value = authorizedSource.id
  else if (!sources.value.some((source) => source.id === selectedSourceId.value)) selectedSourceId.value = null
  return Boolean(authorizedSource)
}

async function selectSource(sourceId: string): Promise<void> {
  const result = await window.chessMonitor.capture.selectSource(sourceId)
  if (!result.ok) return void (errorMessage.value = result.error.message)
  selectedSourceId.value = sourceId
  errorMessage.value = null
}

async function startPreview(): Promise<void> {
  if (!selectedSource.value || !preview.value) return
  isStartingPreview.value = true
  errorMessage.value = null
  try {
    activeStream?.getTracks().forEach((track) => {
      track.onended = null
      track.stop()
    })
    const stream = await navigator.mediaDevices.getDisplayMedia({ audio: false, video: { frameRate: { ideal: 5, max: 10 } } })
    activeStream = stream
    stream.getVideoTracks()[0].onended = () => void recoverSource()
    preview.value.srcObject = stream
    await preview.value.play()
    startSampling()
  } catch {
    errorMessage.value = '无法开始捕获预览，请确认来源仍存在且允许捕获。'
  } finally {
    isStartingPreview.value = false
  }
}

async function applySavedProfile(profile: CaptureProfile): Promise<void> {
  profileMessage.value = null
  orientation.value = profile.orientation
  roiScale.value = profile.roiScale
  await loadSources()
  const matched = sources.value.find((source) => source.isSelected && source.kind === profile.source.kind)
  if (!matched) {
    calibrationPoints.value = []
    profileMessage.value = '未找到唯一匹配的捕获来源，请重新选择。'
    return
  }
  selectedSourceId.value = matched.id
  await startPreview()
  const video = preview.value
  if (!video || video.videoWidth === 0 || video.videoHeight === 0) return
  const compatibility = evaluateProfileCompatibility(profile, {
    width: video.videoWidth,
    height: video.videoHeight,
    dpi: Math.round(window.devicePixelRatio * 100),
  })
  if (compatibility.state === 'recalibration-required') {
    calibrationPoints.value = []
    profileMessage.value = `Profile 已失效：${compatibility.reasons.join('；')}。请重新校准。`
    return
  }
  calibrationPoints.value = [compatibility.calibration.topLeft, compatibility.calibration.bottomRight]
  profileMessage.value = 'Profile 已恢复，正在验证 90 点覆盖层。'
  startSampling()
}

async function recoverSource(): Promise<void> {
  if (disposed || isRecoveringSource) return
  isRecoveringSource = true
  stopSampling()
  errorMessage.value = '捕获来源已断开，正在等待同名来源重新出现…'
  for (let attempt = 0; attempt < 20 && !disposed; attempt += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 500))
    if (await loadSources()) {
      isRecoveringSource = false
      errorMessage.value = null
      await startPreview()
      return
    }
  }
  isRecoveringSource = false
  errorMessage.value = '未能在 10 秒内恢复捕获来源，请重新选择。'
}

function stopSampling(): void {
  if (sampleTimer !== undefined) window.clearInterval(sampleTimer)
  sampleTimer = undefined
}

function startSampling(): void {
  stopSampling()
  if (calibrationPoints.value.length !== 2) return
  void sampleFrame()
  sampleTimer = window.setInterval(() => void sampleFrame(), 100)
}

async function sampleFrame(): Promise<void> {
  if (isAnalyzingFrame) return
  const video = preview.value
  const [topLeft, bottomRight] = calibrationPoints.value
  if (!video || !topLeft || !bottomRight || video.videoWidth === 0 || video.videoHeight === 0) return

  const scale = Math.min(1, Math.sqrt(1_900_000 / (video.videoWidth * video.videoHeight)))
  sampleCanvas.width = Math.max(5, Math.floor(video.videoWidth * scale))
  sampleCanvas.height = Math.max(5, Math.floor(video.videoHeight * scale))
  const context = sampleCanvas.getContext('2d', { willReadFrequently: true })
  if (!context) return
  context.drawImage(video, 0, 0, sampleCanvas.width, sampleCanvas.height)

  isAnalyzingFrame = true
  try {
    const result = await window.chessMonitor.capture.analyzeFrame({
      pixels: context.getImageData(0, 0, sampleCanvas.width, sampleCanvas.height).data,
      width: sampleCanvas.width,
      height: sampleCanvas.height,
      topLeft: { x: topLeft.x * scale, y: topLeft.y * scale },
      bottomRight: { x: bottomRight.x * scale, y: bottomRight.y * scale },
      roiScale: roiScale.value,
      dpi: Math.round(window.devicePixelRatio * 100),
    })
    if (result.ok) frameAnalysis.value = result.value
  } finally {
    isAnalyzingFrame = false
  }
}

async function saveCurrentSample(annotation: CaptureSampleAnnotation): Promise<void> {
  const video = preview.value
  if (!video || video.videoWidth === 0 || video.videoHeight === 0) {
    sampleMessage.value = '请先启动预览，再保存样本。'
    return
  }

  const scale = Math.min(1, Math.sqrt(1_900_000 / (video.videoWidth * video.videoHeight)))
  sampleCanvas.width = Math.max(5, Math.floor(video.videoWidth * scale))
  sampleCanvas.height = Math.max(5, Math.floor(video.videoHeight * scale))
  const context = sampleCanvas.getContext('2d', { willReadFrequently: true })
  if (!context) return
  context.drawImage(video, 0, 0, sampleCanvas.width, sampleCanvas.height)
  const blob = await new Promise<Blob | null>((resolve) => sampleCanvas.toBlob(resolve, 'image/png'))
  if (!blob) {
    sampleMessage.value = '无法编码当前预览帧。'
    return
  }
  const result = await window.chessMonitor.capture.saveSample({
    pngBytes: new Uint8Array(await blob.arrayBuffer()),
    metadata: {
      ...annotation,
      orientation: orientation.value,
      roiScale: roiScale.value,
      sourceName: selectedSource.value?.name ?? '',
      analysis: frameAnalysis.value,
    },
  })
  sampleMessage.value = result.ok
    ? `已保存 ${result.value.fileName}；当前 ${result.value.summary?.eventCount ?? 0}/${CAPTURE_QUALITY_EVENT_MINIMUM} 个事件，质量门${result.value.summary?.meetsQualityGate ? '已通过' : '尚未通过'}。`
    : result.error.message
}

function calibrate(event: MouseEvent): void {
  const video = preview.value
  if (!video || video.videoWidth === 0 || video.videoHeight === 0) {
    errorMessage.value = '请先启动预览，再点击棋盘左上和右下交叉点。'
    return
  }

  const bounds = video.getBoundingClientRect()
  const scale = Math.min(bounds.width / video.videoWidth, bounds.height / video.videoHeight)
  const displayedWidth = video.videoWidth * scale
  const displayedHeight = video.videoHeight * scale
  const x = (event.clientX - bounds.left - (bounds.width - displayedWidth) / 2) / scale
  const y = (event.clientY - bounds.top - (bounds.height - displayedHeight) / 2) / scale
  if (x < 0 || y < 0 || x > video.videoWidth || y > video.videoHeight) return

  const clicked = { x, y }
  if (calibrationPoints.value.length === 0) {
    calibrationPoints.value = [clicked]
    frameAnalysis.value = null
    return
  }

  const first = calibrationPoints.value[0]
  calibrationPoints.value = [
    { x: Math.min(first.x, clicked.x), y: Math.min(first.y, clicked.y) },
    { x: Math.max(first.x, clicked.x), y: Math.max(first.y, clicked.y) },
  ]
  frameAnalysis.value = null
  startSampling()
}

function resetCalibration(): void {
  calibrationPoints.value = []
  frameAnalysis.value = null
  stopSampling()
  if (selectedSourceId.value) void selectSource(selectedSourceId.value)
}

onMounted(() => void loadSources())
onBeforeUnmount(() => {
  disposed = true
  stopSampling()
  activeStream?.getTracks().forEach((track) => {
    track.onended = null
    track.stop()
  })
  void window.chessMonitor.capture.clearSource()
})
</script>

<template>
  <section class="capture-workspace" aria-labelledby="capture-title">
    <header class="workspace-header">
      <div>
        <p class="eyebrow">阶段 0 · 技术验证</p>
        <h1 id="capture-title">选择捕获来源</h1>
      </div>
      <button type="button" class="secondary-action" :disabled="isLoading" @click="loadSources">{{ isLoading ? '正在刷新…' : '刷新列表' }}</button>
    </header>
    <p class="intro">优先选择客户端窗口；若窗口预览为黑屏，可选择“整个屏幕”并校准棋盘。此阶段不会操作客户端。</p>
    <p v-if="errorMessage" class="error-message" role="alert">{{ errorMessage }}</p>
    <div class="capture-layout">
      <div class="source-panel">
        <p v-if="isLoading" class="status-message" role="status">正在读取捕获来源…</p>
        <p v-else-if="sources.length === 0" class="status-message" role="status">未发现可用的捕获来源。</p>
        <ul v-else class="source-list" aria-label="捕获来源列表">
          <li v-for="source in sources" :key="source.id">
            <button type="button" class="source-option" :class="{ selected: selectedSourceId === source.id }" :aria-pressed="selectedSourceId === source.id" @click="selectSource(source.id)">
              <img v-if="source.thumbnailDataUrl" :src="source.thumbnailDataUrl" alt="" class="source-thumbnail" />
              <span class="source-name">{{ source.name || '未命名来源' }}</span>
            </button>
          </li>
        </ul>
      </div>
      <aside class="preview-panel" aria-label="捕获预览">
        <div class="preview-stack">
          <video ref="preview" class="preview" muted playsinline aria-label="所选来源的捕获预览；点击棋盘左上和右下交叉点进行校准" @click="calibrate" />
          <span
            v-for="(point, index) in gridPoints"
            :key="`${point.file}-${point.rank}`"
            class="grid-marker"
            :style="roiMarkerStyle(point, index)"
            :title="`点 ${index} · 变化分数 ${(frameAnalysis?.pointScores[index] ?? 0).toFixed(4)}`"
          />
          <span v-for="(point, index) in calibrationPoints" :key="index" class="calibration-marker" :style="{ left: `${(point.x / (preview?.videoWidth || 1)) * 100}%`, top: `${(point.y / (preview?.videoHeight || 1)) * 100}%` }">{{ index + 1 }}</span>
        </div>
        <p class="preview-hint">{{ selectedSource ? `当前来源：${selectedSource.name || '未命名来源'}` : '从左侧选择一个来源以继续。' }}</p>
        <button type="button" class="primary-action" :disabled="!selectedSource || isStartingPreview" @click="startPreview">{{ isStartingPreview ? '正在启动预览…' : '开始预览' }}</button>
        <button type="button" class="secondary-action" :disabled="calibrationPoints.length === 0" @click="resetCalibration">重新校准</button>
        <div class="capture-options">
          <label for="roi-scale">ROI {{ Math.round(roiScale * 100) }}%</label>
          <input id="roi-scale" v-model.number="roiScale" type="range" min="0.4" max="0.8" step="0.05" @change="startSampling" />
          <label for="capture-orientation">方向</label>
          <select id="capture-orientation" v-model="orientation">
            <option value="red-bottom">红方在下</option>
            <option value="black-bottom">黑方在下</option>
          </select>
        </div>
        <p class="capture-status" role="status">
          {{ calibrationPoints.length === 0 ? '点击预览中的棋盘左上交叉点。' : calibrationPoints.length === 1 ? '再点击右下交叉点。' : frameAnalysis?.isStable ? `已连续 ${frameAnalysis.stableFrameCount} 帧稳定。` : `检测到 ${frameAnalysis?.changedPointCount ?? 0} 个显著变化点；稳定帧 ${frameAnalysis?.stableFrameCount ?? 0}/3。` }}
        </p>
        <p v-if="gridPoints.length === 90" class="status-message">已显示 90 个实际 ROI；送入分析前统一归一化为 32×32 灰度块。</p>
        <p v-if="roiBoundaryWarning" class="error-message" role="alert">{{ roiBoundaryWarning }}</p>
        <p v-if="sampleMessage" class="status-message" role="status">{{ sampleMessage }}</p>
        <p v-if="profileMessage" class="status-message" role="status">{{ profileMessage }}</p>
        <ProfilePanel :draft="profileDraft" @apply="applySavedProfile" />
        <TrackingPanel :ready="Boolean(selectedSource && calibrationPoints.length === 2 && frameAnalysis)" :orientation="orientation" />
        <CaptureSampleForm :disabled="!selectedSource || calibrationPoints.length !== 2" @save="saveCurrentSample" />
      </aside>
    </div>
  </section>
</template>
