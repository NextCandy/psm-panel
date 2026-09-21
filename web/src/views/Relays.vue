<script setup lang="ts">
// 中转: one realm rule per row, each forwarding a port of the entry server to
// somewhere else. The landing side is either another server in the panel or an
// address typed in, and the hop can be encrypted.
import { onMounted, onUnmounted, ref } from 'vue'
import { api, type Relay, type Server } from '../api'
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
    <div><h1>中转</h1><p>把入口服务器的一个端口转发到落地服务器或任意地址，可选对这一跳加密。</p></div>
    <button class="btn primary" data-test="new-relay" @click="openNew">＋ 新建中转</button>
  </div>
  <div v-if="message" class="notice warn" data-test="message">{{ message }}</div>
  <div class="card table-wrap">
    <table>
      <thead>
        <tr><th>ID</th><th>状态</th><th>名称</th><th>入口服务器</th><th>监听端口</th><th>落地</th><th>协议</th><th>加密</th><th>操作</th></tr>
      </thead>
      <tbody>
        <tr v-for="r in relays" :key="r.id" :data-test="`relay-${r.name}`" :data-status="r.status">
          <td>{{ r.id }}</td>
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
          <td>
            <button class="btn small ghost" :disabled="r.status === 'queued' || r.status === 'deleting'" :data-test="`edit-${r.name}`" @click="openEdit(r)">编辑</button>
            <button class="btn small ghost danger" :disabled="r.status === 'deleting'" @click="remove(r)">删除</button>
          </td>
        </tr>
      </tbody>
    </table>
    <div v-if="!relays.length" class="empty">还没有中转，点右上角“新建中转”。</div>
  </div>
  <RelayDialog v-if="dialog" :servers="servers" :relay="editing" @close="dialog = false; load()" @created="load" />
</template>
