<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import type { CaptureProfile, CaptureProfileInput, ProfileIssue } from '../shared/profile'

const props = defineProps<{ draft: CaptureProfileInput | null }>()
const emit = defineEmits<{ apply: [profile: CaptureProfile] }>()

const profiles = ref<CaptureProfile[]>([])
const issues = ref<ProfileIssue[]>([])
const activeProfileId = ref<string | null>(null)
const profileName = ref('天天象棋')
const theme = ref('木纹')
const isBusy = ref(false)
const message = ref<string | null>(null)

watch(() => props.draft?.source.name, (sourceName) => {
  if (sourceName && profileName.value === '天天象棋') profileName.value = `${sourceName} Profile`
})

async function loadProfiles(restoreActive = false): Promise<void> {
  isBusy.value = true
  const result = await window.chessMonitor.profiles.list()
  isBusy.value = false
  if (!result.ok) return void (message.value = result.error.message)
  profiles.value = result.value.profiles
  issues.value = result.value.issues
  activeProfileId.value = result.value.activeProfileId
  if (restoreActive && activeProfileId.value) {
    const active = profiles.value.find((profile) => profile.id === activeProfileId.value)
    if (active) emit('apply', active)
  }
}

async function saveProfile(): Promise<void> {
  if (!props.draft) return
  isBusy.value = true
  message.value = null
  const result = await window.chessMonitor.profiles.save({
    ...props.draft,
    name: profileName.value,
    theme: theme.value,
  })
  if (!result.ok) {
    isBusy.value = false
    return void (message.value = result.error.message)
  }
  const activated = await window.chessMonitor.profiles.setActive(result.value.id)
  isBusy.value = false
  if (!activated.ok || !activated.value) return void (message.value = activated.ok ? '无法激活 Profile' : activated.error.message)
  message.value = `已保存并激活 ${activated.value.name}`
  await loadProfiles()
  emit('apply', activated.value)
}

async function applyProfile(profile: CaptureProfile): Promise<void> {
  isBusy.value = true
  const result = await window.chessMonitor.profiles.setActive(profile.id)
  isBusy.value = false
  if (!result.ok || !result.value) return void (message.value = result.ok ? '无法激活 Profile' : result.error.message)
  activeProfileId.value = profile.id
  profileName.value = profile.name
  theme.value = profile.theme
  message.value = `已应用 ${profile.name}`
  emit('apply', result.value)
}

async function deleteProfile(profile: CaptureProfile): Promise<void> {
  if (!window.confirm(`删除 Profile“${profile.name}”？此操作不会删除棋局或引擎设置。`)) return
  const result = await window.chessMonitor.profiles.delete(profile.id)
  message.value = result.ok && result.value.deleted ? 'Profile 已删除' : result.ok ? 'Profile 不存在' : result.error.message
  await loadProfiles()
}

async function exportDiagnostics(profile: CaptureProfile): Promise<void> {
  const result = await window.chessMonitor.profiles.exportDiagnostics(profile.id)
  message.value = result.ok ? `诊断已导出：${result.value.fileName}` : result.error.message
}

onMounted(() => void loadProfiles(true))
</script>

<template>
  <section class="profile-panel" aria-labelledby="profile-title">
    <div class="section-heading">
      <div>
        <p class="eyebrow">阶段 2 · Profile</p>
        <h2 id="profile-title">保存与恢复棋盘校准</h2>
      </div>
      <button type="button" class="secondary-action" :disabled="isBusy" @click="loadProfiles()">刷新</button>
    </div>

    <div class="profile-editor">
      <label for="profile-name">名称</label>
      <input id="profile-name" v-model="profileName" maxlength="128" />
      <label for="profile-theme">主题</label>
      <input id="profile-theme" v-model="theme" maxlength="128" />
      <button type="button" class="primary-action" :disabled="!draft || isBusy" @click="saveProfile">
        {{ isBusy ? '正在处理…' : '保存当前校准' }}
      </button>
    </div>

    <p v-if="profiles.length === 0 && !isBusy" class="status-message">尚未保存 Profile。完成两点校准后即可保存。</p>
    <ul v-else class="profile-list" aria-label="已保存 Profile">
      <li v-for="profile in profiles" :key="profile.id">
        <div>
          <strong>{{ profile.name }}</strong>
          <small>{{ profile.frame.dpi }}% · {{ profile.source.kind === 'screen' ? '整屏' : '窗口' }} · {{ profile.theme }}</small>
        </div>
        <span v-if="activeProfileId === profile.id" class="status-pill">当前</span>
        <button type="button" class="secondary-action" :disabled="isBusy" @click="applyProfile(profile)">应用</button>
        <button type="button" class="secondary-action" :disabled="isBusy" @click="exportDiagnostics(profile)">诊断</button>
        <button type="button" class="danger-action" :disabled="isBusy" @click="deleteProfile(profile)">删除</button>
      </li>
    </ul>

    <p v-if="issues.length" class="error-message" role="alert">有 {{ issues.length }} 条损坏或不兼容记录已被隔离，应用仍可继续启动。</p>
    <p v-if="message" class="status-message" role="status">{{ message }}</p>
  </section>
</template>
