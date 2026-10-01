<script setup lang="ts">
// Bytes per day as bars, the days without traffic included, with the first,
// middle and last date under them. Each bar's title says its day and total.
// `since`: the day this month's counts started; the bars before it (last
// month's, no longer in "本月") are drawn faint.
import { computed } from 'vue'
import { formatBytes } from '../api'

const props = defineProps<{ daily: { day: string; bytes: number }[]; days: number; since?: string | null; test?: string }>()
const bars = computed(() => {
  const byDay = new Map(props.daily.map((d) => [d.day, d.bytes]))
  const out: { day: string; bytes: number; before: boolean }[] = []
  // the panel counts by UTC day (D1's date('now')), so the days are UTC too
  for (let i = props.days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10)
    out.push({ day: d, bytes: byDay.get(d) ?? 0, before: !!props.since && d < props.since })
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
    <div v-for="b in bars" :key="b.day" class="bar" :class="{ before: b.before }" :data-day="b.day"
         :title="`${b.day}：${formatBytes(b.bytes)}${b.before ? '（上个月，不计入本月）' : ''}`">
      <span :style="{ height: `${(b.bytes / peak) * 100}%` }" />
    </div>
  </div>
  <div class="barchart-axis"><span v-for="(a, i) in axis" :key="i">{{ a }}</span></div>
</template>
