<script setup lang="ts">
// Bytes per day as columns, the days without traffic included: a y axis in
// round byte steps, the date under every few columns, and on hover (a touch,
// or the arrow keys once focused) the day's total in a tooltip. `since`: the
// day this month's counts started; the columns before it (last month's, no
// longer in 本月) are drawn faint.
import { computed, ref } from 'vue'
import { formatBytes } from '../api'
import { byteTick, byteTicks, labelWidth, useWidth } from '../chart'

const props = defineProps<{ daily: { day: string; bytes: number }[]; days: number; since?: string | null; test?: string }>()
const plot = ref<HTMLElement | null>(null)
const width = useWidth(plot)

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

// the frame: plot height, top and bottom (the dates) bands, the y labels' gutter
const H = 176, T = 8, B = 24, plotH = H - T - B
const ticks = computed(() => byteTicks(Math.max(...bars.value.map((b) => b.bytes))))
const gutter = computed(() => labelWidth(ticks.value.map(byteTick)) + 10)
const slot = computed(() => Math.max(0, width.value - gutter.value) / bars.value.length)
// at most 24px wide, never filling the slot: the rest is air between columns
const barW = computed(() => Math.max(2, Math.min(24, slot.value * 0.66)))
const cx = (i: number) => gutter.value + slot.value * (i + 0.5)
const y = (v: number) => T + plotH - (v / ticks.value[ticks.value.length - 1]) * plotH
/** a column: 4px round at its top, square on the baseline; nothing for 0 */
function barPath(b: number, i: number): string {
  if (!b) return ''
  const w = barW.value, x = cx(i) - w / 2, base = T + plotH, top = Math.min(y(b), base - 2)
  const r = Math.min(4, w / 2, base - top)
  return `M${x},${base}V${top + r}Q${x},${top} ${x + r},${top}H${x + w - r}Q${x + w},${top} ${x + w},${top + r}V${base}Z`
}
// a date under every few columns, today's always among them
const labels = computed(() => {
  const n = bars.value.length, every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor((width.value - gutter.value) / 58))))
  return bars.value.map((_, i) => i).filter((i) => (n - 1 - i) % every === 0)
})

// the day under the pointer (or chosen with the keys)
const active = ref<number | null>(null)
function point(e: PointerEvent) {
  if (!plot.value || !slot.value) return
  const i = Math.floor((e.clientX - plot.value.getBoundingClientRect().left - gutter.value) / slot.value)
  active.value = Math.min(bars.value.length - 1, Math.max(0, i))
}
function focusIn() { if (active.value === null) active.value = bars.value.length - 1 }
function key(e: KeyboardEvent) {
  const n = bars.value.length, i = active.value ?? n - 1
  const next = ({ ArrowLeft: i - 1, ArrowRight: i + 1, Home: 0, End: n - 1 } as Record<string, number>)[e.key]
  if (next === undefined) return
  e.preventDefault()
  active.value = Math.min(n - 1, Math.max(0, next))
}
const tip = computed(() => {
  if (active.value === null || !width.value) return null
  const b = bars.value[active.value], x = cx(active.value)
  return {
    b, week: `周${'日一二三四五六'[new Date(`${b.day}T00:00:00Z`).getUTCDay()]}`,
    // beside the column, on whichever side has room
    style: x > width.value - 170 ? { right: `${width.value - x + barW.value / 2 + 10}px` } : { left: `${x + barW.value / 2 + 10}px` },
  }
})
const total = computed(() => bars.value.reduce((a, b) => a + b.bytes, 0))
</script>

<template>
  <div class="chart-box" :data-test="test" tabindex="0" role="figure"
       :aria-label="`最近 ${days} 天每天的流量，共 ${formatBytes(total)}；左右方向键逐日查看`"
       @keydown="key" @focus="focusIn" @blur="active = null">
    <div ref="plot" class="chart-plot" :class="{ hovering: active !== null }"
         @pointermove="point" @pointerdown="point" @pointerleave="active = null">
      <svg v-if="width" :width="width" :height="H" aria-hidden="true">
        <g class="chart-grid">
          <line v-for="t in ticks" :key="t" :x1="gutter" :x2="width" :y1="Math.round(y(t)) + 0.5" :y2="Math.round(y(t)) + 0.5" />
        </g>
        <g class="chart-axis">
          <text v-for="t in ticks" :key="t" :x="gutter - 10" :y="y(t)" dy="0.32em" text-anchor="end">{{ byteTick(t) }}</text>
          <text v-for="i in labels" :key="i" :x="cx(i)" :y="H - 6" text-anchor="middle">{{ bars[i].day.slice(5) }}</text>
        </g>
        <rect v-if="active !== null" class="chart-col" :x="cx(active) - slot / 2 + 1" :y="T" :width="Math.max(0, slot - 2)" :height="plotH" rx="4" />
        <path v-for="(b, i) in bars" :key="b.day" :d="barPath(b.bytes, i)" class="col-bar"
              :class="{ before: b.before, on: active === i }" :data-day="b.day" />
      </svg>
      <div v-if="tip" class="chart-tip" :style="tip.style" data-test="chart-tip">
        <b>{{ formatBytes(tip.b.bytes) }}</b>
        <div class="muted">{{ tip.b.day }} {{ tip.week }}</div>
        <div v-if="tip.b.before" class="faint">上个月，不计入本月</div>
      </div>
    </div>
    <table class="sr-only">
      <caption>每天的流量（UTC 日期）</caption>
      <tbody><tr v-for="b in bars" :key="b.day"><th scope="row">{{ b.day }}</th><td>{{ formatBytes(b.bytes) }}</td></tr></tbody>
    </table>
  </div>
</template>
