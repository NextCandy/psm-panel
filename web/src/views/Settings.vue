<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api, ApiError, localTime } from '../api'

type Settings = { version: string; panel_url: string; effective_panel_url: string; sync_interval: number; token_key: 'panel' | 'secret' }
type Entry = { id: number; at: string; actor: string; action: string; target: string; detail: string }

const settings = ref<Settings | null>(null)
const panelUrl = ref('')
const message = ref('')
const error = ref('')
const log = ref<Entry[]>([])

const actions: Record<string, string> = {
  login: '登录', 'login.failed': '登录失败', 'server.add': '添加服务器', 'server.delete': '移除服务器', 'server.join': '服务器接入',
  'server.diagnose': '诊断服务器', 'node.add': '新建节点', 'node.update': '修改节点', 'node.delete': '删除节点', 'traffic.reset': '重置流量',
  'subscription.add': '新建订阅', 'subscription.update': '修改订阅', 'subscription.reset': '重置订阅地址', 'subscription.delete': '删除订阅',
  'settings.update': '修改设置',
}

async function load() {
  settings.value = await api<Settings>('/api/settings')
  panelUrl.value = settings.value.panel_url
  log.value = await api<Entry[]>('/api/audit?limit=100')
}
onMounted(load)

async function save() {
  message.value = ''
  error.value = ''
  try {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify({ panel_url: panelUrl.value }) })
    message.value = '已保存。之后生成的安装命令和订阅地址都用这个地址。'
    await load()
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : String(e)
  }
}
</script>

<template>
  <div class="page-head">
    <div><h1>系统设置</h1><p>面板地址、运行信息和操作记录。</p></div>
  </div>
  <div v-if="settings" class="card" style="padding: 18px; margin-bottom: 16px">
    <form class="field" @submit.prevent="save">
      <label>面板地址</label>
      <div class="cmd">
        <input v-model="panelUrl" class="input" :placeholder="settings.effective_panel_url" data-test="panel-url">
        <button class="btn primary" type="submit" data-test="save-settings">保存</button>
      </div>
      <div class="help">服务器安装命令和订阅地址里的面板地址。绑定了自己的域名后填在这里；留空则用当前访问的地址（{{ settings.effective_panel_url }}）。</div>
    </form>
    <div v-if="message" class="notice ok">{{ message }}</div>
    <div v-if="error" class="notice err">{{ error }}</div>
    <dl class="facts">
      <dt>面板版本</dt><dd data-test="panel-version">{{ settings.version }}</dd>
      <dt>服务器同步间隔</dt><dd>空闲时 {{ settings.sync_interval }} 秒，有任务时 3 秒（Worker 变量 SYNC_INTERVAL）</dd>
      <dt>数据加密密钥</dt><dd>{{ settings.token_key === 'secret' ? 'Worker 机密 TOKEN_KEY' : '面板自动生成（存于 D1）' }}</dd>
      <dt>管理员密码</dt><dd>在 Cloudflare 控制台打开这个 Worker 的“设置 → 变量和机密”，修改机密 ADMIN_PASSWORD；改后所有已登录的会话失效。</dd>
    </dl>
  </div>
  <div class="card table-wrap">
    <div class="card-title">操作记录</div>
    <table>
      <thead><tr><th>时间</th><th>操作者</th><th>操作</th><th>对象</th><th>详情</th></tr></thead>
      <tbody>
        <tr v-for="e in log" :key="e.id" :data-test="`audit-${e.action}`">
          <td>{{ localTime(e.at) }}</td>
          <td>{{ e.actor === 'admin' ? '管理员' : e.actor === 'agent' ? '服务器' : e.actor }}</td>
          <td>{{ actions[e.action] ?? e.action }}</td>
          <td>{{ e.target }}</td>
          <td class="muted">{{ e.detail }}</td>
        </tr>
      </tbody>
    </table>
    <div v-if="!log.length" class="empty">暂无记录。</div>
  </div>
</template>
