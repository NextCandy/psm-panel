<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { PROTOCOLS, ENGINE_LABELS, findVariant, type Engine } from '@shared/protocols'
import { api, formatBytes, type PanelNode, type Server } from '../api'
import NodeDialog from '../components/NodeDialog.vue'

const nodes = ref<PanelNode[]>([])
const servers = ref<Server[]>([])
const dialog = ref(false)
const editing = ref<PanelNode | null>(null)
const message = ref('')

async function load() {
  ;[nodes.value, servers.value] = await Promise.all([api<PanelNode[]>('/api/nodes'), api<Server[]>('/api/servers')])
}
// While a change is on its way to a server, look again every few seconds.
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  load()
  timer = setInterval(() => {
    if (nodes.value.some((n) => n.status === 'queued' || n.status === 'deleting')) load()
  }, 3000)
})
onUnmounted(() => clearInterval(timer))

const proto = (id: string) => PROTOCOLS.find((p) => p.id === id)
const serverName = (id: number) => servers.value.find((s) => s.id === id)?.name ?? '?'
const statusText: Record<string, string> = { waiting: '待安装', queued: '下发中', applied: '运行中', failed: '失败', deleting: '删除中' }

async function showLink(n: PanelNode) {
  try {
    const r = await api<{ content: string }>(`/api/nodes/${n.id}/link`)
    await navigator.clipboard.writeText(r.content).catch(() => {})
    message.value = `已复制 ${n.name} 的链接：${r.content}`
  } catch (e) {
    message.value = (e as Error).message
  }
}
async function remove(n: PanelNode) {
  // A node whose server never answers again stays in 删除中 for ever, so that
  // state must still offer a way out: forget it here, as a server can be.
  const stuck = n.status === 'deleting'
  const msg = stuck
    ? `${n.name} 一直停在删除中，服务器没有回应。只从面板移除吗？\n\n服务器上的节点不会被删掉；那台机器如果还在，请在它上面执行 psm node delete 清理。`
    : `删除节点 ${n.name}？服务器上的节点也会一起删除。`
  if (!confirm(msg)) return
  try {
    await api(`/api/nodes/${n.id}${stuck ? '?force=1' : ''}`, { method: 'DELETE' })
    await load()
  } catch (e) {
    message.value = (e as Error).message
  }
}
function openNew() {
  editing.value = null
  dialog.value = true
}
function openEdit(n: PanelNode) {
  editing.value = n
  dialog.value = true
}
</script>

<template>
  <div class="page-head">
    <div><h1>节点管理</h1></div>
    <button class="btn primary" data-test="new-node" @click="openNew">＋ 新建节点</button>
  </div>
  <div v-if="message" class="notice warn" data-test="message">{{ message }}</div>
  <div class="card table-wrap">
    <table>
      <thead>
        <tr><th>ID</th><th>状态</th><th>节点名称</th><th>协议</th><th>运行方式</th><th>服务器</th><th>地址</th><th>本月流量</th><th>标签</th><th>操作</th></tr>
      </thead>
      <tbody>
        <tr v-for="n in nodes" :key="n.id" :data-test="`node-${n.name}`" :data-status="n.status">
          <td>{{ n.id }}</td>
          <td>
            <span class="status" :class="n.status" :title="n.last_error ?? ''"><span class="dot" />{{ statusText[n.status] }}</span>
            <span v-if="n.traffic_paused" class="badge warn" title="超出流量上限，已暂停">超额暂停</span>
            <span v-if="n.last_error && n.status === 'applied'" class="badge err" :title="n.last_error">!</span>
          </td>
          <td>{{ n.name }}</td>
          <td>
            <span class="proto-tag"><span class="dot" :style="{ background: proto(n.protocol)?.color }" />
              {{ proto(n.protocol)?.label }}<template v-if="(proto(n.protocol)?.variants.length ?? 0) > 1"> · {{ findVariant(n.protocol, n.variant)?.label }}</template>
            </span>
          </td>
          <td>{{ ENGINE_LABELS[n.engine as Engine] ?? n.engine }}</td>
          <td>{{ serverName(n.server_id) }}</td>
          <td>{{ n.address }}:{{ n.public_port ?? n.port }}</td>
          <td>{{ formatBytes(n.traffic_used) }} / {{ n.traffic_limit_gb ? `${n.traffic_limit_gb} GB` : '不限' }}</td>
          <td><span v-for="l in n.labels" :key="l" class="label-chip">{{ l }}</span></td>
          <td>
            <button class="btn small ghost" :disabled="!n.has_link" @click="showLink(n)">链接</button>
            <button class="btn small ghost" :disabled="n.status === 'queued' || n.status === 'deleting'" :data-test="`edit-${n.name}`" @click="openEdit(n)">编辑</button>
            <button class="btn small ghost danger" @click="remove(n)">{{ n.status === 'deleting' ? '强制移除' : '删除' }}</button>
          </td>
        </tr>
      </tbody>
    </table>
    <div v-if="!nodes.length" class="empty">还没有节点，点右上角"新建节点"。</div>
  </div>
  <NodeDialog v-if="dialog" :servers="servers" :node="editing" @close="dialog = false; load()" @created="load" />
</template>
