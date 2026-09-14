<script setup lang="ts">
// "新建节点", laid out like Xboard's: the protocol menu top right, then the
// node's name, traffic limit, labels, address and ports, then the protocol's
// own settings. Offers only what PSM supports; Snell and SS2022 default to the
// standalone install, everything else picks one of the cores that runs it.
import { computed, reactive, ref, watch } from 'vue'
import { PROTOCOLS, ENGINE_LABELS, activeFields, validateNode, type Engine } from '@shared/protocols'
import { api, ApiError, type Server } from '../api'
import InstallCommand from './InstallCommand.vue'

const props = defineProps<{ servers: Server[] }>()
const emit = defineEmits<{ close: []; created: [] }>()

const menuOpen = ref(false)
const protocolId = ref('')
const variantId = ref('')
const engine = ref<Engine>('xray')
const form = reactive({
  server: '' as string | number,       // a server id, or 'new'
  newServer: '',
  name: '',
  address: '',
  publicPort: '' as string | number,
  port: '' as string | number,
  traffic: '' as string | number,
  labels: [] as string[],
  labelDraft: '',
})
const params = reactive<Record<string, unknown>>({})
const errors = ref<string[]>([])
const busy = ref(false)
const result = ref<null | { status: string; joined: boolean; install_command?: string; serverName: string; standalone: boolean }>(null)

const protocol = computed(() => PROTOCOLS.find((p) => p.id === protocolId.value))
const variant = computed(() => protocol.value?.variants.find((v) => v.id === variantId.value))
const fields = computed(() => (variant.value ? activeFields(variant.value, engine.value, params) : []))

function pickProtocol(id: string) {
  protocolId.value = id
  menuOpen.value = false
  const v = PROTOCOLS.find((p) => p.id === id)!.variants[0]
  variantId.value = v.id
}
watch(variantId, () => {
  if (!variant.value) return
  engine.value = variant.value.defaultEngine
  for (const k of Object.keys(params)) delete params[k]
  for (const f of variant.value.fields) if (f.default !== undefined) params[f.key] = f.default
})
if (props.servers.length) form.server = props.servers[0].id
else form.server = 'new'

function addLabel() {
  const l = form.labelDraft.trim()
  if (l && !form.labels.includes(l) && form.labels.length < 10) form.labels.push(l)
  form.labelDraft = ''
}

const num = (v: string | number) => (v === '' ? undefined : Number(v))

async function submit() {
  errors.value = []
  if (!variant.value) return (errors.value = ['请选择协议类型'])
  const port = num(form.port)
  const input = {
    protocol: protocolId.value, variant: variantId.value, engine: engine.value,
    name: form.name.trim(), address: form.address.trim(),
    port: port as number, public_port: num(form.publicPort) ?? port,
    traffic_limit_gb: num(form.traffic) ?? 0, labels: form.labels, params: { ...params },
  }
  const v = validateNode(input)
  if (!v.ok) return (errors.value = v.errors)
  busy.value = true
  try {
    let serverId = form.server
    let serverName = props.servers.find((s) => s.id === serverId)?.name ?? ''
    if (serverId === 'new') {
      const s = await api<{ id: number }>('/api/servers', { method: 'POST', body: JSON.stringify({ name: form.newServer.trim() }) })
      serverId = s.id
      serverName = form.newServer.trim().toLowerCase()
    }
    const r = await api<{ status: string; joined: boolean; install_command?: string }>('/api/nodes', {
      method: 'POST', body: JSON.stringify({ ...input, server_id: serverId }),
    })
    result.value = { ...r, serverName, standalone: engine.value === 'standalone' }
    emit('created')
  } catch (e) {
    errors.value = e instanceof ApiError && e.errors.length ? e.errors : [String((e as Error).message)]
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="dialog" role="dialog" aria-label="新建节点" style="position: relative">
      <div class="dialog-head">
        <div>
          <h2>新建节点</h2>
          <p>填写节点信息，提交后生成一键安装命令。</p>
        </div>
        <div v-if="!result" class="proto-select">
          <button type="button" class="proto-button" data-test="protocol" @click="menuOpen = !menuOpen">
            <span v-if="protocol"><span class="dot" :style="{ background: protocol.color }" /> {{ protocol.label }}</span>
            <span v-else>选择协议类型</span>
            <span>⌄</span>
          </button>
          <div v-if="menuOpen" class="proto-menu">
            <button v-for="p in PROTOCOLS" :key="p.id" type="button" :class="{ on: p.id === protocolId }" :data-test="`protocol-${p.id}`" @click="pickProtocol(p.id)">
              <span class="dot" :style="{ background: p.color }" />{{ p.label }}
            </button>
          </div>
        </div>
      </div>

      <!-- after submitting: the result and the install command -->
      <div v-if="result" class="dialog-body" data-test="result">
        <div v-if="result.status === 'queued'" class="notice ok" data-test="result-queued">
          已下发到 {{ result.serverName }}，psm-agent 会在 10 秒内建好节点。
        </div>
        <div v-else-if="result.standalone" class="notice warn">
          节点已保存。独立安装（snell-server / ss-rust）的自动部署会在下一阶段上线，现在可以改选内核运行。
        </div>
        <div v-else class="notice warn" data-test="result-waiting">
          节点已保存。在 {{ result.serverName }} 上以 root 执行下面的命令，安装 PSM、接入面板并建好节点：
        </div>
        <div v-if="result.install_command" class="field">
          <span class="field-label">一键安装命令</span>
          <InstallCommand :command="result.install_command" />
          <div class="help">命令 24 小时内有效，只能用一次；需要时可以在服务器页重新生成。</div>
        </div>
      </div>

      <form v-else class="dialog-body" @submit.prevent="submit">
        <ul v-if="errors.length" class="errors" data-test="errors"><li v-for="e in errors" :key="e">{{ e }}</li></ul>

        <div v-if="protocol && protocol.variants.length > 1" class="field">
          <label>{{ protocol.label }} 类型</label>
          <select v-model="variantId" class="select" data-test="variant">
            <option v-for="v in protocol.variants" :key="v.id" :value="v.id">{{ v.label }}</option>
          </select>
        </div>

        <div v-if="variant" class="row2">
          <div class="field">
            <label>运行方式</label>
            <select v-model="engine" class="select" data-test="engine">
              <option v-for="e in variant.engines" :key="e" :value="e">{{ ENGINE_LABELS[e] }}{{ e === variant.defaultEngine ? '（推荐）' : '' }}</option>
            </select>
          </div>
          <div class="field">
            <label>所在服务器</label>
            <select v-model="form.server" class="select" data-test="server">
              <option v-for="s in servers" :key="s.id" :value="s.id">{{ s.name }}{{ s.status === 'online' ? '' : '（未接入）' }}</option>
              <option value="new">＋ 新服务器</option>
            </select>
          </div>
        </div>
        <div v-if="variant && form.server === 'new'" class="field">
          <label>新服务器名称</label>
          <input v-model="form.newServer" class="input" placeholder="例如 hk1（用作 psmapi-hk1 这个地址）" data-test="new-server">
        </div>

        <div class="field">
          <label>节点名称</label>
          <input v-model="form.name" class="input" placeholder="请输入节点名称" data-test="name">
        </div>

        <div class="field">
          <label>流量限制（GB）</label>
          <input v-model="form.traffic" class="input" type="number" min="0" placeholder="0 表示不限制" data-test="traffic">
        </div>

        <div class="field">
          <label>节点标签</label>
          <div class="chips">
            <span v-for="l in form.labels" :key="l" class="chip">{{ l }}<button type="button" @click="form.labels = form.labels.filter((x) => x !== l)">×</button></span>
            <input v-model="form.labelDraft" placeholder="输入后回车添加标签" @keydown.enter.prevent="addLabel">
          </div>
        </div>

        <div class="field">
          <label>节点地址</label>
          <input v-model="form.address" class="input" placeholder="请输入节点域名或者 IP" data-test="address">
        </div>

        <div class="ports field">
          <div>
            <span class="field-label" title="客户端连接的端口">连接端口 ⓘ</span>
            <input v-model="form.publicPort" class="input" type="number" min="1" max="65535" placeholder="用户连接端口" data-test="public-port">
          </div>
          <span class="arrow">⇄</span>
          <div>
            <span class="field-label" title="节点在服务器上监听的端口">服务端口 ⓘ</span>
            <input v-model="form.port" class="input" type="number" min="1" max="65535" placeholder="请输入服务端口" data-test="port">
          </div>
        </div>

        <template v-if="variant && fields.length">
          <div class="section-title">{{ variant.label }} 设置</div>
          <div v-for="f in fields" :key="f.key" class="field">
            <label v-if="f.type !== 'bool'">{{ f.label }}<span v-if="f.required"> *</span></label>
            <select v-if="f.type === 'select'" v-model="params[f.key]" class="select" :data-test="`param-${f.key}`">
              <option v-for="o in f.options" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
            <label v-else-if="f.type === 'bool'" class="check"><input v-model="params[f.key]" type="checkbox" :data-test="`param-${f.key}`"> {{ f.label }}</label>
            <input v-else v-model="params[f.key]" class="input" :type="f.type === 'number' ? 'number' : f.type === 'password' ? 'password' : 'text'"
              :placeholder="f.placeholder" :data-test="`param-${f.key}`">
            <div v-if="f.help" class="help">{{ f.help }}</div>
          </div>
        </template>
        <button type="submit" hidden />
      </form>

      <div class="dialog-foot">
        <template v-if="result">
          <button class="btn primary" type="button" data-test="done" @click="emit('close')">完成</button>
        </template>
        <template v-else>
          <button class="btn ghost" type="button" @click="emit('close')">取消</button>
          <button class="btn primary" type="button" :disabled="busy" data-test="submit" @click="submit">{{ busy ? '提交中…' : '提交' }}</button>
        </template>
      </div>
    </div>
  </div>
</template>
