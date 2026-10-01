<script setup lang="ts">
// Measurements over time as panels stacked on one time axis (a relay's round
// trip and jitter, its loss, its traffic): one crosshair across every panel
// and one tooltip with every series at that moment — on hover, a touch, or
// the arrow keys once focused. A line breaks where there is no reading, or
// where the readings stop for a while (the server was away), instead of
// drawing a straight line across the hole.
import { computed, ref } from 'vue'
import { localTime, parseTime } from '../api'
import { labelWidth, useWidth, type Panel } from '../chart'

const props = defineProps<{ times: string[]; panels: Panel[]; test?: string }>()
const plot = ref<HTMLElement | null>(null)
const width = useWidth(plot)

// each panel: its title above, then the plot; the time axis under the last
const PH = 100, T = 8, B = 14, TITLE = 24, AXIS = 22, plotH = PH - T - B
const ms = computed(() => props.times.map((t) => parseTime(t)?.getTime() ?? 0))
const span = computed(() => {
  const t = ms.value
  return t.length ? { t0: t[0], dt: Math.max(1, t[t.length - 1] - t[0]) } : { t0: 0, dt: 1 }
})
const ticks = computed(() => props.panels.map((p) =>
  p.ticks(Math.max(0, ...p.series.flatMap((s) => s.values.filter((v): v is number => v !== null && Number.isFinite(v)))))))
const gutter = computed(() => labelWidth(props.panels.flatMap((p, i) => ticks.value[i].map(p.tick))) + 10)
const plotW = computed(() => Math.max(0, width.value - gutter.value))
const xs = computed(() => ms.value.map((t) => gutter.value + ((t - span.value.t0) / span.value.dt) * plotW.value))
const y = (p: number, v: number) => T + plotH - (v / (ticks.value[p][ticks.value[p].length - 1] || 1)) * plotH

// a reading more than three usual steps after the one before starts a new run
const gapAfter = computed(() => {
  const t = ms.value, steps = t.slice(1).map((v, i) => v - t[i]).sort((a, b) => a - b)
  const usual = steps.length ? steps[Math.floor(steps.length / 2)] : 0
  return t.map((v, i) => i > 0 && usual > 0 && v - t[i - 1] > usual * 3)
})
/** the runs of a series with readings: [[x, y], …] each */
function runs(p: number, values: (number | null)[]): [number, number][][] {
  const out: [number, number][][] = []
  let run: [number, number][] = []
  values.forEach((v, i) => {
    if (gapAfter.value[i] && run.length) { out.push(run); run = [] }
    if (v === null || !Number.isFinite(v)) { if (run.length) out.push(run); run = []; return }
    run.push([xs.value[i], y(p, v)])
  })
  if (run.length) out.push(run)
  return out
}
const linePath = (r: [number, number][]) => r.map(([x, yy], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${yy.toFixed(1)}`).join('')
const areaPath = (r: [number, number][]) =>
  `${linePath(r)}L${r[r.length - 1][0].toFixed(1)},${T + plotH}L${r[0][0].toFixed(1)},${T + plotH}Z`
const drawn = computed(() => props.panels.map((p, pi) =>
  p.series.map((s) => ({ s, runs: runs(pi, s.values) }))))

// times along the bottom, about every 110px, never past either end
const timeLabels = computed(() => {
  const n = props.times.length
  if (!n || !plotW.value) return []
  const long = span.value.dt > 36 * 3600e3, count = Math.max(2, Math.floor(plotW.value / 110))
  const fmt = (t: number) => {
    const d = new Date(t), hm = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
    return long ? `${d.getMonth() + 1}-${d.getDate()} ${hm}` : hm
  }
  return Array.from({ length: count + 1 }, (_, k) => {
    const t = span.value.t0 + (span.value.dt * k) / count
    return { x: gutter.value + (plotW.value * k) / count, text: fmt(t), anchor: k === 0 ? 'start' : k === count ? 'end' : 'middle' }
  }).filter((l, k, all) => k === all.length - 1 || l.text !== all[k + 1].text)   // a short span: a minute once
})

// the moment under the pointer: the nearest reading
const active = ref<number | null>(null)
function point(e: PointerEvent) {
  if (!plot.value || !xs.value.length) return
  const x = e.clientX - plot.value.getBoundingClientRect().left
  let lo = 0, hi = xs.value.length - 1
  while (lo < hi) { const mid = (lo + hi) >> 1; if (xs.value[mid] < x) lo = mid + 1; else hi = mid }
  active.value = lo > 0 && x - xs.value[lo - 1] < xs.value[lo] - x ? lo - 1 : lo
}
function focusIn() { if (active.value === null) active.value = props.times.length - 1 }
function key(e: KeyboardEvent) {
  const n = props.times.length, i = active.value ?? n - 1, page = Math.max(1, Math.round(n / 12))
  const next = ({ ArrowLeft: i - 1, ArrowRight: i + 1, PageUp: i - page, PageDown: i + page, Home: 0, End: n - 1 } as Record<string, number>)[e.key]
  if (next === undefined || !n) return
  e.preventDefault()
  active.value = Math.min(n - 1, Math.max(0, next))
}
const tip = computed(() => {
  const i = active.value
  if (i === null || !width.value) return null
  const x = xs.value[i]
  return {
    when: localTime(props.times[i]),
    rows: props.panels.flatMap((p) => p.series.map((s) => ({ label: s.label, cls: s.cls, value: s.values[i] === null ? '—' : p.format(s.values[i]!) }))),
    style: x > width.value - 190 ? { right: `${width.value - x + 12}px` } : { left: `${x + 12}px` },
  }
})
const panelTop = (p: number) => p * (PH + TITLE)
const totalH = computed(() => props.panels.length * (PH + TITLE) - B + AXIS)
</script>

<template>
  <div class="chart-box series-box" :data-test="test" tabindex="0" role="figure"
       :aria-label="`${panels.map((p) => p.title).join('、')}随时间的变化；左右方向键逐个查看`"
       @keydown="key" @focus="focusIn" @blur="active = null">
    <div ref="plot" class="chart-plot" :style="{ height: `${totalH}px` }"
         @pointermove="point" @pointerdown="point" @pointerleave="active = null">
      <template v-for="(p, pi) in panels" :key="p.title">
        <div class="series-title" :style="{ top: `${panelTop(pi)}px`, left: `${gutter}px` }">
          <span>{{ p.title }}</span>
          <template v-if="p.series.length > 1">
            <span v-for="s in p.series" :key="s.label" class="series-key" :class="s.cls"><span class="tip-key" />{{ s.label }}</span>
          </template>
        </div>
        <svg v-if="width" class="chart-svg" :width="width" :height="PH" :style="{ top: `${panelTop(pi) + TITLE}px` }" aria-hidden="true">
          <g class="chart-grid">
            <line v-for="t in ticks[pi]" :key="t" :x1="gutter" :x2="width" :y1="Math.round(y(pi, t)) + 0.5" :y2="Math.round(y(pi, t)) + 0.5" />
          </g>
          <g class="chart-axis">
            <text v-for="t in ticks[pi]" :key="t" :x="gutter - 10" :y="y(pi, t)" dy="0.32em" text-anchor="end">{{ p.tick(t) }}</text>
          </g>
          <template v-for="d in drawn[pi]" :key="d.s.label">
            <g :class="d.s.cls">
              <template v-if="p.area"><path v-for="(r, k) in d.runs" :key="`a${k}`" class="chart-area" :d="areaPath(r)" /></template>
              <path v-for="(r, k) in d.runs" :key="`l${k}`" class="chart-line" :d="linePath(r)" />
            </g>
          </template>
          <template v-if="active !== null">
            <line class="chart-cross" :x1="xs[active]" :x2="xs[active]" :y1="T" :y2="T + plotH" />
            <template v-for="d in drawn[pi]" :key="`dot-${d.s.label}`">
              <circle v-if="d.s.values[active] !== null" :class="['chart-dot', d.s.cls]" :cx="xs[active]" :cy="y(pi, d.s.values[active]!)" r="4" />
            </template>
          </template>
        </svg>
      </template>
      <svg v-if="width" class="chart-svg-axis" :width="width" :height="AXIS" :style="{ top: `${totalH - AXIS}px` }" aria-hidden="true">
        <g class="chart-axis"><text v-for="l in timeLabels" :key="l.x" :x="l.x" :y="15" :text-anchor="l.anchor">{{ l.text }}</text></g>
      </svg>
      <div v-if="tip" class="chart-tip" :style="tip.style" data-test="chart-tip">
        <div class="muted">{{ tip.when }}</div>
        <div v-for="r in tip.rows" :key="r.label" class="tip-row" :class="r.cls"><span class="tip-key" /><b>{{ r.value }}</b><span>{{ r.label }}</span></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.series-box { padding: 0 }
.chart-plot > svg { position: absolute; left: 0 }
.series-title { position: absolute; display: flex; align-items: center; gap: 12px; font-size: 12px; color: var(--muted); line-height: 20px; white-space: nowrap }
.series-key { display: inline-flex; align-items: center; gap: 5px }
</style>
