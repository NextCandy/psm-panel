<script setup lang="ts">
// 新建中转 / 编辑中转 / 批量添加. A relay listens on a port of its entry server
// and carries clients to the landing side: a forward does it itself (realm,
// or gost for failover and rate limits), a tunnel carries them to an exit
// server over gost's relay protocol in TLS or WebSocket, and the exit
// forwards to the landing side. The name, the servers and the mode stay once
// made (psm keys a rule by its name). What is typed is checked as the Worker
// will check it (shared/relays.ts).
// The landing side may be a node of the panel (its parent): the relay then
// forwards to the node's address and port, and the node can be published
// through the relay — in the subscriptions, with the entry's address.
import { computed, reactive, ref, watch } from 'vue'
import {
  bareHost, goodHost, parseHostPort, RELAY_MAX_TARGETS, RELAY_PORTS, RELAY_STRATEGY_LABELS, RELAY_TRANSPORT_LABELS,
  REALM_STRATEGIES, relayProblems, type RelayEngine, type RelayFields, type RelayMode,
} from '@shared/relays'
import { PROTOCOLS } from '@shared/protocols'
import { api, errorText, type PanelNode, type Relay, type Server } from '../api'
import { toast } from '../ui'
import InstallCommand from './InstallCommand.vue'
import Modal from './Modal.vue'
import Icon from './Icon.vue'

const props = defineProps<{ servers: Server[]; nodes?: PanelNode[]; relay?: Relay | null; batch?: boolean
  /** a new relay landing on this node (节点 → 经中转发布) */
  node?: PanelNode | null }>()
const emit = defineEmits<{ close: []; created: [] }>()
const editing = computed(() => !!props.relay)
const r = props.relay

/** an ISO time → what <input type="datetime-local"> shows (local time) */
function toLocalInput(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}
type TargetRow = { host: string; port: string | number; server_id: number | '' }
const joinable = props.servers.filter((s) => s.status !== 'leaving')
// a node's relay starts from another server: a forward cannot land where it listens
const firstEntry = props.node ? (joinable.find((s) => s.id !== props.node!.server_id) ?? joinable[0]) : joinable[0]
const form = reactive({
  server: (r?.server_id ?? firstEntry?.id ?? '') as number | '',
  name: r?.name ?? '',
  mode: (r?.mode ?? 'forward') as RelayMode,
  engine: (r?.engine ?? 'realm') as RelayEngine,
  listenPort: (r && !r.auto_port ? r.listen_port : '') as string | number,
  targets: (r?.targets.map((t) => ({ host: t.host, port: t.port, server_id: t.server_id ?? '' })) ?? [{ host: '', port: '', server_id: '' }]) as TargetRow[],
  strategy: r?.strategy ?? '',
  probe: r?.probe ?? true,
  udp: r?.udp ?? true,
  tls: r?.tls ?? false,
  tlsSni: r?.tls_sni ?? '',
  tlsInsecure: r?.tls_insecure ?? false,
  exitServer: (r?.exit_server_id ?? '') as number | '',
  exitHost: r?.exit_host ?? '',
  exitPort: (r && !r.exit_auto_port ? r.exit_port ?? '' : '') as string | number,
  transport: r?.transport || 'tls',
  wsHost: r?.ws_host ?? '',
  wsPath: r?.ws_path ?? '',
  speed: (r?.speed_mbps || '') as string | number,
  limit: (r?.limit_gb || '') as string | number,
  resetDay: (r?.reset_day ?? 1) as string | number,
  expires: toLocalInput(r?.expires_at ?? null),
  lines: '',
  landing: (r ? (r.node_id ? 'node' : 'address') : props.node ? 'node' : 'address') as 'node' | 'address',
  nodeId: (r?.node_id ?? props.node?.id ?? '') as number | '',
  entryHost: r?.entry_host ?? '',
  inSub: r?.in_sub ?? true,
})
const serverOf = (id: number | '') => props.servers.find((s) => s.id === id)
const entry = computed(() => serverOf(form.server))

// a tunnel is gost's; a forward's engine follows what it is asked to do
watch(() => form.mode, (m) => { if (m === 'tunnel') form.engine = 'gost' })
const needsGost = computed(() => form.mode === 'forward' &&
  (!REALM_STRATEGIES.includes(form.strategy) || Number(form.speed) > 0))
// (psm moves a rule between engines on its own port, so this holds for an edit too)
watch(needsGost, (v) => { if (v) form.engine = 'gost' })

// a panel server picked as the landing side or the exit: its address filled in
function pickTargetServer(t: TargetRow) {
  const s = serverOf(t.server_id)
  if (s?.last_ip && !t.host) t.host = s.last_ip
}
watch(() => form.exitServer, (id) => {
  const s = serverOf(id)
  if (s?.last_ip && (!form.exitHost || props.servers.some((x) => x.last_ip === form.exitHost))) form.exitHost = s.last_ip
})
const exitChoices = computed(() => props.servers.filter((s) => s.id !== form.server && s.status !== 'leaving'))

// ── a node of the panel as the landing side ──────────────────────────────────
const byNode = computed(() => form.landing === 'node' && !props.batch)
const landingNode = computed(() => (byNode.value ? props.nodes?.find((n) => n.id === form.nodeId) : undefined))
const nodeGroups = computed(() => props.servers
  .map((s) => ({ server: s.name, nodes: (props.nodes ?? []).filter((n) => n.server_id === s.id) }))
  .filter((g) => g.nodes.length))
const protoLabel = (n: PanelNode) => PROTOCOLS.find((p) => p.id === n.protocol)?.label ?? n.protocol
// QUIC and WireGuard nodes speak UDP alone (the Worker also knows Xray's mKCP)
const nodeUdp = computed(() => !!landingNode.value && ['hysteria2', 'tuic', 'wireguard'].includes(landingNode.value.protocol))
watch(nodeUdp, (v) => { if (v) form.udp = true }, { immediate: true })
// named after the node (as the subscription will show it: entry-name), until a name is typed
const autoName = (n?: PanelNode) => (n ? `${serverOf(n.server_id)?.name ?? 'node'}-${n.name}` : '')
  .replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 48)
let lastAuto = ''
watch(landingNode, (n) => {
  if (editing.value || (form.name && form.name !== lastAuto)) return
  form.name = lastAuto = autoName(n)
}, { immediate: true })
// what clients may reach the entry at: where its agent syncs from, its nodes' addresses
const entryHosts = computed(() => [...new Set([entry.value?.last_ip ?? '',
  ...(props.nodes ?? []).filter((n) => n.server_id === form.server).map((n) => n.address)].filter(Boolean))])
function addTarget() {
  if (form.targets.length < RELAY_MAX_TARGETS) form.targets.push({ host: '', port: form.targets[0]?.port ?? '', server_id: '' })
}
/** many "host:port" pasted into one host box become rows */
function pasteTargets(e: ClipboardEvent, i: number) {
  const text = e.clipboardData?.getData('text') ?? ''
  const parts = text.split(/[\s,]+/).map(parseHostPort).filter((x): x is { host: string; port: number } => !!x)
  if (parts.length < 2 && !(parts.length === 1 && text.includes(':'))) return
  e.preventDefault()
  form.targets.splice(i, 1, ...parts.slice(0, RELAY_MAX_TARGETS).map((p) => ({ ...p, server_id: '' as const })))
}

const num = (v: string | number) => (v === '' || v === null ? null : Number(v))
const fields = computed<RelayFields>(() => ({
  name: props.batch ? 'batch' : form.name.trim(), mode: form.mode, engine: form.engine,
  listen_port: props.batch ? null : num(form.listenPort),
  targets: props.batch ? [{ host: 'example.com', port: 1 }]
    : byNode.value ? (landingNode.value ? [{ host: landingNode.value.address, port: landingNode.value.public_port ?? landingNode.value.port }] : [{ host: 'example.com', port: 1 }])
    : form.targets.map((t) => ({ host: t.host.trim().replace(/^\[(.*)\]$/, '$1'), port: Number(t.port) })),
  strategy: byNode.value ? '' : form.strategy,
  tls: form.mode === 'forward' && form.engine === 'realm' && form.tls && !byNode.value,
  tls_sni: form.tlsSni.trim(),
  exit_host: form.exitHost.trim().replace(/^\[(.*)\]$/, '$1'), exit_port: num(form.exitPort),
  transport: form.transport, ws_host: form.wsHost.trim(), ws_path: form.wsPath.trim(),
  speed_mbps: Number(form.speed || 0), limit_gb: Number(form.limit || 0), reset_day: Number(form.resetDay || 0),
  expires_at: form.expires ? new Date(form.expires).toISOString() : null,
}))
const tried = ref(false)
const problems = computed(() => {
  const p = relayProblems(fields.value)
  if (!form.server) p.unshift('选择入口服务器')
  if (form.mode === 'tunnel' && !form.exitServer) p.push('选择出口服务器')
  if (props.batch && !form.lines.trim()) p.push('每行一条：名称 端口(或 auto) 落地地址:端口[,落地地址:端口…]')
  if (byNode.value) {
    if (!landingNode.value) p.push('选择落地节点')
    else if (form.mode === 'forward' && landingNode.value.server_id === form.server) p.push('入口和落地不能是同一台服务器')
    const h = bareHost(form.entryHost)
    if (h && !goodHost(h)) p.push('入口地址：客户端连入口服务器用的域名或 IP')
  }
  return p
})
const serverErrors = ref<string[]>([])
const shownErrors = computed(() => (serverErrors.value.length ? serverErrors.value : tried.value ? problems.value : []))
watch(() => JSON.stringify(form), () => { serverErrors.value = [] })

const multi = computed(() => props.batch || (!byNode.value && form.targets.length > 1))
const range = computed(() => entry.value?.relay_port_min
  ? `${entry.value.relay_port_min}-${entry.value.relay_port_max}` : `${RELAY_PORTS[0]}-${RELAY_PORTS[1]}`)
const batchRows = computed(() => form.lines.split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean).length)

function body() {
  const f = fields.value
  const common = {
    mode: form.mode, engine: form.engine, strategy: form.strategy, probe: form.probe, udp: form.udp,
    tls: f.tls, tls_sni: f.tls_sni, tls_insecure: f.tls && form.tlsInsecure,
    speed_mbps: f.speed_mbps, limit_gb: f.limit_gb, reset_day: f.reset_day, expires_at: f.expires_at,
    ...(form.mode === 'tunnel' ? {
      exit_server_id: form.exitServer, exit_host: f.exit_host, transport: form.transport,
      ws_host: form.transport.includes('ws') ? f.ws_host : '', ws_path: form.transport.includes('ws') ? f.ws_path : '',
    } : {}),
  }
  if (props.batch) return { ...common, server_id: form.server, lines: form.lines }
  return {
    ...common, server_id: form.server, name: f.name, listen_port: f.listen_port,
    ...(byNode.value
      ? { node_id: form.nodeId, entry_host: bareHost(form.entryHost), in_sub: form.inSub }
      : { node_id: null, targets: form.targets.map((t, i) => ({ host: f.targets[i].host, port: f.targets[i].port, server_id: t.server_id === '' ? null : t.server_id })) }),
    ...(form.mode === 'tunnel' ? { exit_port: f.exit_port } : {}),
  }
}

const busy = ref(false)
type Created = { status: string; install: { server: string; command: string }[]; created?: number; errors?: string[] }
const result = ref<Created | null>(null)
async function submit() {
  tried.value = true
  serverErrors.value = []
  if (problems.value.length) return
  busy.value = true
  try {
    if (editing.value) {
      const { mode: _m, exit_server_id: _x, ...change } = body() as Record<string, unknown>
      await api(`/api/relays/${r!.id}`, { method: 'PATCH', body: JSON.stringify(change) })
      toast(`已保存 ${r!.name}，正在下发`)
      emit('close')
      return
    }
    if (props.batch) {
      const b = await api<{ created: number; ids: number[]; errors: string[] }>('/api/relays/batch', { method: 'POST', body: JSON.stringify(body()) })
      result.value = { status: 'batch', install: [], created: b.created, errors: b.errors }
    } else {
      const c = await api<{ status: string; install: { server: string; command: string }[] }>('/api/relays', { method: 'POST', body: JSON.stringify(body()) })
      result.value = { status: c.status, install: c.install ?? [] }
    }
    emit('created')
  } catch (e) {
    serverErrors.value = [errorText(e)].flatMap((m) => m.split('；'))
  } finally {
    busy.value = false
  }
}

const title = computed(() => result.value ? (props.batch ? '批量添加完成' : '中转已保存')
  : editing.value ? `编辑中转 ${r!.name}` : props.batch ? '批量添加中转' : '新建中转')
const subtitle = computed(() => result.value ? '' : editing.value
  ? '修改由 psm-agent 在服务器上生效；名称、服务器和转发方式不能改。'
  : props.batch ? '同样的设置，每行一条中转；全部检查通过才会创建。'
  : props.node ? `节点 ${props.node.name} 经另一台服务器转发：设置不变，客户端改连入口。` : '入口服务器监听一个端口，把客户端送到落地。')
</script>

<template>
  <Modal :title="title" :subtitle="subtitle" size="wide" :sticky="!result && !!(form.name || form.lines)" @close="emit('close')">
    <!-- after submitting -->
    <div v-if="result" class="dialog-body" data-test="result">
      <template v-if="result.status === 'batch'">
        <div class="notice ok" data-test="batch-created">已创建 {{ result.created }} 条中转，psm-agent 会在几秒内建好。</div>
        <ul v-if="result.errors?.length" class="errors"><li v-for="e in result.errors" :key="e">{{ e }}</li></ul>
      </template>
      <template v-else>
        <div v-if="result.status === 'queued'" class="notice ok" data-test="result-queued">
          已下发到 {{ entry?.name }}，psm-agent 会在几秒内建好（服务器上没有 {{ form.engine }} 时会先装上）。
        </div>
        <div v-else-if="result.status === 'pending'" class="notice ok" data-test="result-pending">
          隧道先在出口 {{ serverOf(form.exitServer)?.name }} 上建好，拿到它的证书后再在入口 {{ entry?.name }} 上建，入口会钉住这张证书。
        </div>
        <div v-else class="notice warn" data-test="result-waiting">中转已保存，等服务器接入面板后自动生效。</div>
        <p v-if="byNode && form.inSub" class="help" data-test="result-sub">中转运行后，订阅里会多出「{{ entry?.name }}-{{ form.name }}」（跟着节点 {{ landingNode?.name }} 的标签）。</p>
      </template>
      <div v-for="i in result.install" :key="i.server" class="field">
        <span class="field-label">在 {{ i.server }} 上以 root 执行（安装 PSM 并接入面板）：</span>
        <InstallCommand :command="i.command" />
      </div>
      <p v-if="result.install.length" class="help">命令 24 小时内有效，只能用一次；需要时可以在服务器页重新生成。</p>
    </div>

    <form v-else class="dialog-body" @submit.prevent="submit">
      <ul v-if="shownErrors.length" class="errors" data-test="errors"><li v-for="e in shownErrors" :key="e">{{ e }}</li></ul>

      <div class="row2">
        <div class="field">
          <label>入口服务器</label>
          <select v-model="form.server" class="select" data-test="server" :disabled="editing">
            <option v-for="s in servers" :key="s.id" :value="s.id" :disabled="s.status === 'leaving'">{{ s.name }}{{ s.status === 'pending' ? '（未接入）' : s.status === 'offline' ? '（离线）' : '' }}</option>
          </select>
          <div class="help">客户端连的是它。</div>
        </div>
        <div v-if="!batch" class="field">
          <label>名称</label>
          <input v-model="form.name" class="input" placeholder="例如 hk-to-jp" data-test="name" :disabled="editing">
          <div class="help">字母、数字、. _ -；服务器上的规则按它区分。</div>
        </div>
      </div>

      <div class="field">
        <span class="field-label">转发方式</span>
        <div class="choice-cards">
          <button type="button" class="choice-card" :class="{ on: form.mode === 'forward' }" :disabled="editing" data-test="mode-forward" @click="form.mode = 'forward'">
            <strong>直接转发</strong><span>入口 → 落地。入口到落地这一段是原样的流量。</span>
          </button>
          <button type="button" class="choice-card" :class="{ on: form.mode === 'tunnel' }" :disabled="editing" data-test="mode-tunnel" @click="form.mode = 'tunnel'">
            <strong>隧道</strong><span>入口 → 出口 → 落地。入口到出口加密（TLS / WebSocket），出口再转给落地。</span>
          </button>
        </div>
      </div>

      <div v-if="form.mode === 'forward'" class="field">
        <span class="field-label">转发程序</span>
        <div class="segmented" role="radiogroup">
          <button type="button" :class="{ on: form.engine === 'realm' }" :disabled="needsGost" data-test="engine-realm" @click="form.engine = 'realm'">realm</button>
          <button type="button" :class="{ on: form.engine === 'gost' }" data-test="engine-gost" @click="form.engine = 'gost'">gost</button>
        </div>
        <div class="help">
          realm 轻量，适合一对一或轮询；gost 能主备切换（带健康检查）、随机分配和限速。服务器上没有时自动安装。
        </div>
      </div>

      <!-- the tunnel -->
      <template v-if="form.mode === 'tunnel'">
        <div class="section-title">隧道 <span class="muted">入口 → 出口这一段</span></div>
        <div class="row2">
          <div class="field">
            <label>出口服务器</label>
            <select v-model="form.exitServer" class="select" data-test="exit-server" :disabled="editing">
              <option value="" disabled>选择出口</option>
              <option v-for="s in exitChoices" :key="s.id" :value="s.id">{{ s.name }}{{ s.status === 'pending' ? '（未接入）' : '' }}</option>
            </select>
          </div>
          <div class="field">
            <label>出口地址</label>
            <input v-model="form.exitHost" class="input" placeholder="入口连过去的域名或 IP" data-test="exit-host">
            <div class="help">选了出口会填上它最近连面板用的地址；有更合适的（内网、域名）就改掉。</div>
          </div>
        </div>
        <div class="row2">
          <div class="field">
            <label>隧道端口（出口上）</label>
            <input v-model="form.exitPort" class="input" type="number" min="1" max="65535"
                   :placeholder="editing && r?.exit_port ? `自动（当前 ${r.exit_port}）` : '留空自动分配'" data-test="exit-port">
          </div>
          <div class="field">
            <label>传输</label>
            <select v-model="form.transport" class="select" data-test="transport">
              <option v-for="(label, t) in RELAY_TRANSPORT_LABELS" :key="t" :value="t">{{ label }}</option>
            </select>
            <div class="help">多路复用：多条连接共用一条隧道，握手少；WebSocket 可以放在 CDN 后面。</div>
          </div>
        </div>
        <div class="row3">
          <div class="field">
            <label>伪装域名（SNI，可选）</label>
            <input v-model="form.tlsSni" class="input" placeholder="例如 www.microsoft.com" data-test="tls-sni">
          </div>
          <template v-if="form.transport.includes('ws')">
            <div class="field"><label>WebSocket Host（可选）</label><input v-model="form.wsHost" class="input" data-test="ws-host"></div>
            <div class="field"><label>WebSocket 路径（可选）</label><input v-model="form.wsPath" class="input" placeholder="/ws" data-test="ws-path"></div>
          </template>
        </div>
        <p class="help" style="margin-top: -6px">出口用自签名证书，入口只认这一张（证书指纹钉住），不需要域名，也不怕中间人。</p>
      </template>

      <!-- the landing side -->
      <div class="section-title">落地 <span class="muted">{{ form.mode === 'tunnel' ? '出口' : '入口' }}把流量送到这里</span></div>
      <div v-if="!batch" class="field">
        <div class="segmented" role="radiogroup" aria-label="落地">
          <button type="button" :class="{ on: form.landing === 'node' }" :aria-checked="form.landing === 'node'" role="radio"
                  :disabled="!nodes?.length" data-test="landing-node" @click="form.landing = 'node'">面板节点</button>
          <button type="button" :class="{ on: form.landing === 'address' }" :aria-checked="form.landing === 'address'" role="radio"
                  data-test="landing-address" @click="form.landing = 'address'">其他地址</button>
        </div>
      </div>
      <div v-if="byNode" class="field">
        <select v-model="form.nodeId" class="select" data-test="landing-node-select" aria-label="落地节点">
          <option value="" disabled>选择节点</option>
          <optgroup v-for="g in nodeGroups" :key="g.server" :label="g.server">
            <option v-for="n in g.nodes" :key="n.id" :value="n.id" :disabled="n.status === 'deleting'">
              {{ n.name }} · {{ protoLabel(n) }} · {{ n.address }}:{{ n.public_port ?? n.port }}
            </option>
          </optgroup>
        </select>
        <div class="help">转发到节点的地址和端口，节点改了会跟着改。节点的设置不变，客户端只是改连入口。</div>
      </div>
      <div v-else-if="batch" class="field">
        <label>中转列表</label>
        <textarea v-model="form.lines" class="input mono" rows="7" spellcheck="false" data-test="batch-lines"
          placeholder="# 名称 端口(或 auto) 落地地址:端口[,落地地址:端口…]&#10;hk-jp 20001 203.0.113.9:443&#10;hk-us auto 198.51.100.7:8443,198.51.100.8:8443" />
        <div class="help">每行一条，最多 100 条；# 之后是注释。{{ batchRows ? `现在 ${batchRows} 条。` : '' }}端口写 auto 从 {{ range }} 里自动分配。</div>
      </div>
      <template v-else>
        <div v-for="(t, i) in form.targets" :key="i" class="target-row">
          <input v-model="t.host" class="input" placeholder="落地地址（域名或 IP；可粘贴多个 地址:端口）" :data-test="`target-host-${i}`" @paste="pasteTargets($event, i)">
          <input v-model="t.port" class="input" type="number" min="1" max="65535" placeholder="端口" :data-test="`target-port-${i}`">
          <select v-model="t.server_id" class="select" :title="'落地是面板里的服务器时选上，两端就能对应起来'" :data-test="`target-server-${i}`" @change="pickTargetServer(t)">
            <option value="">不是面板里的服务器</option>
            <option v-for="s in servers" :key="s.id" :value="s.id" :disabled="s.id === form.server && form.mode === 'forward'">{{ s.name }}</option>
          </select>
          <button class="btn icon ghost" type="button" title="移除" :disabled="form.targets.length === 1" @click="form.targets.splice(i, 1)"><Icon name="x" /></button>
        </div>
        <button class="btn small" type="button" :disabled="form.targets.length >= RELAY_MAX_TARGETS" data-test="add-target" @click="addTarget">
          <Icon name="plus" />再加一个落地
        </button>
      </template>
      <div v-if="multi" class="row2" style="margin-top: 14px">
        <div class="field">
          <label>多个落地怎么分</label>
          <select v-model="form.strategy" class="select" data-test="strategy">
            <option v-for="(label, s) in RELAY_STRATEGY_LABELS" :key="s" :value="s">{{ label }}{{ form.mode === 'forward' && !REALM_STRATEGIES.includes(s) ? '（gost）' : '' }}</option>
          </select>
          <div class="help">主备：总是用第一个能连上的；按客户端 IP：同一个客户端总落到同一台。</div>
        </div>
        <div v-if="form.engine === 'gost'" class="field">
          <span class="field-label">健康检查</span>
          <label class="check"><input v-model="form.probe" type="checkbox" data-test="probe"> 每 15 秒检查一次，连不上的落地暂时不用</label>
          <div class="help">落地只开了 UDP 时关掉（检查走 TCP）。</div>
        </div>
      </div>

      <!-- the entry's port and what it carries -->
      <div class="section-title">入口</div>
      <div class="row2">
        <div v-if="!batch" class="field">
          <label>监听端口</label>
          <input v-model="form.listenPort" class="input" type="number" min="1" max="65535" data-test="listen-port"
                 :placeholder="editing && r?.auto_port ? `自动（当前 ${r.listen_port}）` : `留空自动分配（${range}）`">
          <div class="help">防火墙会自动放行；删除中转时只关掉它开的那条。</div>
        </div>
        <div class="field">
          <span class="field-label">协议</span>
          <label class="check"><input v-model="form.udp" type="checkbox" :disabled="nodeUdp" data-test="udp"> 同时转发 UDP</label>
          <div class="help">{{ nodeUdp ? `${protoLabel(landingNode!)} 只走 UDP，必须转发` : 'Hysteria2、TUIC 这类基于 QUIC 的协议必须开' }}{{ form.mode === 'tunnel' ? '；UDP 在隧道里传' : '' }}。</div>
        </div>
      </div>
      <div v-if="byNode" class="row2">
        <div class="field">
          <label>入口地址</label>
          <input v-model="form.entryHost" class="input" list="relay-entry-hosts" data-test="entry-host"
                 :placeholder="entry?.last_ip ? `留空用 ${entry.last_ip}` : '客户端连入口服务器用的域名或 IP'">
          <datalist id="relay-entry-hosts"><option v-for="h in entryHosts" :key="h" :value="h" /></datalist>
          <div class="help">订阅和链接里客户端连的地址；留空用入口服务器最近连面板的地址。</div>
        </div>
        <div class="field">
          <span class="field-label">订阅</span>
          <label class="check"><input v-model="form.inSub" type="checkbox" data-test="in-sub"> 加入订阅</label>
          <div class="help">订阅里多出「{{ entry?.name ?? '入口' }}-{{ form.name || '名称' }}」：节点的设置，入口的地址和端口；跟着节点的标签进订阅。</div>
        </div>
      </div>
      <template v-if="form.mode === 'forward' && form.engine === 'realm' && !byNode">
        <div class="field">
          <label class="check"><input v-model="form.tls" type="checkbox" data-test="tls"> 对入口到落地这一跳加密（realm TLS，只包 TCP）</label>
          <div class="help">落地那台也要有 realm 解开它。要完整加密（含 UDP），用隧道。</div>
        </div>
        <div v-if="form.tls" class="row2">
          <div class="field"><label>TLS 域名</label><input v-model="form.tlsSni" class="input" placeholder="留空则用落地地址" data-test="tls-sni"></div>
          <div class="field">
            <span class="field-label">证书</span>
            <label class="check"><input v-model="form.tlsInsecure" type="checkbox" data-test="tls-insecure"> 接受自签名证书（不验证对端）</label>
          </div>
        </div>
      </template>

      <!-- the limits -->
      <div class="section-title">限制 <span class="muted">都可以不填</span></div>
      <div class="row2">
        <div class="field">
          <label>限速</label>
          <div class="input-group">
            <input v-model="form.speed" class="input" type="number" min="0" step="any" placeholder="不限" data-test="speed">
            <span class="addon">Mbit/s</span>
          </div>
          <div class="help">上下行各自的上限{{ form.mode === 'forward' ? '；要用 gost' : '' }}。</div>
        </div>
        <div class="field">
          <label>流量限额</label>
          <div class="input-group">
            <input v-model="form.limit" class="input" type="number" min="0" step="any" placeholder="不限" data-test="limit">
            <span class="addon">GB / 月</span>
          </div>
          <div class="help">用完后暂停，重置日或提高限额后恢复。</div>
        </div>
      </div>
      <div class="row2">
        <div class="field">
          <label>每月重置日</label>
          <input v-model="form.resetDay" class="input" type="number" min="0" max="28" data-test="reset-day">
          <div class="help">1-28；0 不重置（限额一直累计）。按服务器的时区。</div>
        </div>
        <div class="field">
          <label>到期时间</label>
          <input v-model="form.expires" class="input" type="datetime-local" data-test="expires">
          <div class="help">到期后暂停（本机时间，存为 UTC）；留空不过期。</div>
        </div>
      </div>
      <button type="submit" hidden />
    </form>

    <template #foot>
      <template v-if="result">
        <button class="btn primary" type="button" data-test="done" @click="emit('close')">完成</button>
      </template>
      <template v-else>
        <button class="btn ghost" type="button" @click="emit('close')">取消</button>
        <button class="btn primary" type="button" :disabled="busy" data-test="submit" @click="submit">
          <span v-if="busy" class="spinner" />{{ busy ? '提交中…' : editing ? '保存' : batch ? `创建 ${batchRows} 条` : '创建' }}
        </button>
      </template>
    </template>
  </Modal>
</template>

<style scoped>
.target-row { display: grid; grid-template-columns: minmax(0, 1fr) 110px 190px auto; gap: 8px; margin-bottom: 8px }
@media (max-width: 640px) { .target-row { grid-template-columns: minmax(0, 1fr) 90px auto } .target-row select { display: none } }
</style>
