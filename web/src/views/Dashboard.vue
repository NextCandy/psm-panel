<script setup lang="ts">
// 仪表盘: what is running, what needs a look, the traffic — one request
// (/api/overview), counted in D1, nothing decrypted.
import { computed, onMounted, ref } from 'vue'
import { api, cycleStart, errorText, formatBytes } from '../api'
import { usePoll, toast } from '../ui'
import BarChart from '../components/BarChart.vue'
import Icon from '../components/Icon.vue'

type Count = { status: string; n: number }
type Overview = {
  version: string
  servers: Count[]
  nodes: (Count & { used: number | null; paused: number | null })[]
  relays: (Count & { bytes: number | null; paused: number | null; lossy: number | null })[]
  daily: { day: string; bytes: number }[]
  problems: { type: 'node' | 'relay'; id: number; name: string; server: string; error: string | null }[]
  reset_days: number[]
}
const o = ref<Overview | null>(null)
async function load() {
  try { o.value = await api<Overview>('/api/overview') } catch (e) { toast(errorText(e), 'err') }
}
onMounted(load)
usePoll(load, 30000)

const sum = <T extends Count>(rows: T[] | undefined, pick: (r: T) => number = (r) => r.n, only?: string[]) =>
  (rows ?? []).filter((r) => !only || only.includes(r.status)).reduce((a, r) => a + (pick(r) || 0), 0)
const serversTotal = computed(() => sum(o.value?.servers))
const online = computed(() => sum(o.value?.servers, undefined, ['online']))
const nodesTotal = computed(() => sum(o.value?.nodes))
const running = computed(() => sum(o.value?.nodes, undefined, ['applied']))
const failed = computed(() => sum(o.value?.nodes, undefined, ['failed']))
const paused = computed(() => sum(o.value?.nodes, (r) => r.paused ?? 0))
const month = computed(() => sum(o.value?.nodes, (r) => r.used ?? 0))
const relaysTotal = computed(() => sum(o.value?.relays))
const relaysUp = computed(() => sum(o.value?.relays, undefined, ['applied']))
const relaysBad = computed(() => sum(o.value?.relays, undefined, ['failed']))
const relaysPaused = computed(() => sum(o.value?.relays, (r) => r.paused ?? 0))
const relaysLossy = computed(() => sum(o.value?.relays, (r) => r.lossy ?? 0))
const today = computed(() => o.value?.daily.find((d) => d.day === new Date().toISOString().slice(0, 10))?.bytes ?? 0)
const fortnight = computed(() => (o.value?.daily ?? []).reduce((a, d) => a + d.bytes, 0))
// 本月 counts from the nodes' reset day: the chart's earlier days are last month's
const since = computed(() => cycleStart(o.value?.reset_days ?? []))
const lastMonthShown = computed(() => !!since.value && (o.value?.daily ?? []).some((d) => d.day < since.value! && d.bytes > 0))
</script>

<template>
  <div class="page-head">
    <div><h1>仪表盘</h1><p>服务器、节点、中转和流量概况。</p></div>
    <div class="page-actions"><button class="btn" type="button" @click="load"><Icon name="refresh" />刷新</button></div>
  </div>

  <div v-if="!o" class="stats section">
    <div v-for="i in 5" :key="i" class="card stat"><div class="skeleton" style="width: 60%" /><div class="skeleton" style="height: 26px; margin-top: 8px" /></div>
  </div>
  <template v-else>
    <div class="stats section">
      <a class="card stat link" href="#/servers">
        <span class="l"><Icon name="servers" />服务器</span>
        <span class="n"><span data-test="online-count">{{ online }}</span><span class="faint" style="font-size: 16px"> / {{ serversTotal }}</span></span>
        <span class="s">在线 / 全部</span>
      </a>
      <a class="card stat link" href="#/nodes">
        <span class="l"><Icon name="nodes" />节点</span>
        <span class="n">{{ running }}<span class="faint" style="font-size: 16px"> / {{ nodesTotal }}</span></span>
        <span class="s">运行中<template v-if="failed"> · <b style="color: var(--err)">{{ failed }} 个失败</b></template><template v-if="paused"> · {{ paused }} 个超额暂停</template></span>
      </a>
      <a class="card stat link" href="#/relays">
        <span class="l"><Icon name="relays" />中转</span>
        <span class="n">{{ relaysUp }}<span class="faint" style="font-size: 16px"> / {{ relaysTotal }}</span></span>
        <span class="s">运行中<template v-if="relaysBad"> · <b style="color: var(--err)">{{ relaysBad }} 条失败</b></template><template v-if="relaysPaused"> · {{ relaysPaused }} 条暂停</template><template v-if="relaysLossy"> · {{ relaysLossy }} 条丢包</template></span>
      </a>
      <a class="card stat link" href="#/traffic">
        <span class="l"><Icon name="traffic" />本月流量</span>
        <span class="n" data-test="dash-month">{{ formatBytes(month) }}</span>
        <span class="s" data-test="dash-since">{{ since ? `${since.slice(5)} 起算 · ` : nodesTotal ? '按各节点的重置日 · ' : '' }}今日 {{ formatBytes(today) }}</span>
      </a>
    </div>

    <div class="grid-2 section">
      <div class="card">
        <div class="card-head"><h2>最近 14 天</h2>
          <span class="muted" data-test="dash-chart-note">共 {{ formatBytes(fortnight) }}{{ lastMonthShown ? `，浅色是 ${since!.slice(5)} 清零前的` : '' }}（按 UTC 日期）</span></div>
        <BarChart :daily="o.daily" :days="14" :since="since" test="dash-chart" />
      </div>
      <div class="card">
        <div class="card-head"><h2>需要处理</h2><span class="muted">{{ o.problems.length ? `${o.problems.length} 项` : '' }}</span></div>
        <ul v-if="o.problems.length" class="list-plain" data-test="problems">
          <li v-for="p in o.problems" :key="`${p.type}-${p.id}`">
            <span class="badge err" style="margin: 0">{{ p.type === 'node' ? '节点' : '中转' }}</span>
            <a :href="p.type === 'node' ? '#/nodes' : '#/relays'"><b>{{ p.server }}/{{ p.name }}</b></a>
            <span class="muted small ellipsis" :title="p.error ?? ''">{{ p.error || '失败' }}</span>
          </li>
        </ul>
        <div v-else class="empty"><div class="big">✓</div>一切正常</div>
      </div>
    </div>
  </template>
</template>
