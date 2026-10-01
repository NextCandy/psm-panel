<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, ref, watch } from 'vue'
import { api } from './api'
import Login from './components/Login.vue'
import Hosts from './components/Hosts.vue'
import Icon from './components/Icon.vue'
import Footer from './components/Footer.vue'

// A hash route per page (#/nodes, #/servers …). Each page is its own chunk,
// fetched the first time it is opened: the sign-in page loads none of them.
const pages = [
  { id: 'dashboard', label: '仪表盘', icon: 'dashboard', component: defineAsyncComponent(() => import('./views/Dashboard.vue')) },
  { id: 'nodes', label: '节点管理', icon: 'nodes', component: defineAsyncComponent(() => import('./views/Nodes.vue')) },
  { id: 'servers', label: '服务器', icon: 'servers', component: defineAsyncComponent(() => import('./views/Servers.vue')) },
  { id: 'relays', label: '中转', icon: 'relays', component: defineAsyncComponent(() => import('./views/Relays.vue')) },
  { id: 'traffic', label: '流量', icon: 'traffic', component: defineAsyncComponent(() => import('./views/Traffic.vue')) },
  { id: 'subscriptions', label: '订阅', icon: 'subscriptions', component: defineAsyncComponent(() => import('./views/Subscriptions.vue')) },
  { id: 'audit', label: '操作日志', icon: 'log', component: defineAsyncComponent(() => import('./views/Audit.vue')) },
  { id: 'settings', label: '系统设置', icon: 'settings', component: defineAsyncComponent(() => import('./views/Settings.vue')) },
]
const current = ref('dashboard')
const menuOpen = ref(false)
const readHash = () => {
  const id = location.hash.replace(/^#\/?/, '').split('?')[0]
  current.value = pages.some((p) => p.id === id) ? id : 'dashboard'
  menuOpen.value = false
}
const page = computed(() => pages.find((p) => p.id === current.value)!)
watch(page, (p) => { document.title = `${p.label} · PSM Panel` }, { immediate: true })

// Signed in or not; `configured` is false until ADMIN_PASSWORD is set.
const auth = ref<'loading' | 'signed-in' | 'signed-out'>('loading')
const configured = ref(true)
const passwordIgnored = ref(false)
const version = ref('')
async function checkSession() {
  try {
    const s = await api<{ configured: boolean; authenticated: boolean; version: string; password_ignored?: boolean }>('/api/session')
    configured.value = s.configured
    passwordIgnored.value = !!s.password_ignored
    version.value = s.version
    auth.value = s.authenticated ? 'signed-in' : 'signed-out'
  } catch {
    auth.value = 'signed-out'
  }
}
async function logout() {
  await api('/api/logout', { method: 'POST' }).catch(() => undefined)
  auth.value = 'signed-out'
}

// The theme: the system's, or the one picked (kept in this browser).
type Theme = 'auto' | 'light' | 'dark'
const theme = ref<Theme>((localStorage.getItem('psm-theme') as Theme | null) ?? 'auto')
const dark = window.matchMedia('(prefers-color-scheme: dark)')
function applyTheme() {
  const t = theme.value === 'auto' ? (dark.matches ? 'dark' : 'light') : theme.value
  document.documentElement.dataset.theme = t
}
watch(theme, (t) => { localStorage.setItem('psm-theme', t); applyTheme() })
dark.addEventListener('change', applyTheme)
applyTheme()

onMounted(() => {
  readHash()
  window.addEventListener('hashchange', readHash)
  window.addEventListener('psm:signed-out', () => { auth.value = 'signed-out' })
  checkSession()
})
</script>

<template>
  <Login v-if="auth === 'signed-out'" :configured="configured" :password-ignored="passwordIgnored" @done="auth = 'signed-in'" />
  <div v-else-if="auth === 'signed-in'" class="layout" :class="{ 'menu-open': menuOpen }">
    <aside class="sidebar">
      <a class="brand" href="#/dashboard"><img class="brand-logo" src="/logo.svg" alt="" data-test="logo"> PSM Panel
        <small v-if="version" data-test="sidebar-version">v{{ version }}</small></a>
      <nav class="nav">
        <!-- @click: the page already open changes no hash, and the menu (on a phone) must close all the same -->
        <a v-for="p in pages" :key="p.id" :href="`#/${p.id}`" :class="{ active: p.id === current }" :data-test="`nav-${p.id}`"
           :aria-current="p.id === current ? 'page' : undefined" @click="menuOpen = false">
          <Icon :name="p.icon" />{{ p.label }}
        </a>
      </nav>
      <div class="sidebar-foot">
        <div class="theme-switch" role="radiogroup" aria-label="外观">
          <button v-for="t in (['auto', 'light', 'dark'] as const)" :key="t" type="button" :class="{ on: theme === t }"
                  :aria-checked="theme === t" role="radio" :data-test="`theme-${t}`" @click="theme = t">
            {{ t === 'auto' ? '自动' : t === 'light' ? '浅色' : '深色' }}
          </button>
        </div>
        <button class="btn ghost small" style="justify-content: flex-start" data-test="logout"
                title="退出后，所有设备上的登录都会失效" @click="logout"><Icon name="logout" />退出登录</button>
      </div>
    </aside>
    <div class="scrim" @click="menuOpen = false" />
    <div class="main">
      <header class="topbar">
        <button class="btn icon ghost" type="button" aria-label="菜单" data-test="menu" @click="menuOpen = true"><Icon name="menu" /></button>
        <a class="brand" href="#/dashboard"><img class="brand-logo" src="/logo.svg" alt=""> PSM Panel</a>
        <span class="spacer" /><span class="muted small">{{ page.label }}</span>
      </header>
      <main class="content">
        <component :is="page.component" :key="page.id" />
      </main>
      <Footer />
    </div>
  </div>
  <Hosts />
</template>
