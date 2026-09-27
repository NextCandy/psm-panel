// What every page shares: toasts, the confirmation dialog, polling, copying.
import { onMounted, onUnmounted, reactive, ref } from 'vue'

// ── toasts ───────────────────────────────────────────────────────────────────
export type Toast = { id: number; kind: 'ok' | 'err' | 'info'; text: string }
export const toasts = ref<Toast[]>([])
let toastId = 0
export function toast(text: string, kind: Toast['kind'] = 'ok', ms = kind === 'err' ? 7000 : 3500) {
  const id = ++toastId
  toasts.value = [...toasts.value.slice(-3), { id, kind, text }]
  setTimeout(() => dismiss(id), ms)
}
export const dismiss = (id: number) => { toasts.value = toasts.value.filter((t) => t.id !== id) }

// ── the confirmation dialog (in the page: window.confirm blocks and cannot be styled) ──
export type ConfirmOptions = { title: string; body?: string; ok?: string; danger?: boolean; typed?: string }
export const confirmState = reactive<{ open: boolean; opts: ConfirmOptions; resolve: ((v: boolean) => void) | null }>({
  open: false, opts: { title: '' }, resolve: null,
})
/** Resolves true when the admin agrees. `typed`: a word to type first, for what cannot be undone. */
export function confirmAction(opts: ConfirmOptions): Promise<boolean> {
  confirmState.resolve?.(false)
  return new Promise((resolve) => Object.assign(confirmState, { open: true, opts, resolve }))
}
export function settleConfirm(v: boolean) {
  confirmState.resolve?.(v)
  Object.assign(confirmState, { open: false, resolve: null })
}

// ── polling ──────────────────────────────────────────────────────────────────
/**
 * Calls `fn` every `ms` while the page is on screen (not in a hidden tab: a
 * panel left open in the background costs no requests), and at once when it
 * comes back into view. `fast()` true: every `fastMs` instead — while
 * something is on its way to a server.
 */
export function usePoll(fn: () => unknown, ms: number, fast: () => boolean = () => false, fastMs = 3000) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  const schedule = () => {
    clearTimeout(timer)
    if (stopped) return
    timer = setTimeout(tick, fast() ? fastMs : ms)
  }
  const tick = async () => {
    if (document.visibilityState === 'visible') {
      try { await fn() } catch { /* the page shows its own errors */ }
    }
    schedule()
  }
  const onVisible = () => { if (document.visibilityState === 'visible') tick() }
  onMounted(() => { document.addEventListener('visibilitychange', onVisible); schedule() })
  onUnmounted(() => { stopped = true; clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible) })
  return { now: tick }
}

// ── copying ──────────────────────────────────────────────────────────────────
export async function copyText(text: string, what = '已复制') {
  try {
    await navigator.clipboard.writeText(text)
    toast(what)
  } catch {
    // no clipboard (plain http, an old browser): the text is selectable where it is shown
    toast('浏览器不允许复制，请手动选中复制', 'err')
  }
}

/** "abc…xyz" for a secret shown in a list: enough to tell two apart, not enough to use. */
export function maskMiddle(s: string, keep = 4): string {
  return s.length <= keep * 2 + 3 ? '•'.repeat(Math.max(6, s.length)) : `${s.slice(0, keep)}••••••${s.slice(-keep)}`
}
