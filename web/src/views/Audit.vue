<script setup lang="ts">
// 操作日志: the audit log, newest first, a page at a time, by kind of action.
import { onMounted, ref, watch } from 'vue'
import { api, errorText, localTime, type AuditEntry } from '../api'
import { toast } from '../ui'
import { actionLabel } from '../audit'

const log = ref<AuditEntry[]>([])
const loaded = ref(false)
const more = ref(false)
const category = ref('')
const PAGE = 30
async function loadLog(fresh = false) {
  const before = fresh ? '' : `&before=${log.value[log.value.length - 1]?.id ?? ''}`
  try {
    const rows = await api<AuditEntry[]>(`/api/audit?limit=${PAGE}${category.value ? `&action=${category.value}` : ''}${before}`)
    log.value = fresh ? rows : [...log.value, ...rows]
    more.value = rows.length === PAGE
  } catch (e) {
    toast(errorText(e), 'err')
  } finally {
    loaded.value = true
  }
}
onMounted(() => loadLog(true))
watch(category, () => loadLog(true))
const categories = [
  { id: '', label: '全部' }, { id: 'login', label: '登录' }, { id: 'server', label: '服务器' }, { id: 'node', label: '节点' },
  { id: 'relay', label: '中转' }, { id: 'subscription', label: '订阅' }, { id: 'settings', label: '设置' }, { id: 'template', label: '模板' },
]
const actor = (a: string) => (a === 'admin' ? '管理员' : a === 'agent' ? '服务器' : a === 'anonymous' ? '未登录' : a)
</script>

<template>
  <div class="page-head">
    <div><h1>操作日志</h1><p>登录、服务器接入，以及对服务器、节点、中转、订阅和设置的每一次修改。</p></div>
  </div>

  <div class="card">
    <div class="toolbar">
      <div class="segmented" style="padding: 2px" data-test="audit-filter">
        <button v-for="c in categories" :key="c.id" type="button" :class="{ on: category === c.id }" style="padding: 4px 10px"
                :data-test="`audit-filter-${c.id || 'all'}`" @click="category = c.id">{{ c.label }}</button>
      </div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>时间</th><th>操作者</th><th>操作</th><th>对象</th><th>详情</th></tr></thead>
        <tbody>
          <tr v-for="e in log" :key="e.id" :data-test="`audit-${e.action}`">
            <td>{{ localTime(e.at) }}</td>
            <td>{{ actor(e.actor) }}</td>
            <td>{{ actionLabel(e.action) }}</td>
            <td>{{ e.target }}</td>
            <td class="muted" style="white-space: normal; min-width: 240px">{{ e.detail }}</td>
          </tr>
        </tbody>
      </table>
      <div v-if="loaded && !log.length" class="empty">暂无记录。</div>
    </div>
    <div v-if="more" class="pager"><button class="btn small" type="button" data-test="audit-more" @click="loadLog()">加载更多</button></div>
  </div>
</template>
