<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { api, cycleStart, errorText, formatBytes, GB, localTime, ago } from '../api'
import { confirmAction, toast, usePoll } from '../ui'
import BarChart from '../components/BarChart.vue'
import Icon from '../components/Icon.vue'

type Row = {
  id: number; name: string; server: string; engine: string; status: string
  traffic_used: number; traffic_limit_gb: number; traffic_paused: boolean; traffic_at: string | null; reset_day: number
}
const data = ref<{ days: number; nodes: Row[]; daily: { day: string; bytes: number }[] } | null>(null)
async function load() {
  try { data.value = await api('/api/traffic?days=30') } catch (e) { toast(errorText(e), 'err') }
}
onMounted(load)
usePoll(load, 60000)

// servers report every ten minutes; this asks them now
const refreshing = ref(false)
async function refresh() {
  refreshing.value = true
  try {
    const r = await api<{ servers: number }>('/api/traffic/refresh', { method: 'POST' })
    toast(`已向 ${r.servers} 台服务器要最新计数，几秒后更新`, 'info')
    await new Promise((res) => setTimeout(res, 8000))
    await load()
  } catch (e) {
    toast(errorText(e), 'err')
  } finally {
    refreshing.value = false
  }
}

const q = ref('')
type Key = 'name' | 'server' | 'traffic_used' | 'pct'
const sortKey = ref<Key>('traffic_used')
const sortDesc = ref(true)
const pct = (n: Row) => (n.traffic_limit_gb > 0 ? Math.min(100, (n.traffic_used / (n.traffic_limit_gb * GB)) * 100) : 0)
function sortBy(k: Key) {
  if (sortKey.value === k) sortDesc.value = !sortDesc.value
  else { sortKey.value = k; sortDesc.value = k !== 'name' && k !== 'server' }
}
const rows = computed(() => {
  const needle = q.value.trim().toLowerCase()
  const val = (n: Row) => (sortKey.value === 'pct' ? pct(n) : n[sortKey.value])
  return (data.value?.nodes ?? [])
    .filter((n) => !needle || n.name.toLowerCase().includes(needle) || n.server.toLowerCase().includes(needle))
    .sort((a, b) => {
      const x = val(a), y = val(b)
      const c = typeof x === 'string' ? x.localeCompare(String(y)) : Number(x) - Number(y)
      return sortDesc.value ? -c : c
    })
})
const month = computed(() => (data.value?.nodes ?? []).reduce((a, n) => a + n.traffic_used, 0))
const today = computed(() => data.value?.daily.find((d) => d.day === new Date().toISOString().slice(0, 10))?.bytes ?? 0)
const paused = computed(() => (data.value?.nodes ?? []).filter((n) => n.traffic_paused).length)
// 本月 counts from the nodes' reset day: the chart's earlier days are last month's
const since = computed(() => cycleStart((data.value?.nodes ?? []).map((n) => n.reset_day)))
const lastMonthShown = computed(() => !!since.value && (data.value?.daily ?? []).some((d) => d.day < since.value! && d.bytes > 0))
const arrow = (k: Key) => (sortKey.value === k ? (sortDesc.value ? ' ↓' : ' ↑') : '')

async function reset(n: Row) {
  if (!(await confirmAction({ title: `重置 ${n.name} 的流量？`, body: '从 0 重新计算；超额暂停的节点会恢复。', ok: '重置' }))) return
  try {
    await api(`/api/nodes/${n.id}/traffic/reset`, { method: 'POST' })
    toast(`已通知 ${n.server}，几秒后生效`)
    setTimeout(load, 6000)
  } catch (e) {
    toast(errorText(e), 'err')
  }
}
</script>

<template>
  <div class="page-head">
    <div><h1>流量</h1><p>各服务器每 10 分钟上报一次计数。每天的统计按 UTC 日期；每月重置按各服务器自己的时区，在它的重置日零点。</p></div>
    <div class="page-actions">
      <button class="btn" :disabled="refreshing" data-test="traffic-refresh" @click="refresh">
        <span v-if="refreshing" class="spinner" /><Icon v-else name="refresh" />{{ refreshing ? '正在向服务器获取…' : '立即刷新' }}
      </button>
    </div>
  </div>
  <div class="stats section">
    <div class="card stat"><span class="l">本月总流量</span><span class="n" data-test="traffic-month">{{ formatBytes(month) }}</span>
      <span class="s" data-test="traffic-since">{{ since ? `${since.slice(5)} 起算` : data?.nodes.length ? '按各节点的重置日起算' : '' }}</span></div>
    <div class="card stat"><span class="l">今日流量（UTC）</span><span class="n">{{ formatBytes(today) }}</span></div>
    <div class="card stat"><span class="l">超额暂停的节点</span><span class="n" :style="{ color: paused ? 'var(--warn)' : '' }">{{ paused }}</span></div>
  </div>
  <div class="card section">
    <div class="card-head"><h2>最近 30 天</h2>
      <span v-if="lastMonthShown" class="muted" data-test="traffic-chart-note">浅色是 {{ since!.slice(5) }} 清零前的，不计入本月</span></div>
    <BarChart :daily="data?.daily ?? []" :days="30" :since="since" test="traffic-chart" />
  </div>
  <div class="card">
    <div class="toolbar">
      <input v-model="q" class="input search" type="search" placeholder="搜索节点或服务器">
      <span class="grow" /><span class="muted">{{ rows.length }} 个节点</span>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th class="sortable" @click="sortBy('name')">节点{{ arrow('name') }}</th>
          <th class="sortable" @click="sortBy('server')">服务器{{ arrow('server') }}</th>
          <th class="sortable num" @click="sortBy('traffic_used')">本月已用{{ arrow('traffic_used') }}</th>
          <th class="num">上限</th>
          <th class="sortable" style="min-width: 150px" @click="sortBy('pct')">用量{{ arrow('pct') }}</th>
          <th>重置日</th><th>状态</th><th>更新于</th><th class="actions">操作</th>
        </tr></thead>
        <tbody>
          <tr v-for="n in rows" :key="n.id" :data-test="`traffic-${n.name}`">
            <td><b>{{ n.name }}</b></td>
            <td>{{ n.server }}</td>
            <td class="num">{{ formatBytes(n.traffic_used) }}</td>
            <td class="num">{{ n.traffic_limit_gb ? `${n.traffic_limit_gb} GB` : '不限' }}</td>
            <td>
              <div v-if="n.traffic_limit_gb" class="meter"><span :class="{ over: pct(n) >= 80, full: pct(n) >= 100 }" :style="{ width: `${pct(n)}%` }" /></div>
              <span v-else class="faint">—</span>
            </td>
            <td>每月 {{ n.reset_day }} 日</td>
            <td><span class="status" :class="n.traffic_paused ? 'failed' : 'applied'"><span class="dot" />{{ n.traffic_paused ? '已暂停' : '正常' }}</span></td>
            <td :title="localTime(n.traffic_at)">{{ ago(n.traffic_at) }}</td>
            <td class="actions"><button class="btn small ghost" :disabled="n.status !== 'applied'" @click="reset(n)"><Icon name="refresh" />重置</button></td>
          </tr>
        </tbody>
      </table>
      <div v-if="!data" class="skeleton-rows"><div v-for="i in 3" :key="i" class="skeleton" style="height: 22px" /></div>
      <div v-else-if="!data.nodes.length" class="empty">还没有节点。</div>
    </div>
  </div>
</template>
