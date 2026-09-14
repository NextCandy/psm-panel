<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { api, formatBytes, type PanelNode, type Server } from '../api'

const servers = ref<Server[]>([])
const nodes = ref<PanelNode[]>([])
const today = ref(0)
onMounted(async () => {
  const [s, n, t] = await Promise.all([
    api<Server[]>('/api/servers'), api<PanelNode[]>('/api/nodes'),
    api<{ daily: { day: string; bytes: number }[] }>('/api/traffic?days=1'),
  ])
  servers.value = s
  nodes.value = n
  today.value = t.daily.reduce((a, d) => a + d.bytes, 0)
})
const online = computed(() => servers.value.filter((s) => s.status === 'online').length)
const applied = computed(() => nodes.value.filter((n) => n.status === 'applied').length)
const failed = computed(() => nodes.value.filter((n) => n.status === 'failed').length)
const month = computed(() => nodes.value.reduce((a, n) => a + (n.traffic_used || 0), 0))
</script>

<template>
  <div class="page-head">
    <div><h1>仪表盘</h1><p>服务器、节点和流量概况。</p></div>
  </div>
  <div class="stats">
    <div class="card stat"><div class="n">{{ servers.length }}</div><div class="l">服务器</div></div>
    <div class="card stat"><div class="n" data-test="online-count">{{ online }}</div><div class="l">在线服务器</div></div>
    <div class="card stat"><div class="n">{{ nodes.length }}</div><div class="l">节点</div></div>
    <div class="card stat"><div class="n">{{ applied }}</div><div class="l">运行中的节点</div></div>
    <div class="card stat"><div class="n">{{ failed }}</div><div class="l">失败的节点</div></div>
    <div class="card stat"><div class="n">{{ formatBytes(month) }}</div><div class="l">本月流量</div></div>
    <div class="card stat"><div class="n">{{ formatBytes(today) }}</div><div class="l">今日流量</div></div>
  </div>
</template>
