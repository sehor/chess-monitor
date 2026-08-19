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
const clientName = ref('天天象棋')
const clientVersion = ref('unknown')
const dpiMin = ref(100)
const dpiMax = ref(150)
const priority = ref(0)
const matchMode = ref<'exact' | 'prefix' | 'suffix'>('exact')
const matchValue = ref('')
const isBusy = ref(false)
const message = ref<string | null>(null)

watch(() => props.draft?.source.name, (sourceName) => {
  if (!sourceName) return
  if (profileName.value === '天天象棋') profileName.value = `${sourceName} Profile`
  if (!matchValue.value) matchValue.value = sourceName
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
    client: { name: clientName.value, version: clientVersion.value },
    compatibility: {
      dpi: { min: dpiMin.value, max: dpiMax.value },
      frameScale: { min: 0.5, max: 2 },
      clientVersion: { min: null, max: null },
    },
    priority: priority.value,
    isEnabled: true,
    matchRules: [{ mode: matchMode.value, value: matchValue.value || props.draft.source.name }],
    model: { strategy: 'shared', modelVersion: null },
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
  clientName.value = profile.client.name
  clientVersion.value = profile.client.version
  dpiMin.value = profile.compatibility.dpi.min
  dpiMax.value = profile.compatibility.dpi.max
  priority.value = profile.priority
  matchMode.value = profile.matchRules[0]?.mode ?? 'exact'
  matchValue.value = profile.matchRules[0]?.value ?? profile.source.name
  message.value = `已应用 ${profile.name}`
  emit('apply', result.value)
}

async function deleteProfile(profile: CaptureProfile): Promise<void> {
  if (!window.confirm(`删除 Profile“${profile.name}”？此操作不会删除棋局或引擎设置。`)) return
  const result = await window.chessMonitor.profiles.delete(profile.id)
  message.value = result.ok && result.value.deleted ? 'Profile 已删除' : result.ok ? 'Profile 不存在' : result.error.message
  await loadProfiles()
}

async function duplicateProfile(profile: CaptureProfile): Promise<void> {
  const result = await window.chessMonitor.profiles.duplicate(profile.id)
  message.value = result.ok ? `已复制 ${result.value.name}` : result.error.message
  await loadProfiles()
}

async function toggleProfile(profile: CaptureProfile): Promise<void> {
  const result = await window.chessMonitor.profiles.setEnabled(profile.id, !profile.isEnabled)
  message.value = result.ok ? `${result.value.name} 已${result.value.isEnabled ? '启用' : '禁用'}` : result.error.message
  await loadProfiles()
}

async function rollbackProfile(profile: CaptureProfile): Promise<void> {
  const versions = await window.chessMonitor.profiles.listVersions(profile.id)
  if (!versions.ok) return void (message.value = versions.error.message)
  const target = versions.value.find((item) => item.profileVersion < profile.profileVersion)
  if (!target) return void (message.value = '没有可回滚的历史版本')
  const result = await window.chessMonitor.profiles.rollback(profile.id, target.profileVersion)
  message.value = result.ok ? `已回滚到 v${target.profileVersion}，生成当前 v${result.value.profileVersion}` : result.error.message
  await loadProfiles()
}

async function exportProfile(profile: CaptureProfile): Promise<void> {
  const result = await window.chessMonitor.profiles.exportProfile(profile.id)
  message.value = result.ok ? (result.value.fileName ? `Profile 已导出：${result.value.fileName}` : '已取消导出') : result.error.message
}

async function importProfile(): Promise<void> {
  const result = await window.chessMonitor.profiles.importProfile()
  message.value = result.ok ? (result.value ? `已导入 ${result.value.name}` : '已取消导入') : result.error.message
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
        <p class="eyebrow">阶段 7 · Profile Manager</p>
        <h2 id="profile-title">多客户端 Profile 管理</h2>
      </div>
      <div class="profile-toolbar">
        <button type="button" class="secondary-action" :disabled="isBusy" @click="importProfile">导入</button>
        <button type="button" class="secondary-action" :disabled="isBusy" @click="loadProfiles()">刷新</button>
      </div>
    </div>

    <div class="profile-editor">
      <label for="profile-name">名称</label>
      <input id="profile-name" v-model="profileName" maxlength="128" />
      <label for="profile-theme">主题</label>
      <input id="profile-theme" v-model="theme" maxlength="128" />
      <label for="profile-client">客户端</label>
      <input id="profile-client" v-model="clientName" maxlength="128" />
      <label for="profile-client-version">客户端版本</label>
      <input id="profile-client-version" v-model="clientVersion" maxlength="64" />
      <label for="profile-dpi-min">DPI 范围</label>
      <div class="inline-fields"><input id="profile-dpi-min" v-model.number="dpiMin" type="number" min="50" max="300" /><span>–</span><input v-model.number="dpiMax" type="number" min="50" max="300" aria-label="最大 DPI" /></div>
      <label for="profile-match-mode">窗口规则</label>
      <div class="inline-fields"><select id="profile-match-mode" v-model="matchMode"><option value="exact">精确</option><option value="prefix">前缀</option><option value="suffix">后缀</option></select><input v-model="matchValue" maxlength="256" aria-label="窗口匹配文本" /></div>
      <label for="profile-priority">优先级</label>
      <input id="profile-priority" v-model.number="priority" type="number" min="-100" max="100" />
      <button type="button" class="primary-action" :disabled="!draft || isBusy" @click="saveProfile">
        {{ isBusy ? '正在处理…' : '保存当前校准' }}
      </button>
    </div>

    <p v-if="profiles.length === 0 && !isBusy" class="status-message">尚未保存 Profile。完成两点校准后即可保存。</p>
    <ul v-else class="profile-list" aria-label="已保存 Profile">
      <li v-for="profile in profiles" :key="profile.id">
        <div>
          <strong>{{ profile.name }}</strong>
          <small>v{{ profile.profileVersion }} · {{ profile.client.name }} {{ profile.client.version }} · {{ profile.compatibility.dpi.min }}–{{ profile.compatibility.dpi.max }}% · {{ profile.theme }}</small>
          <small>{{ profile.isEnabled ? '已启用' : '已禁用' }} · 优先级 {{ profile.priority }} · {{ profile.matchRules[0]?.mode }} “{{ profile.matchRules[0]?.value }}”</small>
        </div>
        <span v-if="activeProfileId === profile.id" class="status-pill">当前</span>
        <button type="button" class="secondary-action" :disabled="isBusy || !profile.isEnabled" @click="applyProfile(profile)">应用</button>
        <button type="button" class="secondary-action" :disabled="isBusy" @click="duplicateProfile(profile)">复制</button>
        <button type="button" class="secondary-action" :disabled="isBusy" @click="toggleProfile(profile)">{{ profile.isEnabled ? '禁用' : '启用' }}</button>
        <button type="button" class="secondary-action" :disabled="isBusy || profile.profileVersion <= 1" @click="rollbackProfile(profile)">回滚</button>
        <button type="button" class="secondary-action" :disabled="isBusy" @click="exportProfile(profile)">导出</button>
        <button type="button" class="secondary-action" :disabled="isBusy" @click="exportDiagnostics(profile)">诊断</button>
        <button type="button" class="danger-action" :disabled="isBusy" @click="deleteProfile(profile)">删除</button>
      </li>
    </ul>

    <p v-if="issues.length" class="error-message" role="alert">有 {{ issues.length }} 条损坏或不兼容记录已被隔离，应用仍可继续启动。</p>
    <p v-if="message" class="status-message" role="status">{{ message }}</p>
  </section>
</template>
