<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api, ApiError, localTime, type Subscription } from '../api'

const subs = ref<Subscription[]>([])
const name = ref('')
const labels = ref<string[]>([])
const labelDraft = ref('')
const error = ref('')
const copied = ref('')

const formats = [
  { id: '', label: '通用（自动识别）', help: 'v2rayN、Shadowrocket、Hiddify、NekoBox 等；Clash / sing-box / Surge 客户端会自动拿到各自的格式' },
  { id: 'clash', label: 'Clash / mihomo', help: 'Clash Verge、Mihomo Party、Stash' },
  { id: 'singbox', label: 'sing-box', help: 'sing-box 官方客户端（SFA / SFI / SFM）' },
  { id: 'surge', label: 'Surge', help: 'Snell 节点' },
]
const urlFor = (s: Subscription, f: string) => (f ? `${s.url}?format=${f}` : s.url)

async function load() {
  subs.value = await api<Subscription[]>('/api/subscriptions')
}
onMounted(load)

function addLabel() {
  const l = labelDraft.value.trim()
  if (l && !labels.value.includes(l)) labels.value.push(l)
  labelDraft.value = ''
}
async function create() {
  error.value = ''
  try {
    await api('/api/subscriptions', { method: 'POST', body: JSON.stringify({ name: name.value, labels: labels.value }) })
    name.value = ''
    labels.value = []
    await load()
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : String(e)
  }
}
async function copy(text: string) {
  await navigator.clipboard.writeText(text).catch(() => undefined)
  copied.value = text
  setTimeout(() => (copied.value = ''), 1500)
}
async function reset(s: Subscription) {
  if (!confirm(`重置 ${s.name} 的地址？旧地址立即失效，客户端要换成新地址。`)) return
  await api(`/api/subscriptions/${s.id}/reset`, { method: 'POST' })
  await load()
}
async function remove(s: Subscription) {
  if (!confirm(`删除订阅 ${s.name}？`)) return
  await api(`/api/subscriptions/${s.id}`, { method: 'DELETE' })
  await load()
}
</script>

<template>
  <div class="page-head">
    <div><h1>订阅</h1><p>把所有服务器上运行中的节点汇总成一个订阅地址（可按节点标签筛选）。超额暂停的节点不会出现在订阅里。</p></div>
  </div>
  <form class="card" style="padding: 16px; margin-bottom: 16px" @submit.prevent="create">
    <div class="row2">
      <div class="field">
        <label>订阅名称</label>
        <input v-model="name" class="input" placeholder="例如 我的手机" data-test="sub-name">
      </div>
      <div class="field">
        <label>只包含带这些标签的节点（留空为全部）</label>
        <div class="chips">
          <span v-for="l in labels" :key="l" class="chip">{{ l }}<button type="button" @click="labels = labels.filter((x) => x !== l)">×</button></span>
          <input v-model="labelDraft" placeholder="输入后回车添加" @keydown.enter.prevent="addLabel">
        </div>
      </div>
    </div>
    <div v-if="error" class="notice err">{{ error }}</div>
    <button class="btn primary" type="submit" data-test="sub-create">新建订阅</button>
  </form>

  <div v-for="s in subs" :key="s.id" class="card sub" :data-test="`sub-${s.name}`">
    <div class="sub-head">
      <div>
        <strong>{{ s.name }}</strong>
        <span v-for="l in s.labels" :key="l" class="label-chip" style="margin-left: 8px">{{ l }}</span>
        <span v-if="!s.labels.length" class="muted" style="margin-left: 8px">全部节点</span>
      </div>
      <div class="muted">最近更新：{{ localTime(s.last_used) }}</div>
    </div>
    <div v-for="f in formats" :key="f.id" class="sub-row">
      <div class="sub-format"><div>{{ f.label }}</div><div class="muted small">{{ f.help }}</div></div>
      <div class="cmd">
        <code :data-test="`sub-url-${f.id || 'auto'}`">{{ urlFor(s, f.id) }}</code>
        <button class="btn" type="button" @click="copy(urlFor(s, f.id))">{{ copied === urlFor(s, f.id) ? '已复制' : '复制' }}</button>
      </div>
    </div>
    <div class="sub-actions">
      <button class="btn small ghost" @click="reset(s)">重置地址</button>
      <button class="btn small ghost danger" @click="remove(s)">删除</button>
    </div>
  </div>
  <div v-if="!subs.length" class="card empty">还没有订阅。</div>
</template>
