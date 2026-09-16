<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api, ApiError, localTime } from '../api'

type Settings = {
  version: string; panel_url: string; effective_panel_url: string; sync_interval: number; token_key: 'panel' | 'secret'
  sni_engine: string; sni_key_set: boolean
}
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
  'settings.update': '修改设置', 'template.add': '新建订阅模板', 'template.update': '修改订阅模板', 'template.delete': '删除订阅模板',
}

const sniEngine = ref('netlas')
const sniKey = ref('')
const sniMessage = ref('')

async function load() {
  settings.value = await api<Settings>('/api/settings')
  panelUrl.value = settings.value.panel_url
  sniEngine.value = settings.value.sni_engine || 'netlas'
  log.value = await api<Entry[]>('/api/audit?limit=100')
}

async function saveSni() {
  sniMessage.value = ''
  error.value = ''
  try {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify({ sni_engine: sniEngine.value, ...(sniKey.value ? { sni_key: sniKey.value } : {}) }) })
    sniKey.value = ''
    sniMessage.value = '已保存。新建 REALITY 节点时可以用“自动选择伪装目标”。'
    await load()
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : String(e)
  }
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
  <div v-if="settings" class="card" style="padding: 18px; margin-bottom: 16px">
    <form class="field" @submit.prevent="saveSni">
      <label>网络测绘引擎（REALITY 自动选择伪装目标）</label>
      <div class="cmd">
        <select v-model="sniEngine" class="select" style="max-width: 160px" data-test="sni-engine">
          <option value="netlas">Netlas</option><option value="quake">Quake（360）</option>
          <option value="zoomeye">ZoomEye</option><option value="fofa">FOFA</option>
        </select>
        <input v-model="sniKey" class="input" type="password" autocomplete="off" data-test="sni-key"
          :placeholder="settings.sni_key_set ? '已保存 API Key（留空不修改）' : 'API Key'">
        <button class="btn primary" type="submit" data-test="save-sni">保存</button>
      </div>
      <div class="help">新建 REALITY 节点时，面板让那台服务器用这个引擎查同一个 ASN 里有证书的网站，逐个做 TLS 握手检查，列出可用的伪装域名和目标，点一下填入。API Key 加密存放，只在查询时发给那台服务器。Netlas 有免费额度：在 app.netlas.io 注册后，从个人资料页复制 API Key。</div>
    </form>
    <div v-if="sniMessage" class="notice ok" data-test="sni-saved">{{ sniMessage }}</div>
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
