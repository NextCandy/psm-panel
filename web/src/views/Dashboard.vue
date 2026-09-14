<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { api, type PanelNode, type Server } from '../api'

const servers = ref<Server[]>([])
const nodes = ref<PanelNode[]>([])
onMounted(async () => {
  ;[servers.value, nodes.value] = await Promise.all([api<Server[]>('/api/servers'), api<PanelNode[]>('/api/nodes')])
})
const online = computed(() => servers.value.filter((s) => s.status === 'online').length)
const applied = computed(() => nodes.value.filter((n) => n.status === 'applied').length)
</script>

<template>
  <div class="page-head">
    <div><h1>仪表盘</h1><p>服务器和节点概况。</p></div>
  </div>
  <div class="stats">
    <div class="card stat"><div class="n">{{ servers.length }}</div><div class="l">服务器</div></div>
    <div class="card stat"><div class="n">{{ online }}</div><div class="l">在线服务器</div></div>
    <div class="card stat"><div class="n">{{ nodes.length }}</div><div class="l">节点</div></div>
    <div class="card stat"><div class="n">{{ applied }}</div><div class="l">运行中的节点</div></div>
  </div>
</template>
