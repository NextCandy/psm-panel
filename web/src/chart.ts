// What the panel's charts share. They are drawn as SVG by hand (the panel
// carries no chart library), at the width they are given, in pixels: axis
// text stays text-sized at any width.
import { onMounted, onUnmounted, ref, type Ref } from 'vue'

/** The element's content width in CSS pixels, kept up to date. */
export function useWidth(el: Ref<HTMLElement | null>) {
  const width = ref(0)
  let ro: ResizeObserver | undefined
  onMounted(() => {
    if (!el.value) return
    width.value = el.value.clientWidth
    ro = new ResizeObserver(([e]) => { width.value = e.contentRect.width })
    ro.observe(el.value)
  })
  onUnmounted(() => ro?.disconnect())
  return width
}

/** 1, 2, 2.5 or 5 × 10ⁿ: the round step at or above `raw` */
function niceStep(raw: number): number {
  const p = 10 ** Math.floor(Math.log10(raw)), m = raw / p
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p
}

/** 0 up to a round top at or above `max`, about `count` steps (in steps of `unit`: 1024ⁿ for bytes) */
export function niceTicks(max: number, count = 4, unit = 1): number[] {
  if (!(max > 0)) return [0, unit]
  const step = niceStep(max / unit / count) * unit
  const top = Math.ceil(max / step - 1e-9) * step
  return Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step)
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
/** ticks for a byte axis: round numbers in the unit the largest value is shown in */
export const byteTicks = (max: number, count = 4) =>
  niceTicks(max, count, 1024 ** Math.max(0, Math.min(5, Math.floor(Math.log(Math.max(max, 1)) / Math.log(1024)))))

/** a byte tick, short: "0", "512 KB", "1.5 GB" */
export function byteTick(v: number): string {
  if (!v) return '0'
  let i = 0
  while (v >= 1024 && i < BYTE_UNITS.length - 1) { v /= 1024; i++ }
  return `${+v.toFixed(v < 10 ? 1 : 0)} ${BYTE_UNITS[i]}`
}

/** One panel of a time-series chart: its series share its y axis. */
export type Series = { label: string; cls: string; values: (number | null)[] }
export type Panel = {
  title: string
  series: Series[]
  /** a wash under the line (one series that is an amount: loss, traffic) */
  area?: boolean
  format: (v: number) => string
  tick: (v: number) => string
  ticks: (max: number) => number[]
}

/** The width, in pixels, the longest of these labels needs at the axis' 11px. */
export const labelWidth = (labels: string[]) =>
  Math.ceil(Math.max(0, ...labels.map((s) => [...s].reduce((a, ch) => a + (/[ -~]/.test(ch) ? 6.4 : 11), 0))))
