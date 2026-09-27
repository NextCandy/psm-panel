// A relay's settings, checked the same way on the page (as they are typed)
// and in the Worker (before anything is stored). The Worker adds what only it
// can know: that the servers exist, the ports they hold, their psm-agent.

export type RelayMode = 'forward' | 'tunnel'
export type RelayEngine = 'realm' | 'gost'
export type RelayTargetInput = { host: string; port: number; server_id?: number | null }

export const RELAY_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/ // psm-agent's tagRe
// DNS labels do not start or end with "-" (psm-agent's relayHostRe)
export const RELAY_HOST_RE = /^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$|^[0-9a-fA-F:.]+$/
export const WS_PATH_RE = /^\/[A-Za-z0-9._~/%-]{0,127}$/
export const RELAY_MAX_TARGETS = 16
/** where a relay's port is picked on a server with no range of its own */
export const RELAY_PORTS: [number, number] = [20000, 60000]

export const RELAY_ENGINE_LABELS: Record<RelayEngine, string> = { realm: 'realm', gost: 'gost' }
export const RELAY_TRANSPORT_LABELS: Record<string, string> = {
  tls: 'TLS', mtls: 'TLS 多路复用', wss: 'WebSocket', mwss: 'WebSocket 多路复用',
}
/** '' is no choice: one landing host, or psm's default (round robin) */
export const RELAY_STRATEGY_LABELS: Record<string, string> = {
  '': '轮询（默认）', round: '轮询', rand: '随机', fifo: '主备（故障切换）', hash: '按客户端 IP',
}
/** the strategies realm has; the others need gost */
export const REALM_STRATEGIES = ['', 'round', 'hash']

export type RelayFields = {
  name: string
  mode: RelayMode
  engine: RelayEngine
  /** null: picked from the server's range */
  listen_port: number | null
  targets: RelayTargetInput[]
  strategy: string
  /** realm's own TLS hop (a forward only) */
  tls: boolean
  tls_sni: string
  /** a tunnel's exit: the address the entry dials, and its port (null: picked) */
  exit_host: string
  exit_port: number | null
  transport: string
  ws_host: string
  ws_path: string
  speed_mbps: number
  limit_gb: number
  reset_day: number
  expires_at: string | null
}

export const goodPort = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 65535
/** "[2001:db8::1]" → "2001:db8::1", spaces trimmed */
export const bareHost = (h: unknown) => String(h ?? '').trim().replace(/^\[(.*)\]$/, '$1')
export const goodHost = (h: string) => !!h && h.length <= 253 && RELAY_HOST_RE.test(h)

/**
 * "host:port" (an IPv6 address in brackets) → its parts, or null. What the
 * batch form and the landing list take.
 */
export function parseHostPort(s: string): { host: string; port: number } | null {
  const m = /^\[([0-9a-fA-F:.]+)\]:(\d{1,5})$/.exec(s.trim()) ?? /^([^:\s[\]]+):(\d{1,5})$/.exec(s.trim())
  return m ? { host: m[1], port: Number(m[2]) } : null
}

/** The problems with a relay's settings, in the words the page shows; none: it can be sent. */
export function relayProblems(f: RelayFields): string[] {
  const errors: string[] = []
  if (!RELAY_NAME_RE.test(f.name)) errors.push('中转名称：字母、数字、. _ -，以字母或数字开头，48 字以内')
  if (f.engine !== 'realm' && f.engine !== 'gost') errors.push('转发程序：realm 或 gost')
  if (f.mode === 'tunnel' && f.engine !== 'gost') errors.push('隧道由 gost 承载')

  if (!f.targets.length) errors.push('落地：至少一个地址和端口')
  if (f.targets.length > RELAY_MAX_TARGETS) errors.push(`落地：最多 ${RELAY_MAX_TARGETS} 个`)
  f.targets.slice(0, RELAY_MAX_TARGETS).forEach((t, i) => {
    const n = f.targets.length > 1 ? `落地 ${i + 1} ` : '落地'
    if (!goodHost(t.host)) errors.push(`${n}地址：域名或 IP`)
    if (!goodPort(t.port)) errors.push(`${n}端口：1-65535`)
  })
  if (!(f.strategy in RELAY_STRATEGY_LABELS)) errors.push('负载均衡：轮询、随机、主备或按客户端 IP')
  else if (f.engine === 'realm' && !REALM_STRATEGIES.includes(f.strategy))
    errors.push('realm 只能轮询或按客户端 IP 分配；主备切换和随机要用 gost')
  if (f.listen_port !== null && !goodPort(f.listen_port)) errors.push('监听端口：1-65535，或留空自动分配')

  if (f.tls && (f.mode !== 'forward' || f.engine !== 'realm')) errors.push('加密这一跳用隧道（gost）；TLS 选项只属于 realm 转发')
  // realm reads its transport as ";"-separated "key=value" and panics on an
  // option it cannot parse: neither character may reach it
  if (f.tls_sni && (f.tls_sni.length > 253 || /[;=\s]/.test(f.tls_sni))) errors.push('TLS 域名：不能包含空格、; 或 =')

  if (f.mode === 'tunnel') {
    if (!goodHost(f.exit_host)) errors.push('出口地址：入口服务器连过去的域名或 IP')
    if (f.exit_port !== null && !goodPort(f.exit_port)) errors.push('隧道端口：1-65535，或留空自动分配')
    if (!(f.transport in RELAY_TRANSPORT_LABELS)) errors.push('隧道传输：TLS、TLS 多路复用、WebSocket 或 WebSocket 多路复用')
    if (f.tls_sni && !RELAY_HOST_RE.test(f.tls_sni)) errors.push('伪装域名（SNI）：一个域名')
    if (f.transport.includes('ws')) {
      if (f.ws_host && !goodHost(f.ws_host)) errors.push('WebSocket Host：一个域名')
      if (f.ws_path && !WS_PATH_RE.test(f.ws_path)) errors.push('WebSocket 路径：以 / 开头，字母、数字和 . _ ~ / % -')
    }
  }

  if (!Number.isFinite(f.speed_mbps) || f.speed_mbps < 0 || f.speed_mbps > 100000) errors.push('限速：0-100000 Mbit/s（0 不限）')
  else if (f.speed_mbps > 0 && f.engine !== 'gost') errors.push('限速要用 gost（realm 没有限速）')
  if (!Number.isFinite(f.limit_gb) || f.limit_gb < 0 || f.limit_gb > 1e6) errors.push('流量限额：0-1000000 GB（0 不限）')
  if (!Number.isInteger(f.reset_day) || f.reset_day < 0 || f.reset_day > 28) errors.push('重置日：0-28（0 不重置）')
  if (f.expires_at && Number.isNaN(Date.parse(f.expires_at))) errors.push('到期时间：日期和时间')
  return errors
}
