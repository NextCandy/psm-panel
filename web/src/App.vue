<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { api } from './api'
import Login from './components/Login.vue'
import Dashboard from './views/Dashboard.vue'
import Nodes from './views/Nodes.vue'
import Servers from './views/Servers.vue'

// A hash route per page: #/nodes, #/servers …
const pages = [
  { id: 'dashboard', label: '仪表盘', icon: '▦', component: Dashboard },
  { id: 'nodes', label: '节点管理', icon: '◉', component: Nodes },
  { id: 'servers', label: '服务器', icon: '▤', component: Servers },
]
const current = ref('nodes')
const readHash = () => {
  const id = location.hash.replace(/^#\/?/, '')
  current.value = pages.some((p) => p.id === id) ? id : 'nodes'
}
const page = computed(() => pages.find((p) => p.id === current.value)!)

// Signed in or not; `configured` is false until ADMIN_PASSWORD is set.
const auth = ref<'loading' | 'signed-in' | 'signed-out'>('loading')
const configured = ref(true)
async function checkSession() {
  try {
    const s = await api<{ configured: boolean; authenticated: boolean }>('/api/session')
    configured.value = s.configured
    auth.value = s.authenticated ? 'signed-in' : 'signed-out'
  } catch {
    auth.value = 'signed-out'
  }
}
async function logout() {
  await api('/api/logout', { method: 'POST' }).catch(() => undefined)
  auth.value = 'signed-out'
}

onMounted(() => {
  readHash()
  window.addEventListener('hashchange', readHash)
  window.addEventListener('psm:signed-out', () => { auth.value = 'signed-out' })
  checkSession()
})
</script>

<template>
  <Login v-if="auth === 'signed-out'" :configured="configured" @done="auth = 'signed-in'" />
  <div v-else-if="auth === 'signed-in'" class="layout">
    <aside class="sidebar">
      <div class="brand"><span class="brand-logo">P</span> PSM Panel</div>
      <nav class="nav">
        <a v-for="p in pages" :key="p.id" :href="`#/${p.id}`" :class="{ active: p.id === current }">
          <span>{{ p.icon }}</span>{{ p.label }}
        </a>
      </nav>
      <button class="btn ghost small" style="margin: 14px 4px 0" data-test="logout" @click="logout">退出登录</button>
    </aside>
    <main class="main">
      <component :is="page.component" />
    </main>
  </div>
</template>
