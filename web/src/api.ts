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
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new ApiError(body?.error?.message ?? `HTTP ${r.status}`, body?.error?.errors ?? [], r.status)
  return body as T
}

export type Server = {
  id: number; name: string; status: 'pending' | 'online' | 'offline'
  hostname: string | null; agent_version: string | null
  note: string; last_seen: string | null; created_at: string; node_count: number
}

export type NodeStatus = 'waiting' | 'queued' | 'applied' | 'failed' | 'deleting'

export type PanelNode = {
  id: number; server_id: number; protocol: string; variant: string; engine: string; psm_protocol: string
  name: string; address: string; port: number; public_port: number | null; traffic_limit_gb: number
  labels: string[]; params: Record<string, unknown>; status: NodeStatus
  last_error: string | null; created_at: string; has_link: boolean
}
