<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
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
onMounted(() => {
  readHash()
  window.addEventListener('hashchange', readHash)
})
const page = computed(() => pages.find((p) => p.id === current.value)!)
</script>

<template>
  <div class="layout">
    <aside class="sidebar">
      <div class="brand"><span class="brand-logo">P</span> PSM Panel</div>
      <nav class="nav">
        <a v-for="p in pages" :key="p.id" :href="`#/${p.id}`" :class="{ active: p.id === current }">
          <span>{{ p.icon }}</span>{{ p.label }}
        </a>
      </nav>
    </aside>
    <main class="main">
      <component :is="page.component" />
    </main>
  </div>
</template>
