<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { api, errorText } from '../api'
import { confirmAction, toast } from '../ui'
import SecretText from '../components/SecretText.vue'
import Icon from '../components/Icon.vue'

type Settings = {
  version: string; agent_version: string; panel_url: string; effective_panel_url: string; sync_interval: number
  token_key: 'panel' | 'secret' | 'both' | 'mismatch'
  sni_engine: string; sni_key_set: boolean
}
const settings = ref<Settings | null>(null)
async function load() {
  try {
    settings.value = await api<Settings>('/api/settings')
    panelUrl.value = settings.value.panel_url
    sniEngine.value = settings.value.sni_engine || 'netlas'
  } catch (e) {
    toast(errorText(e), 'err')
  }
}
onMounted(load)

// ── the panel's address ──────────────────────────────────────────────────────
const panelUrl = ref('')
const urlError = ref('')
// what the Worker accepts: https, or http for this machine or a LAN (a test panel)
const urlHint = computed(() => {
  const u = panelUrl.value.trim()
  if (!u || u.startsWith('https://')) return ''
  return /^http:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|[^./:]+(:|$))/.test(u)
    ? 'http:// 只适合本机或内网的测试面板' : '要用 https://：节点的密钥和 agent 的令牌经这个地址传输'
})
async function saveUrl() {
  urlError.value = ''
  try {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify({ panel_url: panelUrl.value }) })
    toast('已保存。之后生成的安装命令和订阅地址都用这个地址')
    await load()
  } catch (e) {
    urlError.value = errorText(e)
  }
}

// ── the key D1 is encrypted with ─────────────────────────────────────────────
const reveal = reactive({ password: '', key: '', error: '', busy: false })
async function revealKey() {
  Object.assign(reveal, { error: '', busy: true })
  try {
    const r = await api<{ token_key: string }>('/api/settings/token-key/reveal', { method: 'POST', body: JSON.stringify({ password: reveal.password }) })
    Object.assign(reveal, { key: r.token_key, password: '' })
  } catch (e) {
    Object.assign(reveal, { error: errorText(e), password: '' })
  } finally {
    reveal.busy = false
  }
}
async function forgetKey() {
  const ok = await confirmAction({
    title: '删除数据库里的密钥副本？', danger: true, ok: '删除副本', typed: 'TOKEN_KEY',
    body: '之后密钥只在 Cloudflare 的 TOKEN_KEY 机密里：导出的数据库单独拿走也解不开。\n这个机密以后不能删也不能改——没有它，面板里的节点、订阅都读不出来。',
  })
  if (!ok) return
  try {
    await api('/api/settings/token-key/forget', { method: 'POST' })
    reveal.key = ''
    toast('数据库里的密钥副本已删除')
    await load()
  } catch (e) {
    toast(errorText(e), 'err')
  }
}

// ── the mapping engine for REALITY camouflage targets ───────────────────────
const sniEngine = ref('netlas')
const sniKey = ref('')
async function saveSni() {
  try {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify({ sni_engine: sniEngine.value, ...(sniKey.value ? { sni_key: sniKey.value } : {}) }) })
    sniKey.value = ''
    toast('已保存。新建 REALITY 节点时可以用“自动选择伪装目标”')
    await load()
  } catch (e) {
    toast(errorText(e), 'err')
  }
}
async function clearSniKey() {
  if (!(await confirmAction({ title: '清除网络测绘引擎的 API Key？', ok: '清除', danger: true }))) return
  try {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify({ sni_key: '' }) })
    await load()
  } catch (e) {
    toast(errorText(e), 'err')
  }
}

// ── sessions ─────────────────────────────────────────────────────────────────
async function signOutEverywhere() {
  if (!(await confirmAction({ title: '退出所有设备？', body: '所有浏览器里的登录（包括这一个）都会失效，需要重新输入密码。', ok: '全部退出', danger: true }))) return
  await api('/api/logout', { method: 'POST' }).catch(() => undefined)
  window.dispatchEvent(new Event('psm:signed-out'))
}
</script>

<template>
  <div class="page-head">
    <div><h1>系统设置</h1></div>
  </div>

  <div v-if="settings" class="grid-2 section">
    <div class="card card-pad">
      <form class="field" style="margin: 0" @submit.prevent="saveUrl">
        <label>面板地址</label>
        <div class="cmd">
          <input v-model="panelUrl" class="input" :placeholder="settings.effective_panel_url" data-test="panel-url">
          <button class="btn primary" type="submit" data-test="save-settings">保存</button>
        </div>
        <div v-if="urlError" class="error-text" data-test="panel-url-error">{{ urlError }}</div>
        <div v-else-if="urlHint" class="help" style="color: var(--warn)">{{ urlHint }}</div>
        <div class="help">安装命令和订阅地址用它；留空用当前访问的地址（{{ settings.effective_panel_url }}）。</div>
      </form>
    </div>
    <div class="card card-pad">
      <dl class="facts">
        <dt>面板版本</dt><dd data-test="panel-version">{{ settings.version }}</dd>
        <dt>psm-agent</dt><dd>{{ settings.agent_version }}（服务器页可一键升级）</dd>
        <dt>同步间隔</dt><dd>空闲时每 {{ settings.sync_interval }} 秒，有任务时每 3 秒</dd>
        <dt>源代码</dt><dd><a href="https://github.com/jinqians/proxy-stack" target="_blank" rel="noopener noreferrer">github.com/jinqians/proxy-stack</a></dd>
      </dl>
    </div>
  </div>

  <!-- where the key lives -->
  <div v-if="settings" class="card card-pad section" data-test="token-key">
    <div class="hstack" style="margin-bottom: 10px"><Icon name="key" /><strong>数据加密密钥</strong>
      <span class="badge" :class="{ ok: settings.token_key === 'secret', warn: settings.token_key === 'panel' || settings.token_key === 'both', err: settings.token_key === 'mismatch' }"
            :data-test="`token-key-${settings.token_key}`">
        {{ { secret: '只在机密里', panel: '保存在数据库里', both: '机密里也有了', mismatch: '机密和数据不一致' }[settings.token_key] }}
      </span>
    </div>
    <p v-if="settings.token_key === 'secret'" class="muted" style="margin: 0">节点的密码、链接和订阅地址用 Cloudflare 机密 <code>TOKEN_KEY</code> 加密后存进 D1；数据库里没有密钥，单独拿走解不开。这个机密不能删也不能改。</p>
    <template v-else>
      <div v-if="settings.token_key === 'panel'" class="notice warn">
        <strong>密钥和它加密的数据放在同一个数据库里。</strong>
        一键部署时面板自己生成了密钥并存进 D1：谁拿到数据库的导出，就能解开所有节点的密码。
        把它挪进 Cloudflare 机密：① 输入管理员密码查看密钥；② 在 Worker 的“设置 → 变量和机密”里添加机密 <code>TOKEN_KEY</code>，值就是这把密钥（一字不差）；③ 部署生效后回到这里删除数据库里的副本。
      </div>
      <div v-else-if="settings.token_key === 'both'" class="notice info">
        <strong>TOKEN_KEY 机密已经和数据库里的密钥一致。</strong>现在可以删除数据库里的副本。
      </div>
      <div v-else class="notice err">
        <strong>TOKEN_KEY 机密不是写入数据时用的那把密钥。</strong>之前保存的节点、订阅现在解不开。把 TOKEN_KEY 改成数据库里的这把（下面可以查看），或者删掉这个机密。
      </div>
      <div v-if="reveal.key" class="field">
        <label>密钥（base64）</label>
        <SecretText :value="reveal.key" test="token-key-value" copied="已复制密钥" />
        <div class="help">只给 Cloudflare 的机密用，不要贴到别处。</div>
      </div>
      <form v-else class="cmd" style="max-width: 520px" @submit.prevent="revealKey">
        <input v-model="reveal.password" class="input" type="password" autocomplete="current-password" placeholder="管理员密码" data-test="reveal-password">
        <button class="btn" type="submit" :disabled="!reveal.password || reveal.busy" data-test="reveal-key">查看密钥</button>
      </form>
      <div v-if="reveal.error" class="error-text">{{ reveal.error }}</div>
      <button v-if="settings.token_key === 'both'" class="btn danger" type="button" style="margin-top: 12px" data-test="forget-key" @click="forgetKey">
        <Icon name="trash" />删除数据库里的副本
      </button>
    </template>
  </div>

  <div v-if="settings" class="grid-2 section">
    <div class="card card-pad">
      <form class="field" style="margin: 0" @submit.prevent="saveSni">
        <label>网络测绘引擎（REALITY 自动选择伪装目标）</label>
        <div class="cmd">
          <select v-model="sniEngine" class="select" style="max-width: 150px" data-test="sni-engine">
            <option value="netlas">Netlas</option><option value="quake">Quake（360）</option>
            <option value="zoomeye">ZoomEye</option><option value="fofa">FOFA</option>
          </select>
          <input v-model="sniKey" class="input" type="password" autocomplete="off" data-test="sni-key"
            :placeholder="settings.sni_key_set ? '已保存 API Key（留空不修改）' : 'API Key'">
          <button class="btn primary" type="submit" data-test="save-sni">保存</button>
        </div>
        <div class="help">面板用它查服务器所在网络里的网站，API Key 只保存在面板（加密），不会发到服务器。
          <button v-if="settings.sni_key_set" class="link-btn" type="button" @click="clearSniKey">清除 Key</button></div>
      </form>
    </div>
    <div class="card card-pad">
      <div class="field-label">登录</div>
      <p class="muted" style="margin: 0 0 12px">登录保持 7 天。退出登录会让所有设备上的登录一起失效；修改 ADMIN_PASSWORD 也一样。</p>
      <button class="btn" type="button" data-test="sign-out-everywhere" @click="signOutEverywhere"><Icon name="logout" />退出所有设备</button>
    </div>
  </div>
</template>
