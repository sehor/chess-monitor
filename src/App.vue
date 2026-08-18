<script setup lang="ts">
import { ref } from 'vue'
import AnalysisWorkspace from './components/AnalysisWorkspace.vue'
import CaptureWorkspace from './components/CaptureWorkspace.vue'

const activeWorkspace = ref<'capture' | 'analysis'>('capture')
</script>

<template>
  <div class="app-shell">
    <nav class="app-nav" aria-label="主导航">
      <span class="app-name">象棋监控分析</span>
      <div class="nav-actions">
        <button type="button" :aria-current="activeWorkspace === 'capture' ? 'page' : undefined" @click="activeWorkspace = 'capture'">窗口捕获</button>
        <button type="button" :aria-current="activeWorkspace === 'analysis' ? 'page' : undefined" @click="activeWorkspace = 'analysis'">局面分析</button>
      </div>
    </nav>
    <CaptureWorkspace v-if="activeWorkspace === 'capture'" />
    <AnalysisWorkspace v-else />
  </div>
</template>
