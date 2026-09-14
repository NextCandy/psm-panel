<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api, ApiError, type Server } from '../api'
import InstallCommand from '../components/InstallCommand.vue'

const servers = ref<Server[]>([])
const name = ref('')
const error = ref('')
const command = ref<{ server: string; text: string } | null>(null)

async function load() {
  servers.value = await api<Server[]>('/api/servers')
}
onMounted(load)

async function add() {
  error.value = ''
  try {
    const r = await api<{ id: number; install_command: string }>('/api/servers', { method: 'POST', body: JSON.stringify({ name: name.value.trim() }) })
    command.value = { server: name.value.trim().toLowerCase(), text: r.install_command }
    name.value = ''
    await load()
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : String(e)
  }
}
async function newCommand(s: Server) {
  const r = await api<{ install_command: string }>(`/api/servers/${s.id}/install-command`, { method: 'POST' })
  command.value = { server: s.name, text: r.install_command }
}
async function remove(s: Server) {
  if (!confirm(`从面板移除服务器 ${s.name}？它的节点记录也会移除（服务器上的节点不受影响）。`)) return
  await api(`/api/servers/${s.id}`, { method: 'DELETE' })
  await load()
}
const statusText = { online: '在线', pending: '待接入', offline: '离线' } as const
</script>

<template>
  <div class="page-head">
    <div><h1>服务器</h1><p>接入面板的 VPS。在 VPS 上执行一键安装命令后，psm-agent 会主动连接面板，不开放任何端口。</p></div>
    <form class="cmd" style="min-width: 360px" @submit.prevent="add">
      <input v-model="name" class="input" placeholder="新服务器名称，例如 hk1" data-test="server-name">
      <button class="btn primary" type="submit" data-test="add-server">添加服务器</button>
    </form>
  </div>
  <div v-if="error" class="notice err">{{ error }}</div>
  <div v-if="command" class="card" style="padding: 16px; margin-bottom: 16px" data-test="server-command">
    <div class="field-label">在 {{ command.server }} 上以 root 执行：</div>
    <InstallCommand :command="command.text" />
    <div class="help" style="color: var(--muted); margin-top: 6px">24 小时内有效，只能用一次。</div>
  </div>
  <div class="card table-wrap">
    <table>
      <thead><tr><th>ID</th><th>名称</th><th>状态</th><th>主机名</th><th>Agent</th><th>最近同步</th><th>节点数</th><th>操作</th></tr></thead>
      <tbody>
        <tr v-for="s in servers" :key="s.id" :data-test="`server-${s.name}`" :data-status="s.status">
          <td>{{ s.id }}</td>
          <td>{{ s.name }}</td>
          <td><span class="status" :class="s.status"><span class="dot" />{{ statusText[s.status] }}</span></td>
          <td>{{ s.hostname ?? '—' }}</td>
          <td>{{ s.agent_version ?? '—' }}</td>
          <td>{{ s.last_seen ?? '—' }}</td>
          <td>{{ s.node_count }}</td>
          <td>
            <button class="btn small ghost" @click="newCommand(s)">安装命令</button>
            <button class="btn small ghost danger" @click="remove(s)">移除</button>
          </td>
        </tr>
      </tbody>
    </table>
    <div v-if="!servers.length" class="empty">还没有服务器。</div>
  </div>
</template>
