// Calls the panel's own API (/api/*), same origin.

export class ApiError extends Error {
  constructor(message: string, public errors: string[] = [], public status = 0) {
    super(message)
  }
}

export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string> | undefined) },
  })
  if (r.status === 204) return undefined as T
  // the session ended (expired, or the password changed): back to the sign-in page
  if (r.status === 401 && path !== '/api/login') window.dispatchEvent(new Event('psm:signed-out'))
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new ApiError(body?.error?.message ?? `HTTP ${r.status}`, body?.error?.errors ?? [], r.status)
  return body as T
}

export type Server = {
  id: number; name: string; status: 'pending' | 'online' | 'offline' | 'leaving'
  hostname: string | null; agent_version: string | null; psm_version: string | null; leave_error: string | null
  note: string; last_seen: string | null; created_at: string; status_at: string | null
  node_count: number; traffic_used: number
}

export type NodeStatus = 'waiting' | 'queued' | 'applied' | 'failed' | 'deleting'

export type PanelNode = {
  id: number; server_id: number; protocol: string; variant: string; engine: string; psm_protocol: string
  name: string; address: string; port: number; public_port: number | null; traffic_limit_gb: number
  labels: string[]; params: Record<string, unknown>; status: NodeStatus
  last_error: string | null; created_at: string; has_link: boolean
  traffic_used: number; traffic_paused: boolean; traffic_at: string | null; reset_day: number
}

/**
 * One realm rule on the entry server, forwarding a port of it to somewhere
 * else. `remote_server_id` is set when the landing side is a server in the
 * panel too (so both ends can be named); `remote_host` is always the address
 * the entry server dials.
 */
export type Relay = {
  id: number; server_id: number; name: string; listen_port: number; remote_host: string; remote_port: number
  remote_server_id: number | null; udp: boolean; tls: boolean; tls_sni: string; tls_insecure: boolean
  status: NodeStatus; last_error: string | null; created_at: string
  /** the newest measurement of the hop; null until the first one arrives */
  last_rtt_ms: number | null; last_jitter_ms: number | null; last_loss_pct: number | null
  last_sample_at: string | null; traffic_bytes: number
}

/** One reading of a relay's hop; `bytes` is that interval's traffic. */
export type RelaySample = {
  at: string; rtt_ms: number | null; jitter_ms: number | null; loss_pct: number; bytes: number
}

export type Subscription = {
  id: number; name: string; labels: string[]; url: string; last_used: string | null; created_at: string
  /** format → one of the user's templates (absent: the built-in one) */
  templates: Record<string, number>
}

export type Template = { id: number; name: string; format: string; body: string; created_at: string; updated_at: string | null }
export type Templates = {
  formats: Record<string, string>
  builtin: { format: string; name: string; body: string }[]
  custom: Template[]
}

export const GB = 1024 ** 3

/** 1536 → "1.5 KB" */
export function formatBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = Math.max(0, n || 0), i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${i ? v.toFixed(v < 10 ? 2 : 1) : v} ${units[i]}`
}

/** "2026-09-15 08:00:00" (UTC, from D1) → local time */
export function localTime(t: string | null): string {
  if (!t) return '—'
  const d = new Date(t.replace(' ', 'T') + 'Z')
  return Number.isNaN(d.getTime()) ? t : d.toLocaleString('zh-CN', { hour12: false })
}
