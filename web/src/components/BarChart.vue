<script setup lang="ts">
// Bytes per day as bars, the days without traffic included, with the first,
// middle and last date under them. Each bar's title says its day and total.
import { computed } from 'vue'
import { formatBytes } from '../api'

const props = defineProps<{ daily: { day: string; bytes: number }[]; days: number; test?: string }>()
const bars = computed(() => {
  const byDay = new Map(props.daily.map((d) => [d.day, d.bytes]))
  const out: { day: string; bytes: number }[] = []
  // the panel counts by UTC day (D1's date('now')), so the days are UTC too
  for (let i = props.days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10)
    out.push({ day: d, bytes: byDay.get(d) ?? 0 })
  }
  return out
})
const peak = computed(() => Math.max(1, ...bars.value.map((b) => b.bytes)))
const axis = computed(() => {
  const b = bars.value
  return b.length ? [b[0].day.slice(5), b[Math.floor(b.length / 2)].day.slice(5), b[b.length - 1].day.slice(5)] : []
})
</script>

<template>
  <div class="barchart" :data-test="test" role="img" :aria-label="`最近 ${days} 天每天的流量`">
    <div v-for="b in bars" :key="b.day" class="bar" :title="`${b.day}：${formatBytes(b.bytes)}`">
      <span :style="{ height: `${(b.bytes / peak) * 100}%` }" />
    </div>
  </div>
  <div class="barchart-axis"><span v-for="(a, i) in axis" :key="i">{{ a }}</span></div>
</template>
