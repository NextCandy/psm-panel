<script setup lang="ts">
// 中转: forwards (entry → landing) and tunnels (entry → exit → landing), with
// each one's hop measured every minute by psm-agent. A row opens onto its
// charts, its landing hosts' health and its settings.
import { computed, onMounted, ref, watch } from 'vue'
import { RELAY_STRATEGY_LABELS, RELAY_TRANSPORT_LABELS } from '@shared/relays'
import { ago, api, errorText, formatBytes, GB, localTime, NODE_STATUS, parseTime, type PanelNode, type Relay, type RelaySample, type Server } from '../api'
import { confirmAction, toast, usePoll } from '../ui'
import RelayDialog from '../components/RelayDialog.vue'
import RelayLink from '../components/RelayLink.vue'
import RowMenu from '../components/RowMenu.vue'
import TimeSeries from '../components/TimeSeries.vue'
import Icon from '../components/Icon.vue'
import { byteTick, byteTicks, niceTicks, type Panel } from '../chart'

const relays = ref<Relay[]>([])
const servers = ref<Server[]>([])
const nodes = ref<PanelNode[]>([])
const loaded = ref(false)
const dialog = ref<null | { relay: Relay | null; batch: boolean }>(null)
const linkOf = ref<Relay | null>(null)

async function load() {
  try {
    ;[relays.value, servers.value, nodes.value] = await Promise.all([
      api<Relay[]>('/api/relays'), api<Server[]>('/api/servers'), api<PanelNode[]>('/api/nodes')])
  } catch (e) {
    toast(errorText(e), 'err')
  } finally {
    loaded.value = true
  }
}
onMounted(load)
const moving = (r: Relay) => ['queued', 'deleting', 'pending'].includes(r.status) || ['queued', 'deleting'].includes(r.exit_status)
usePoll(load, 30000, () => relays.value.some(moving))

const serverName = (id: number | null) => (id === null ? '' : servers.value.find((s) => s.id === id)?.name ?? '?')
const nodeOf = (r: Relay) => (r.node_id === null ? undefined : nodes.value.find((n) => n.id === r.node_id))

// ── search and filters ───────────────────────────────────────────────────────
const q = ref('')
const fServer = ref<number | ''>('')
const fMode = ref('')
const fStatus = ref('')
const problem = (r: Relay) => r.status === 'failed' || r.exit_status === 'failed' || !!r.paused || (r.last_loss_pct ?? 0) > 0
const shown = computed(() => {
  const needle = q.value.trim().toLowerCase()
  return relays.value.filter((r) =>
    (!needle || r.name.toLowerCase().includes(needle) || String(r.listen_port) === needle ||
      r.targets.some((t) => t.host.toLowerCase().includes(needle)) || r.exit_host.toLowerCase().includes(needle)) &&
    (fServer.value === '' || r.server_id === fServer.value || r.exit_server_id === fServer.value) &&
    (!fMode.value || r.mode === fMode.value) &&
    (!fStatus.value || (fStatus.value === 'problem' ? problem(r) : r.status === fStatus.value)))
})
const filtered = computed(() => !!(q.value || fServer.value !== '' || fMode.value || fStatus.value))

// ── what a row says ──────────────────────────────────────────────────────────
const ms = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v.toFixed(v < 10 ? 1 : 0)} ms`)
const rttClass = (v: number | null) => (v === null ? '' : v > 250 ? 'bad' : v > 120 ? 'meh' : 'good')
const quotaPct = (r: Relay) => (r.limit_gb > 0 ? Math.min(100, ((r.quota_used ?? 0) / (r.limit_gb * GB)) * 100) : 0)
function expiry(r: Relay): { text: string; cls: string } | null {
  const d = parseTime(r.expires_at)
  if (!d) return null
  const days = (d.getTime() - Date.now()) / 86400000
  if (days <= 0) return { text: '已到期', cls: 'err' }
  return { text: `${ago(r.expires_at)}到期`, cls: days < 7 ? 'warn' : '' }
}
const healthOf = (r: Relay, host: string, port: number) => r.target_health?.find((h) => h.host === host && h.port === port)

// ── one relay's history, opened by clicking its row ──────────────────────────
const expanded = ref<number | null>(null)
const samples = ref<Record<number, RelaySample[]>>({})
const loading = ref<number | null>(null)
const hours = ref(6)
const WINDOWS = [1, 6, 24, 168]
const windowLabel = (h: number) => (h === 168 ? '7 天' : `${h} 小时`)
async function toggle(r: Relay) {
  if (expanded.value === r.id) { expanded.value = null; return }
  expanded.value = r.id
  await loadSamples(r.id)
}
async function loadSamples(id: number) {
  loading.value = id
  try {
    const m = await api<{ samples: RelaySample[] }>(`/api/relays/${id}/metrics?hours=${hours.value}`)
    samples.value = { ...samples.value, [id]: m.samples }
  } catch (e) {
    toast(errorText(e), 'err')
  } finally {
    loading.value = null
  }
}
async function pickWindow(h: number) {
  hours.value = h
  if (expanded.value !== null) await loadSamples(expanded.value)
}
// while a row is open, its history follows the list's refreshes
watch(relays, () => { if (expanded.value !== null && loading.value === null) loadSamples(expanded.value) })

// ── the charts: one time axis, a panel per measure (TimeSeries) ──────────────
function panelsOf(rows: RelaySample[]): Panel[] {
  return [
    { title: '延迟 / 抖动', format: (v) => ms(v), tick: (v) => `${v} ms`, ticks: (m) => niceTicks(m, 2),
      series: [{ label: '延迟', cls: 's-rtt', values: rows.map((s) => s.rtt_ms) },
        { label: '抖动', cls: 's-jitter', values: rows.map((s) => s.jitter_ms) }] },
    { title: '丢包', area: true, format: (v) => `${+v.toFixed(1)}%`, tick: (v) => `${v}%`, ticks: (m) => niceTicks(Math.max(m, 1), 2),
      series: [{ label: '丢包', cls: 's-loss', values: rows.map((s) => s.loss_pct ?? 0) }] },
    { title: '流量', area: true, format: formatBytes, tick: byteTick, ticks: (m) => byteTicks(m, 2),
      series: [{ label: '流量', cls: 's-traffic', values: rows.map((s) => s.bytes || 0) }] },
  ]
}
const rowsOf = (id: number) => samples.value[id] ?? []
const avg = (rows: RelaySample[], pick: (s: RelaySample) => number | null) => {
  const v = rows.map(pick).filter((x): x is number => typeof x === 'number' && Number.isFinite(x))
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null
}
const totalBytes = (rows: RelaySample[]) => rows.reduce((a, s) => a + (s.bytes || 0), 0)
const worstLoss = (rows: RelaySample[]) => (rows.length ? Math.max(...rows.map((s) => s.loss_pct || 0)) : 0)

// ── actions ──────────────────────────────────────────────────────────────────
async function remove(r: Relay) {
  // A relay whose server never answers again would stay in 删除中 for ever, so
  // that state has to offer a way out: forget it here.
  const stuck = r.status === 'deleting' || r.exit_status === 'deleting'
  const ok = await confirmAction(stuck
    ? { title: `只从面板移除 ${r.name}？`, danger: true, ok: '只从面板移除',
        body: '它一直停在删除中，服务器没有回应。\n服务器上的规则不会被删掉；那台机器如果还在，请在它上面执行 psm relay delete 清理。' }
    : { title: `删除中转 ${r.name}？`, danger: true, ok: '删除',
        body: r.mode === 'tunnel' ? '入口和出口两台服务器上的规则都会删除。' : '服务器上的转发规则也会一起删除。' })
  if (!ok) return
  try {
    await api(`/api/relays/${r.id}${stuck ? '?force=1' : ''}`, { method: 'DELETE' })
    toast(stuck ? `${r.name} 已从面板移除` : `正在删除 ${r.name}`)
    await load()
  } catch (e) {
    toast(errorText(e), 'err')
  }
}
const statusText = (s: string) => NODE_STATUS[s] ?? s
</script>

<template>
  <div class="page-head">
    <div><h1>中转</h1><p>直接转发（realm / gost）或加密隧道（gost）。延迟和丢包由入口服务器每分钟测一次。</p></div>
    <div class="page-actions">
      <button class="btn" data-test="batch-relays" :disabled="!servers.length" @click="dialog = { relay: null, batch: true }"><Icon name="layers" />批量添加</button>
      <button class="btn primary" data-test="new-relay" @click="dialog = { relay: null, batch: false }"><Icon name="plus" />新建中转</button>
    </div>
  </div>

  <div class="card">
    <div class="toolbar">
      <input v-model="q" class="input search" type="search" placeholder="搜索名称、端口、落地地址" data-test="relay-search">
      <select v-model="fServer" class="select">
        <option value="">全部服务器</option>
        <option v-for="s in servers" :key="s.id" :value="s.id">{{ s.name }}</option>
      </select>
      <select v-model="fMode" class="select">
        <option value="">全部方式</option><option value="forward">直接转发</option><option value="tunnel">隧道</option>
      </select>
      <select v-model="fStatus" class="select">
        <option value="">全部状态</option><option value="applied">运行中</option><option value="problem">有问题</option>
        <option value="queued">下发中</option><option value="waiting">待安装</option>
      </select>
      <span class="grow" />
      <span class="muted">{{ filtered ? `${shown.length} / ` : '' }}{{ relays.length }} 条中转</span>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>中转</th><th>状态</th><th>入口</th><th>落地</th><th>延迟 / 丢包</th><th>流量</th><th class="actions">操作</th></tr>
        </thead>
        <tbody>
          <template v-for="r in shown" :key="r.id">
            <tr :data-test="`relay-${r.name}`" :data-status="r.status" :data-exit-status="r.exit_status" class="clickable" @click="toggle(r)">
              <td>
                <span class="caret">{{ expanded === r.id ? '▾' : '▸' }}</span><b>{{ r.name }}</b>
                <span class="sub">
                  <span class="badge" :class="r.mode === 'tunnel' ? 'accent' : ''" style="margin-left: 0">{{ r.mode === 'tunnel' ? '隧道' : '转发' }}</span>
                  <span class="badge">{{ r.engine }}</span>
                </span>
              </td>
              <td>
                <span class="status" :class="r.status" :title="r.last_error ?? ''"><span class="dot" />{{ statusText(r.status) }}</span>
                <span v-if="r.paused" class="badge warn">{{ r.paused === 'expired' ? '已到期' : '超额暂停' }}</span>
                <span v-if="r.last_error && r.status !== 'failed'" class="badge err" :title="r.last_error">!</span>
                <span v-if="r.mode === 'tunnel'" class="sub">
                  出口：<span class="status" :class="r.exit_status" :title="r.exit_error ?? ''"><span class="dot" />{{ statusText(r.exit_status) }}</span>
                  <span v-if="r.exit_error" class="badge err" :title="r.exit_error">!</span>
                </span>
                <span v-if="r.status === 'failed' && r.last_error" class="sub ellipsis" :title="r.last_error">{{ r.last_error }}</span>
              </td>
              <td>
                {{ serverName(r.server_id) }}<span class="mono">:{{ r.listen_port }}</span>
                <span v-if="r.auto_port" class="badge" title="自动分配的端口">自动</span>
                <span class="sub">{{ r.udp ? 'TCP + UDP' : 'TCP' }}<template v-if="r.tls"> · TLS</template><template v-if="r.speed_mbps"> · {{ r.speed_mbps }} Mbit/s</template></span>
              </td>
              <td>
                <template v-if="r.mode === 'tunnel'">
                  <span class="small">经 <b>{{ serverName(r.exit_server_id) }}</b><span class="mono">:{{ r.exit_port ?? '…' }}</span></span>
                  <span class="badge">{{ RELAY_TRANSPORT_LABELS[r.transport] ?? r.transport }}</span>
                  <span class="sub mono">→ {{ r.targets[0]?.host }}:{{ r.targets[0]?.port }}<template v-if="r.targets.length > 1"> 等 {{ r.targets.length }} 个</template></span>
                </template>
                <template v-else>
                  <span class="mono">{{ r.targets[0]?.host }}:{{ r.targets[0]?.port }}</span>
                  <span v-if="r.targets[0]?.server_id && !nodeOf(r)" class="label-chip" style="margin-left: 4px">{{ serverName(r.targets[0].server_id) }}</span>
                  <span v-if="r.targets.length > 1" class="sub">共 {{ r.targets.length }} 个 · {{ RELAY_STRATEGY_LABELS[r.strategy] }}</span>
                </template>
                <span v-if="nodeOf(r)" class="sub" :data-test="`parent-${r.name}`">
                  节点 <b>{{ serverName(nodeOf(r)!.server_id) }}/{{ nodeOf(r)!.name }}</b>
                  <span v-if="r.in_sub" class="badge info" title="这个节点经这条中转也进订阅">进订阅</span>
                </span>
              </td>
              <td :title="r.last_sample_at ? `测于 ${localTime(r.last_sample_at)}` : '还没有测量数据'">
                <span class="rtt" :class="rttClass(r.last_rtt_ms)">{{ ms(r.last_rtt_ms) }}</span>
                <span v-if="(r.last_loss_pct ?? 0) > 0" class="badge warn">{{ r.last_loss_pct }}%</span>
                <span class="sub">
                  <template v-if="r.mode === 'tunnel'">出口→落地 {{ ms(r.exit_rtt_ms) }}<template v-if="(r.exit_loss_pct ?? 0) > 0"> · 丢 {{ r.exit_loss_pct }}%</template></template>
                  <template v-else>抖动 {{ ms(r.last_jitter_ms) }}</template>
                </span>
              </td>
              <td>
                {{ formatBytes(r.traffic_bytes) }}
                <template v-if="r.limit_gb">
                  <span class="sub">本月 {{ formatBytes(r.quota_used ?? 0) }} / {{ r.limit_gb }} GB</span>
                  <div class="meter" style="margin-top: 3px"><span :class="{ over: quotaPct(r) >= 80, full: quotaPct(r) >= 100 }" :style="{ width: `${quotaPct(r)}%` }" /></div>
                </template>
                <span v-if="expiry(r)" class="sub" :style="{ color: expiry(r)!.cls === 'err' ? 'var(--err)' : expiry(r)!.cls === 'warn' ? 'var(--warn)' : '' }">{{ expiry(r)!.text }}</span>
              </td>
              <td class="actions" @click.stop>
                <span class="row-actions">
                  <button class="btn small ghost" :disabled="moving(r)" :data-test="`edit-${r.name}`" @click="dialog = { relay: r, batch: false }"><Icon name="edit" />编辑</button>
                  <RowMenu :test="`more-${r.name}`">
                    <template v-if="r.node_id !== null">
                      <button type="button" :data-test="`relay-link-${r.name}`" @click="linkOf = r"><Icon name="link" />经中转的链接</button>
                      <hr>
                    </template>
                    <button type="button" class="danger" :data-test="`delete-${r.name}`" @click="remove(r)">
                      <Icon name="trash" />{{ r.status === 'deleting' || r.exit_status === 'deleting' ? '强制移除' : '删除' }}
                    </button>
                  </RowMenu>
                </span>
              </td>
            </tr>
            <tr v-if="expanded === r.id" class="relay-detail" :data-test="`detail-${r.name}`">
              <td :colspan="7">
                <div class="detail-grid">
                  <div>
                    <div class="chart-head">
                      <strong>链路质量</strong><span class="grow" />
                      <button v-for="h in WINDOWS" :key="h" class="btn small ghost" :class="{ on: hours === h }" :data-test="`window-${h}`" @click.stop="pickWindow(h)">{{ windowLabel(h) }}</button>
                    </div>
                    <div v-if="loading === r.id && !rowsOf(r.id).length" class="empty">读取中…</div>
                    <div v-else-if="!rowsOf(r.id).length" class="empty">这段时间还没有测量数据。psm-agent 每分钟测一次，中转刚建好时要等一两分钟。</div>
                    <template v-else>
                      <div class="chart-stats">
                        <span>平均延迟 <b>{{ ms(avg(rowsOf(r.id), (s) => s.rtt_ms)) }}</b></span>
                        <span>平均抖动 <b>{{ ms(avg(rowsOf(r.id), (s) => s.jitter_ms)) }}</b></span>
                        <span>最高丢包 <b>{{ worstLoss(rowsOf(r.id)) }}%</b></span>
                        <span>这段时间流量 <b>{{ formatBytes(totalBytes(rowsOf(r.id))) }}</b></span>
                      </div>
                      <TimeSeries :times="rowsOf(r.id).map((s) => s.at)" :panels="panelsOf(rowsOf(r.id))" :test="`chart-${r.name}`" />
                    </template>
                  </div>
                  <div>
                    <strong>落地</strong>
                    <table class="mini">
                      <tbody>
                        <tr v-for="(t, i) in r.targets" :key="i" :data-test="`target-${r.name}-${i}`">
                          <td class="mono">{{ t.host }}:{{ t.port }}<span v-if="t.server_id" class="label-chip" style="margin-left: 4px">{{ serverName(t.server_id) }}</span></td>
                          <td>
                            <template v-if="healthOf(r, t.host, t.port)">
                              <span class="status" :class="healthOf(r, t.host, t.port)!.rtt_ms === null ? 'failed' : 'applied'"><span class="dot" />
                                {{ healthOf(r, t.host, t.port)!.rtt_ms === null ? '连不上' : ms(healthOf(r, t.host, t.port)!.rtt_ms) }}</span>
                            </template>
                            <span v-else class="faint">—</span>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                    <dl class="facts small" style="margin-top: 12px">
                      <template v-if="r.mode === 'tunnel'">
                        <dt>出口</dt><dd>{{ serverName(r.exit_server_id) }} · <span class="mono">{{ r.exit_host }}:{{ r.exit_port ?? '…' }}</span></dd>
                        <dt>传输</dt><dd>{{ RELAY_TRANSPORT_LABELS[r.transport] ?? r.transport }}<template v-if="r.tls_sni"> · SNI {{ r.tls_sni }}</template><template v-if="r.ws_path"> · {{ r.ws_path }}</template></dd>
                        <dt>证书</dt><dd>{{ r.exit_pinned ? '已钉住出口的证书' : '等待出口的证书' }}</dd>
                      </template>
                      <template v-else-if="r.tls">
                        <dt>TLS</dt><dd>{{ r.tls_sni }}<template v-if="r.tls_insecure"> · 接受自签名</template></dd>
                      </template>
                      <template v-if="nodeOf(r)">
                        <dt>节点</dt><dd>{{ serverName(nodeOf(r)!.server_id) }}/{{ nodeOf(r)!.name }}{{ r.in_sub ? ' · 进订阅' : ' · 不进订阅' }}</dd>
                        <dt>入口地址</dt><dd class="mono">{{ r.entry_host || servers.find((s) => s.id === r.server_id)?.last_ip || '—' }}<span v-if="!r.entry_host" class="faint">（自动）</span></dd>
                      </template>
                      <dt>分配</dt><dd>{{ r.targets.length > 1 ? RELAY_STRATEGY_LABELS[r.strategy] : '单个落地' }}<template v-if="r.targets.length > 1 && r.engine === 'gost'"> · 健康检查{{ r.probe ? '开' : '关' }}</template></dd>
                      <dt>限额</dt><dd>{{ r.limit_gb ? `${r.limit_gb} GB / 月，${r.reset_day ? `每月 ${r.reset_day} 日重置` : '不重置'}` : '不限' }}</dd>
                      <dt>到期</dt><dd>{{ r.expires_at ? localTime(r.expires_at) : '不过期' }}</dd>
                      <dt>最后测量</dt><dd>{{ localTime(r.last_sample_at) }}</dd>
                      <template v-if="r.last_error"><dt>入口错误</dt><dd style="color: var(--err)">{{ r.last_error }}</dd></template>
                      <template v-if="r.exit_error"><dt>出口错误</dt><dd style="color: var(--err)">{{ r.exit_error }}</dd></template>
                    </dl>
                  </div>
                </div>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
      <div v-if="!loaded" class="skeleton-rows"><div v-for="i in 3" :key="i" class="skeleton" style="height: 26px" /></div>
      <div v-else-if="!relays.length" class="empty">
        <div class="big">⇄</div>
        <p>还没有中转。入口服务器监听一个端口，把流量转到落地：可以直接转发，也可以经另一台服务器加密隧道过去。</p>
        <button class="btn primary" @click="dialog = { relay: null, batch: false }"><Icon name="plus" />新建中转</button>
      </div>
      <div v-else-if="!shown.length" class="empty">没有符合条件的中转。</div>
    </div>
  </div>
  <RelayDialog v-if="dialog" :servers="servers" :nodes="nodes" :relay="dialog.relay" :batch="dialog.batch" @close="dialog = null; load()" @created="load" />
  <RelayLink v-if="linkOf" :relay="linkOf" :entry="serverName(linkOf.server_id)" @close="linkOf = null" />
</template>

<style scoped>
.caret { display: inline-block; width: 1.1em; color: var(--faint) }
.rtt.good { color: var(--ok) }
.rtt.meh { color: var(--warn) }
.rtt.bad { color: var(--err) }
.relay-detail > td { background: var(--surface-2); padding: 14px 16px 16px; white-space: normal }
tbody tr.relay-detail:hover > td { background: var(--surface-2) }
.detail-grid { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); gap: 20px }
@media (max-width: 1000px) { .detail-grid { grid-template-columns: minmax(0, 1fr) } }
/* where the list scrolls sideways (a narrow screen), an open row's charts and
   settings stay in view, as wide as the part of the list that shows */
.detail-grid { position: sticky; left: 16px; max-width: calc(min(100vw - var(--sidebar), 1480px) - 98px) }
@media (max-width: 900px) { .detail-grid { max-width: calc(100vw - 62px) } }
.chart-head { display: flex; align-items: center; gap: 6px; margin-bottom: 8px }
.chart-head .grow { flex: 1 }
.chart-stats { display: flex; flex-wrap: wrap; gap: 16px; margin-bottom: 10px; font-size: 12.5px }
.chart-stats b { font-variant-numeric: tabular-nums }
table.mini { margin-top: 6px; border: 1px solid var(--border); border-radius: 8px; border-collapse: separate; overflow: hidden }
table.mini td { padding: 6px 10px; background: var(--surface) }
</style>
