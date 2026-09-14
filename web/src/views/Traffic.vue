<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { api, formatBytes, localTime, GB } from '../api'

type Row = {
  id: number; name: string; server: string; engine: string; status: string
  traffic_used: number; traffic_limit_gb: number; traffic_paused: boolean; traffic_at: string | null; reset_day: number
}
const data = ref<{ days: number; nodes: Row[]; daily: { day: string; bytes: number }[] } | null>(null)
const message = ref('')

async function load() {
  data.value = await api('/api/traffic?days=30')
}
onMounted(load)

// servers report every ten minutes; this asks them now
const refreshing = ref(false)
async function refresh() {
  refreshing.value = true
  try {
    await api('/api/traffic/refresh', { method: 'POST' })
    await new Promise((r) => setTimeout(r, 8000))
    await load()
  } finally {
    refreshing.value = false
  }
}

// the last 30 days, one bar each (days without traffic included)
const bars = computed(() => {
  const byDay = new Map((data.value?.daily ?? []).map((d) => [d.day, d.bytes]))
  const out: { day: string; bytes: number }[] = []
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10)
    out.push({ day: d, bytes: byDay.get(d) ?? 0 })
  }
  return out
})
const peak = computed(() => Math.max(1, ...bars.value.map((b) => b.bytes)))
const month = computed(() => (data.value?.nodes ?? []).reduce((a, n) => a + n.traffic_used, 0))
const today = computed(() => bars.value[bars.value.length - 1]?.bytes ?? 0)
const paused = computed(() => (data.value?.nodes ?? []).filter((n) => n.traffic_paused).length)
const pct = (n: Row) => (n.traffic_limit_gb > 0 ? Math.min(100, (n.traffic_used / (n.traffic_limit_gb * GB)) * 100) : 0)

async function reset(n: Row) {
  if (!confirm(`把 ${n.name} 的流量从 0 重新计算？超额暂停的节点会恢复。`)) return
  try {
    await api(`/api/nodes/${n.id}/traffic/reset`, { method: 'POST' })
    message.value = `已通知 ${n.server}，几秒后生效。`
    setTimeout(load, 6000)
  } catch (e) {
    message.value = (e as Error).message
  }
}
</script>

<template>
  <div class="page-head">
    <div><h1>流量</h1><p>各节点本月流量（按重置日清零）和最近 30 天的每日流量。超出上限的节点由服务器自动暂停，直到重置。</p></div>
    <button class="btn" :disabled="refreshing" data-test="traffic-refresh" @click="refresh">{{ refreshing ? '正在向服务器获取…' : '立即刷新' }}</button>
  </div>
  <div v-if="message" class="notice ok">{{ message }}</div>
  <div class="stats" style="margin-bottom: 16px">
    <div class="card stat"><div class="n" data-test="traffic-month">{{ formatBytes(month) }}</div><div class="l">本月总流量</div></div>
    <div class="card stat"><div class="n">{{ formatBytes(today) }}</div><div class="l">今日流量</div></div>
    <div class="card stat"><div class="n">{{ paused }}</div><div class="l">超额暂停的节点</div></div>
  </div>
  <div class="card chart" data-test="traffic-chart">
    <div v-for="b in bars" :key="b.day" class="bar" :title="`${b.day}：${formatBytes(b.bytes)}`">
      <span :style="{ height: `${(b.bytes / peak) * 100}%` }" />
    </div>
  </div>
  <div class="card table-wrap" style="margin-top: 16px">
    <table>
      <thead><tr><th>节点</th><th>服务器</th><th>本月已用</th><th>上限</th><th style="min-width: 160px">用量</th><th>重置日</th><th>状态</th><th>更新于</th><th>操作</th></tr></thead>
      <tbody>
        <tr v-for="n in data?.nodes ?? []" :key="n.id" :data-test="`traffic-${n.name}`">
          <td>{{ n.name }}</td>
          <td>{{ n.server }}</td>
          <td>{{ formatBytes(n.traffic_used) }}</td>
          <td>{{ n.traffic_limit_gb ? `${n.traffic_limit_gb} GB` : '不限' }}</td>
          <td><div class="meter"><span :class="{ over: pct(n) >= 90 }" :style="{ width: `${pct(n)}%` }" /></div></td>
          <td>每月 {{ n.reset_day }} 日</td>
          <td><span class="status" :class="n.traffic_paused ? 'failed' : 'applied'"><span class="dot" />{{ n.traffic_paused ? '已暂停' : '正常' }}</span></td>
          <td>{{ localTime(n.traffic_at) }}</td>
          <td><button class="btn small ghost" :disabled="n.status !== 'applied'" @click="reset(n)">重置</button></td>
        </tr>
      </tbody>
    </table>
    <div v-if="data && !data.nodes.length" class="empty">还没有节点。</div>
  </div>
</template>
