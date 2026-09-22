<script setup lang="ts">
// 中转: one realm rule per row, each forwarding a port of the entry server to
// somewhere else. The landing side is either another server in the panel or an
// address typed in, and the hop can be encrypted.
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { api, formatBytes, localTime, type Relay, type RelaySample, type Server } from '../api'
import RelayDialog from '../components/RelayDialog.vue'

const relays = ref<Relay[]>([])
const servers = ref<Server[]>([])
const dialog = ref(false)
const editing = ref<Relay | null>(null)
const message = ref('')

async function load() {
  ;[relays.value, servers.value] = await Promise.all([api<Relay[]>('/api/relays'), api<Server[]>('/api/servers')])
}
// While a change is on its way to a server, look again every few seconds.
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  load()
  timer = setInterval(() => {
    if (relays.value.some((r) => r.status === 'queued' || r.status === 'deleting')) load()
  }, 3000)
})
onUnmounted(() => clearInterval(timer))

const serverName = (id: number | null) => (id === null ? '' : servers.value.find((s) => s.id === id)?.name ?? '?')
const statusText: Record<string, string> = { waiting: '待安装', queued: '下发中', applied: '运行中', failed: '失败', deleting: '删除中' }

// ── one relay's history, opened by clicking its row ──────────────────────────
const expanded = ref<number | null>(null)
const samples = ref<Record<number, RelaySample[]>>({})
const loading = ref<number | null>(null)
const hours = ref(6)
const WINDOWS = [1, 6, 24, 168]
const windowLabel = (h: number) => (h === 168 ? '7 天' : `${h} 小时`)

async function toggle(r: Relay) {
  if (expanded.value === r.id) {
    expanded.value = null
    return
  }
  expanded.value = r.id
  await loadSamples(r.id)
}
async function loadSamples(id: number) {
  loading.value = id
  try {
    const m = await api<{ samples: RelaySample[] }>(`/api/relays/${id}/metrics?hours=${hours.value}`)
    samples.value = { ...samples.value, [id]: m.samples }
  } catch (e) {
    message.value = (e as Error).message
  } finally {
    loading.value = null
  }
}
async function pickWindow(h: number) {
  hours.value = h
  if (expanded.value !== null) await loadSamples(expanded.value)
}
// while a row is open, keep its history fresh as new readings arrive
watch(relays, () => {
  if (expanded.value !== null && !loading.value) loadSamples(expanded.value)
})

// ── the charts, drawn as inline SVG (the panel carries no chart library) ─────
const CH = { w: 600, h: 88, pad: 6 }

/**
 * A reading that never connected has no round trip, and a gap must not be
 * drawn as a line through it: the points are returned as separate segments,
 * broken wherever a value is missing.
 */
function lineOf(rows: RelaySample[], pick: (s: RelaySample) => number | null) {
  const vals = rows.map(pick)
  const known = vals.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  const max = known.length ? Math.max(...known) : 0
  const span = max || 1
  const step = rows.length > 1 ? (CH.w - CH.pad * 2) / (rows.length - 1) : 0
  const segments: string[] = []
  let run: string[] = []
  vals.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) {
      if (run.length) segments.push(run.join(' '))
      run = []
      return
    }
    const x = CH.pad + i * step
    const y = CH.h - CH.pad - (v / span) * (CH.h - CH.pad * 2)
    run.push(`${x.toFixed(1)},${y.toFixed(1)}`)
  })
  if (run.length) segments.push(run.join(' '))
  return { segments, max }
}

function barsOf(rows: RelaySample[]) {
  const max = Math.max(1, ...rows.map((s) => s.bytes || 0))
  const bw = rows.length ? (CH.w - CH.pad * 2) / rows.length : 0
  return rows.map((s, i) => {
    const h = ((s.bytes || 0) / max) * (CH.h - CH.pad * 2)
    return { x: CH.pad + i * bw, w: Math.max(1, bw - 1), y: CH.h - CH.pad - h, h,
      title: `${localTime(s.at)} · ${formatBytes(s.bytes || 0)}` }
  })
}

const rowsOf = (id: number) => samples.value[id] ?? []
const avg = (rows: RelaySample[], pick: (s: RelaySample) => number | null) => {
  const v = rows.map(pick).filter((x): x is number => typeof x === 'number' && Number.isFinite(x))
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null
}
const ms = (v: number | null) => (v === null ? '—' : `${v.toFixed(v < 10 ? 2 : 1)} ms`)
const totalBytes = (rows: RelaySample[]) => rows.reduce((a, s) => a + (s.bytes || 0), 0)
const worstLoss = (rows: RelaySample[]) => (rows.length ? Math.max(...rows.map((s) => s.loss_pct || 0)) : 0)

async function remove(r: Relay) {
  if (!confirm(`删除中转 ${r.name}？服务器上的转发规则也会一起删除。`)) return
  try {
    await api(`/api/relays/${r.id}`, { method: 'DELETE' })
    await load()
  } catch (e) {
    message.value = (e as Error).message
  }
}
function openNew() {
  editing.value = null
  dialog.value = true
}
function openEdit(r: Relay) {
  editing.value = r
  dialog.value = true
}
</script>

<template>
  <div class="page-head">
    <div><h1>中转</h1></div>
    <button class="btn primary" data-test="new-relay" @click="openNew">＋ 新建中转</button>
  </div>
  <div v-if="message" class="notice warn" data-test="message">{{ message }}</div>
  <div class="card table-wrap">
    <table>
      <thead>
        <tr><th>ID</th><th>状态</th><th>名称</th><th>入口服务器</th><th>监听端口</th><th>落地</th><th>协议</th><th>加密</th><th>延迟</th><th>抖动</th><th>丢包</th><th>流量</th><th>操作</th></tr>
      </thead>
      <tbody>
        <template v-for="r in relays" :key="r.id">
        <tr :data-test="`relay-${r.name}`" :data-status="r.status" class="relay-row" @click="toggle(r)">
          <td><span class="caret">{{ expanded === r.id ? '▾' : '▸' }}</span>{{ r.id }}</td>
          <td>
            <span class="status" :class="r.status" :title="r.last_error ?? ''"><span class="dot" />{{ statusText[r.status] }}</span>
            <span v-if="r.last_error && r.status === 'applied'" class="badge err" :title="r.last_error">!</span>
          </td>
          <td>{{ r.name }}</td>
          <td>{{ serverName(r.server_id) }}</td>
          <td>{{ r.listen_port }}</td>
          <td>
            {{ r.remote_host }}:{{ r.remote_port }}
            <span v-if="r.remote_server_id" class="label-chip">{{ serverName(r.remote_server_id) }}</span>
          </td>
          <td>{{ r.udp ? 'TCP + UDP' : 'TCP' }}</td>
          <td>
            <template v-if="r.tls">
              TLS<span v-if="r.tls_sni"> · {{ r.tls_sni }}</span>
              <span v-if="r.tls_insecure" class="badge warn" title="接受自签名证书，不验证对端">自签名</span>
            </template>
            <template v-else>否</template>
          </td>
          <td :title="r.last_sample_at ? `测于 ${localTime(r.last_sample_at)}` : '还没有测量数据'">
            {{ r.last_rtt_ms === null ? '—' : `${r.last_rtt_ms.toFixed(1)} ms` }}
          </td>
          <td>{{ r.last_jitter_ms === null ? '—' : `${r.last_jitter_ms.toFixed(1)} ms` }}</td>
          <td>
            <span v-if="r.last_loss_pct === null">—</span>
            <span v-else :class="{ 'badge warn': r.last_loss_pct > 0 }">{{ r.last_loss_pct }}%</span>
          </td>
          <td>{{ formatBytes(r.traffic_bytes) }}</td>
          <td>
            <button class="btn small ghost" :disabled="r.status === 'queued' || r.status === 'deleting'" :data-test="`edit-${r.name}`" @click.stop="openEdit(r)">编辑</button>
            <button class="btn small ghost danger" :disabled="r.status === 'deleting'" @click.stop="remove(r)">删除</button>
          </td>
        </tr>
        <tr v-if="expanded === r.id" class="relay-detail" :data-test="`detail-${r.name}`">
          <td :colspan="13">
            <div class="chart-head">
              <strong>{{ r.name }}</strong>
              <span class="muted">{{ r.listen_port }} → {{ r.remote_host }}:{{ r.remote_port }}</span>
              <span class="grow" />
              <button v-for="h in WINDOWS" :key="h" class="btn small ghost" :class="{ on: hours === h }"
                :data-test="`window-${h}`" @click.stop="pickWindow(h)">{{ windowLabel(h) }}</button>
            </div>

            <div v-if="loading === r.id" class="empty">读取中…</div>
            <div v-else-if="!rowsOf(r.id).length" class="empty">
              这段时间还没有测量数据。psm-agent 每分钟测一次，中转刚建好时要等一两分钟。
            </div>
            <template v-else>
              <div class="chart-stats">
                <span>平均延迟 <b>{{ ms(avg(rowsOf(r.id), (s) => s.rtt_ms)) }}</b></span>
                <span>平均抖动 <b>{{ ms(avg(rowsOf(r.id), (s) => s.jitter_ms)) }}</b></span>
                <span>最高丢包 <b>{{ worstLoss(rowsOf(r.id)) }}%</b></span>
                <span>这段时间流量 <b>{{ formatBytes(totalBytes(rowsOf(r.id))) }}</b></span>
                <span class="muted">{{ rowsOf(r.id).length }} 个样本</span>
              </div>

              <div class="chart">
                <div class="chart-title">延迟 / 抖动（峰值 {{ ms(lineOf(rowsOf(r.id), (s) => s.rtt_ms).max) }}）</div>
                <svg :viewBox="`0 0 ${CH.w} ${CH.h}`" preserveAspectRatio="none" class="chart-svg">
                  <polyline v-for="(seg, i) in lineOf(rowsOf(r.id), (s) => s.rtt_ms).segments" :key="`r${i}`"
                    :points="seg" class="line rtt" />
                  <polyline v-for="(seg, i) in lineOf(rowsOf(r.id), (s) => s.jitter_ms).segments" :key="`j${i}`"
                    :points="seg" class="line jitter" />
                </svg>
                <div class="chart-legend"><span class="key rtt" />延迟<span class="key jitter" />抖动</div>
              </div>

              <div class="chart">
                <div class="chart-title">丢包（峰值 {{ lineOf(rowsOf(r.id), (s) => s.loss_pct).max }}%）</div>
                <svg :viewBox="`0 0 ${CH.w} ${CH.h}`" preserveAspectRatio="none" class="chart-svg">
                  <polyline v-for="(seg, i) in lineOf(rowsOf(r.id), (s) => s.loss_pct).segments" :key="`l${i}`"
                    :points="seg" class="line loss" />
                </svg>
              </div>

              <div class="chart">
                <div class="chart-title">每次测量之间的流量</div>
                <svg :viewBox="`0 0 ${CH.w} ${CH.h}`" preserveAspectRatio="none" class="chart-svg">
                  <rect v-for="(b, i) in barsOf(rowsOf(r.id))" :key="`b${i}`"
                    :x="b.x" :y="b.y" :width="b.w" :height="b.h" class="bar"><title>{{ b.title }}</title></rect>
                </svg>
              </div>

              <div class="muted chart-foot">
                最后一次测量：{{ localTime(r.last_sample_at) }} · 面板保留 7 天
                <template v-if="r.last_error"> · 最近一次错误：{{ r.last_error }}</template>
              </div>
            </template>
          </td>
        </tr>
        </template>
      </tbody>
    </table>
    <div v-if="!relays.length" class="empty">还没有中转，点右上角“新建中转”。</div>
  </div>
  <RelayDialog v-if="dialog" :servers="servers" :relay="editing" @close="dialog = false; load()" @created="load" />
</template>

<style scoped>
.relay-row { cursor: pointer; }
.caret { display: inline-block; width: 1em; color: var(--muted, #8a8f98); }

.relay-detail > td { background: var(--bg-soft, #fafafa); padding: 12px 16px 16px; }
.chart-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.chart-head .grow { flex: 1; }
.chart-head .btn.on { background: var(--accent-soft, #e8eefc); font-weight: 600; }

.chart-stats { display: flex; flex-wrap: wrap; gap: 16px; margin-bottom: 10px; font-size: 12px; }
.chart-stats b { font-variant-numeric: tabular-nums; }

.chart { margin-bottom: 12px; }
.chart-title { font-size: 12px; color: var(--muted, #8a8f98); margin-bottom: 2px; }
/* the viewBox is stretched to the card's width; the height stays readable */
.chart-svg { width: 100%; height: 88px; display: block; background: var(--bg, #fff); border-radius: 6px; }

/* a polyline is filled black by default: these three lines are what make it a chart */
.line { fill: none; stroke-width: 1.5; vector-effect: non-scaling-stroke; }
.line.rtt { stroke: #3b82f6; }
.line.jitter { stroke: #a78bfa; }
.line.loss { stroke: #ef4444; }
.bar { fill: #64748b; opacity: 0.75; }

.chart-legend { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted, #8a8f98); margin-top: 2px; }
.key { display: inline-block; width: 10px; height: 2px; }
.key.rtt { background: #3b82f6; }
.key.jitter { background: #a78bfa; margin-left: 10px; }
.chart-foot { font-size: 12px; }
</style>
