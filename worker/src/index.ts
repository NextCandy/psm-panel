// PSM panel backend: servers, nodes, traffic, subscriptions, the one-click
// install command, and the task queue each server's psm-agent syncs with. The
// panel never connects to a server: agents connect out to it (like Xboard's
// node backends), so no server needs a subdomain or an open port.
import { Hono, type Context } from 'hono'
import { decrypt, encrypt } from './crypto'
import { ensureSchema, storedTokenKey } from './schema'
import {
  adminConfigured, clearFailures, clearedCookie, passwordMatches, recordFailure, sessionCookie, tooManyFailures, validSession,
} from './auth'
import { buildSubscription, pickFormat, type SubNode } from './subscription'
import { activeFields, findVariant, trafficTag, validateNode, type NodeInput } from '../../shared/protocols'

// not exported: every export of a Worker's main module is taken for an entrypoint
const PANEL_VERSION = '0.4.0'

export type Env = {
  DB: D1Database
  ASSETS: Fetcher
  /** the admin password (secret; the Deploy to Cloudflare form asks for it) */
  ADMIN_PASSWORD?: string
  /** the key for D1 (secret, optional): filled in from D1's own when not set */
  TOKEN_KEY: string
  /** the panel's public address, used in the install command (default: the request's origin) */
  PANEL_URL?: string
  /** where bootstrap.sh is served */
  INSTALL_URL?: string
  /** seconds between agent syncs when there is nothing to do (default 30) */
  SYNC_INTERVAL?: string
}

type ServerRow = {
  id: number; name: string; agent_token_hash: string | null; hostname: string | null
  agent_version: string | null; note: string; last_seen: string | null; created_at: string
  psm_version: string | null; status_enc: string | null; status_at: string | null
}
type NodeRow = {
  id: number; server_id: number; protocol: string; variant: string; engine: string; psm_protocol: string
  name: string; address: string; port: number; public_port: number | null; traffic_limit_gb: number
  labels: string; params_enc: string; link_enc: string | null; outbound_enc: string | null
  status: string; last_error: string | null; created_at: string
  traffic_used: number; traffic_paused: number; traffic_at: string | null; reset_day: number
}
type TaskRow = { id: number; server_id: number; node_id: number | null; kind: string; payload_enc: string; status: string }
type AgentResult = { task_id: number; ok: boolean; link?: string; outbound?: unknown; error?: string; output?: unknown }
type TrafficEntry = { tag?: unknown; used_bytes?: unknown; paused?: unknown }
type C = Context<{ Bindings: Env }>

const app = new Hono<{ Bindings: Env }>()

const fail = (code: string, message: string, extra: Record<string, unknown> = {}) => ({ error: { code, message, ...extra } })
const SERVER_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/
const JOIN_TTL_HOURS = 24
const FAST_INTERVAL = 3        // seconds between syncs while a server has tasks under way
const TASK_RETRY_MINUTES = 5   // a task claimed but not reported for this long is handed out again
const GB = 1024 ** 3
const MASK = '••••••'          // how the page sees a stored password

// Agents sync every SYNC_INTERVAL seconds when idle (30 by default; each sync
// is one Worker request and one D1 write, so a longer interval leaves the free
// quotas for more servers) and every FAST_INTERVAL seconds while tasks are
// under way. A server is online while it synced within three intervals.
function syncInterval(env: Env): number {
  const n = Number(env.SYNC_INTERVAL)
  return Number.isFinite(n) && n >= 5 && n <= 300 ? Math.round(n) : 30
}

app.onError((err, c) => {
  console.error(err)
  return c.json(fail('internal', 'internal error'), 500)
})

// ── helpers ──────────────────────────────────────────────────────────────────
async function sha256Hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function randomToken(bytes = 32): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes))
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function getSetting(env: Env, key: string): Promise<string | null> {
  const r = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>()
  return r?.value ?? null
}

/** The address servers and subscribers use: the setting, PANEL_URL, or this request's origin. */
async function panelUrl(c: C): Promise<string> {
  return (await getSetting(c.env, 'panel_url')) || c.env.PANEL_URL || new URL(c.req.url).origin
}

async function installCommand(c: C, token: string): Promise<string> {
  const install = c.env.INSTALL_URL ?? 'https://psm.jinqians.com'
  return `bash <(curl -fsSL ${install}) --panel ${await panelUrl(c)} --join ${token}`
}

async function audit(env: Env, action: string, target = '', detail = '', actor = 'admin') {
  await env.DB.prepare('INSERT INTO audit (actor, action, target, detail) VALUES (?, ?, ?, ?)')
    .bind(actor, action, target.slice(0, 120), detail.slice(0, 500)).run()
}

/**
 * A new one-time join token for a server. Earlier ones stay valid until they
 * expire (an install command already handed out must keep working); the first
 * one used makes the server join and voids the rest.
 */
async function newJoinToken(env: Env, serverId: number): Promise<string> {
  const token = randomToken()
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM join_tokens WHERE expires_at <= datetime('now')`),
    env.DB.prepare(`INSERT INTO join_tokens (token_hash, server_id, expires_at) VALUES (?, ?, datetime('now', '+${JOIN_TTL_HOURS} hours'))`)
      .bind(await sha256Hex(token), serverId),
  ])
  return token
}

const serverStatusSQL = (env: Env) => `CASE WHEN s.agent_token_hash IS NULL THEN 'pending'
  WHEN s.last_seen >= datetime('now', '-${syncInterval(env) * 3} seconds') THEN 'online' ELSE 'offline' END`

async function getServer(env: Env, id: string | number): Promise<ServerRow | null> {
  if (!/^\d+$/.test(String(id))) return null
  return env.DB.prepare('SELECT * FROM servers WHERE id = ?').bind(Number(id)).first<ServerRow>()
}

async function getNode(env: Env, id: string | number): Promise<NodeRow | null> {
  if (!/^\d+$/.test(String(id))) return null
  return env.DB.prepare('SELECT * FROM nodes WHERE id = ?').bind(Number(id)).first<NodeRow>()
}

async function enqueue(env: Env, serverId: number, nodeId: number | null, task: Record<string, unknown>) {
  await env.DB.prepare('INSERT INTO tasks (server_id, node_id, kind, payload_enc) VALUES (?, ?, ?, ?)')
    .bind(serverId, nodeId, task.kind as string, await encrypt(env.TOKEN_KEY, JSON.stringify(task))).run()
}

const linkFormat = (n: { psm_protocol: string }) => (n.psm_protocol === 'snell' ? 'surge' : 'uri')

/**
 * The tasks that put a node on its server: the node itself (psm-agent installs
 * a missing core first; a standalone node is the standalone server), then its
 * traffic metering and limit.
 */
async function queueApply(env: Env, n: NodeRow, data: Record<string, unknown>, kind: 'add' | 'update' = 'add') {
  const common = { protocol: n.psm_protocol, server: n.address, format: linkFormat(n) }
  if (n.engine === 'standalone') {
    await enqueue(env, n.server_id, n.id, { kind: 'standalone.install', tag: n.name, data, ...common })
  } else if (kind === 'update') {
    await enqueue(env, n.server_id, n.id, { kind: 'node.update', core: n.engine, tag: n.name, data, ...common })
  } else {
    await enqueue(env, n.server_id, n.id, { kind: 'node.add', core: n.engine, data, ...common })
  }
  await enqueue(env, n.server_id, n.id, trafficTask(n))
}

function trafficTask(n: NodeRow) {
  return { kind: 'traffic.set', tag: trafficTag(n), limit_bytes: Math.round((n.traffic_limit_gb || 0) * GB), reset_day: n.reset_day || 1 }
}

/** The node store fields for a node (as validated when it was entered). */
async function nodeData(env: Env, n: NodeRow): Promise<Record<string, unknown>> {
  const params = JSON.parse(await decrypt(env.TOKEN_KEY, n.params_enc)) as Record<string, unknown>
  const v = validateNode({
    protocol: n.protocol, variant: n.variant, engine: n.engine as NodeInput['engine'], name: n.name,
    address: n.address, port: n.port, public_port: n.public_port ?? undefined, params,
  })
  if (!v.ok) throw new Error(`stored node ${n.id} no longer validates: ${v.errors.join('; ')}`)
  return v.data
}

/** A node row for the page: params decrypted, secrets masked, no link. */
async function publicNode(env: Env, n: NodeRow) {
  const params = JSON.parse(await decrypt(env.TOKEN_KEY, n.params_enc)) as Record<string, unknown>
  const v = findVariant(n.protocol, n.variant)
  const secret = new Set((v?.fields ?? []).filter((f) => f.type === 'password').map((f) => f.key))
  for (const k of Object.keys(params)) if (secret.has(k) && params[k]) params[k] = MASK
  const { params_enc: _p, link_enc: _l, outbound_enc: _o, ...rest } = n
  return { ...rest, traffic_paused: !!n.traffic_paused, labels: JSON.parse(n.labels), params, has_link: !!n.link_enc }
}

function cleanLabels(raw: unknown): string[] {
  return (Array.isArray(raw) ? raw : []).map(String).map((l) => l.trim().slice(0, 24)).filter(Boolean).slice(0, 10)
}

/** The params a node keeps: those of its form, with masked passwords replaced by the stored ones. */
function keptParams(variantFields: { key: string }[], incoming: Record<string, unknown>, stored: Record<string, unknown> = {}) {
  const params: Record<string, unknown> = {}
  for (const f of variantFields) {
    let v = incoming[f.key]
    if (v === MASK) v = stored[f.key]
    if (v !== undefined && v !== '') params[f.key] = v
  }
  return params
}

// ── every request the Worker sees: the tables and the key ────────────────────
app.use('*', async (c, next) => {
  await ensureSchema(c.env.DB)
  if (!c.env.TOKEN_KEY) c.env.TOKEN_KEY = await storedTokenKey(c.env.DB)
  await next()
})

// The admin API needs a session. psm-agent's endpoints use its own token, and
// signing in is open (limited per address).
const OPEN = new Set(['/api/session', '/api/login', '/api/logout'])
app.use('/api/*', async (c, next) => {
  const path = new URL(c.req.url).pathname
  if (path.startsWith('/api/agent/') || OPEN.has(path)) return next()
  if (!adminConfigured(c.env)) return c.json(fail('not_configured', 'set the ADMIN_PASSWORD secret (8+ characters)'), 503)
  if (!(await validSession(c.env, c.req.header('Cookie')))) return c.json(fail('unauthorized', 'sign in first'), 401)
  await next()
})

const isHttps = (url: string) => new URL(url).protocol === 'https:'

app.get('/api/session', async (c) =>
  c.json({ configured: adminConfigured(c.env), authenticated: await validSession(c.env, c.req.header('Cookie')), version: PANEL_VERSION }))

app.post('/api/login', async (c) => {
  if (!adminConfigured(c.env)) return c.json(fail('not_configured', 'set the ADMIN_PASSWORD secret (8+ characters)'), 503)
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown'
  if (await tooManyFailures(c.env.DB, ip)) return c.json(fail('too_many', 'too many failed sign-ins; try again in 15 minutes'), 429)
  const body = await c.req.json<{ password?: unknown }>().catch(() => null)
  if (!(await passwordMatches(c.env, typeof body?.password === 'string' ? body.password : ''))) {
    await recordFailure(c.env.DB, ip)
    await audit(c.env, 'login.failed', ip, '', 'anonymous')
    return c.json(fail('bad_password', 'wrong password'), 401)
  }
  await clearFailures(c.env.DB, ip)
  await audit(c.env, 'login', ip)
  c.header('Set-Cookie', await sessionCookie(c.env, isHttps(c.req.url)))
  return c.json({ ok: true })
})

app.post('/api/logout', (c) => {
  c.header('Set-Cookie', clearedCookie(isHttps(c.req.url)))
  return c.body(null, 204)
})

// ── servers ──────────────────────────────────────────────────────────────────
app.get('/api/servers', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT s.id, s.name, ${serverStatusSQL(c.env)} AS status, s.hostname, s.agent_version, s.psm_version, s.note,
            s.last_seen, s.created_at, s.status_at,
            (SELECT COUNT(*) FROM nodes n WHERE n.server_id = s.id) AS node_count,
            (SELECT COALESCE(SUM(n.traffic_used), 0) FROM nodes n WHERE n.server_id = s.id) AS traffic_used
       FROM servers s ORDER BY s.id`).all()
  return c.json(results)
})

// Add a server; it waits for its install command.
app.post('/api/servers', async (c) => {
  const body = await c.req.json<{ name?: string; note?: string }>().catch(() => null)
  const name = body?.name?.trim().toLowerCase() ?? ''
  if (!SERVER_NAME_RE.test(name)) return c.json(fail('bad_name', 'name: 1-32 lowercase letters, digits and -'), 400)
  let id: number
  try {
    const r = await c.env.DB.prepare('INSERT INTO servers (name, note) VALUES (?, ?)').bind(name, body?.note?.slice(0, 200) ?? '').run()
    id = Number(r.meta.last_row_id)
  } catch (e) {
    if (String(e).includes('UNIQUE')) return c.json(fail('exists', 'a server with this name exists'), 409)
    throw e
  }
  await audit(c.env, 'server.add', name)
  return c.json({ id, install_command: await installCommand(c, await newJoinToken(c.env, id)) }, 201)
})

app.post('/api/servers/:id/install-command', async (c) => {
  const s = await getServer(c.env, c.req.param('id'))
  if (!s) return c.json(fail('not_found', 'no such server'), 404)
  return c.json({ install_command: await installCommand(c, await newJoinToken(c.env, s.id)) })
})

app.delete('/api/servers/:id', async (c) => {
  const s = await getServer(c.env, c.req.param('id'))
  if (!s) return c.json(fail('not_found', 'no such server'), 404)
  await c.env.DB.prepare('DELETE FROM servers WHERE id = ?').bind(s.id).run()
  await audit(c.env, 'server.delete', s.name)
  return c.body(null, 204)
})

// Diagnostics: ask the server's agent for a status report (psm doctor, cores,
// nodes, traffic, standalone servers); it arrives with the next sync.
app.post('/api/servers/:id/status', async (c) => {
  const s = await getServer(c.env, c.req.param('id'))
  if (!s) return c.json(fail('not_found', 'no such server'), 404)
  if (!s.agent_token_hash) return c.json(fail('not_joined', 'the server has not joined yet'), 409)
  await enqueue(c.env, s.id, null, { kind: 'status' })
  await audit(c.env, 'server.diagnose', s.name)
  return c.json({ status: 'queued' }, 202)
})

app.get('/api/servers/:id/status', async (c) => {
  const s = await getServer(c.env, c.req.param('id'))
  if (!s) return c.json(fail('not_found', 'no such server'), 404)
  const pending = !!(await c.env.DB.prepare(`SELECT 1 FROM tasks WHERE server_id = ? AND kind = 'status' AND status IN ('queued', 'running') LIMIT 1`)
    .bind(s.id).first())
  const report = s.status_enc ? JSON.parse(await decrypt(c.env.TOKEN_KEY, s.status_enc)) : null
  return c.json({ at: s.status_at, pending, report })
})

// ── nodes ────────────────────────────────────────────────────────────────────
app.get('/api/nodes', async (c) => {
  const sid = new URL(c.req.url).searchParams.get('server_id')
  const stmt = sid && /^\d+$/.test(sid)
    ? c.env.DB.prepare('SELECT * FROM nodes WHERE server_id = ? ORDER BY id').bind(Number(sid))
    : c.env.DB.prepare('SELECT * FROM nodes ORDER BY id')
  const { results } = await stmt.all<NodeRow>()
  return c.json(await Promise.all(results.map((n) => publicNode(c.env, n))))
})

app.get('/api/nodes/:id', async (c) => {
  const n = await getNode(c.env, c.req.param('id'))
  return n ? c.json(await publicNode(c.env, n)) : c.json(fail('not_found', 'no such node'), 404)
})

// Create a node: checked against the protocol table and saved. On a server
// that has joined, tasks for its agent are queued; otherwise the node waits
// for the install command, which is then returned.
app.post('/api/nodes', async (c) => {
  const body = await c.req.json<NodeInput & { server_id?: number; reset_day?: number }>().catch(() => null)
  if (!body) return c.json(fail('bad_body', 'the body must be a JSON object'), 400)
  const server = await getServer(c.env, body.server_id ?? '')
  if (!server) return c.json(fail('bad_server', 'choose a server'), 400)
  const v = validateNode(body)
  if (!v.ok) return c.json(fail('invalid', v.errors.join('；'), { errors: v.errors }), 400)
  const resetDay = body.reset_day ?? 1
  if (!Number.isInteger(resetDay) || resetDay < 1 || resetDay > 28) return c.json(fail('invalid', '流量重置日：1-28', { errors: ['流量重置日：1-28'] }), 400)
  if (v.engine === 'standalone' && await c.env.DB.prepare(
    `SELECT 1 FROM nodes WHERE server_id = ? AND engine = 'standalone' AND psm_protocol = ?`).bind(server.id, v.psmProtocol).first()) {
    const msg = `${server.name} 已有一个独立安装的 ${v.psmProtocol === 'snell' ? 'Snell' : 'SS2022'}（每台服务器一个），可以改用内核运行`
    return c.json(fail('exists', msg, { errors: [msg] }), 409)
  }

  const variant = findVariant(body.protocol, body.variant)!
  const params = keptParams(activeFields(variant, v.engine, body.params ?? {}), body.params ?? {})
  const joined = !!server.agent_token_hash
  const status = joined ? 'queued' : 'waiting'

  let id: number
  try {
    const r = await c.env.DB.prepare(
      `INSERT INTO nodes (server_id, protocol, variant, engine, psm_protocol, name, address, port, public_port, traffic_limit_gb, reset_day, labels, params_enc, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(server.id, body.protocol, body.variant, v.engine, v.psmProtocol, body.name, body.address, body.port,
        body.public_port ?? null, body.traffic_limit_gb ?? 0, resetDay, JSON.stringify(cleanLabels(body.labels)),
        await encrypt(c.env.TOKEN_KEY, JSON.stringify(params)), status)
      .run()
    id = Number(r.meta.last_row_id)
  } catch (e) {
    if (String(e).includes('UNIQUE')) return c.json(fail('exists', `${server.name} already has a node named ${body.name}`), 409)
    throw e
  }
  if (status === 'queued') await queueApply(c.env, (await getNode(c.env, id))!, v.data)
  await audit(c.env, 'node.add', `${server.name}/${body.name}`, `${v.engine} ${v.psmProtocol}`)
  // a server that has not joined needs the install command; one that has gets
  // the node through its agent (to reinstall it, the servers page issues one)
  const install_command = joined ? undefined : await installCommand(c, await newJoinToken(c.env, server.id))
  return c.json({ id, status, joined, install_command }, 201)
})

// Edit a node: its address, ports, traffic limit, labels and settings (the
// protocol, how it runs, its server and its name stay). A node on its server is
// updated there by the agent; one that failed is tried again.
app.patch('/api/nodes/:id', async (c) => {
  const n = await getNode(c.env, c.req.param('id'))
  if (!n) return c.json(fail('not_found', 'no such node'), 404)
  if (n.status === 'queued' || n.status === 'deleting') return c.json(fail('busy', '节点正在下发或删除，稍后再改'), 409)
  const body = await c.req.json<Partial<NodeInput> & { reset_day?: number }>().catch(() => null)
  if (!body) return c.json(fail('bad_body', 'the body must be a JSON object'), 400)
  const stored = JSON.parse(await decrypt(c.env.TOKEN_KEY, n.params_enc)) as Record<string, unknown>
  const input: NodeInput = {
    protocol: n.protocol, variant: n.variant, engine: n.engine as NodeInput['engine'], name: n.name,
    address: body.address ?? n.address, port: body.port ?? n.port,
    public_port: body.public_port ?? n.public_port ?? undefined,
    traffic_limit_gb: body.traffic_limit_gb ?? n.traffic_limit_gb,
    labels: body.labels ?? JSON.parse(n.labels),
    params: { ...stored, ...(body.params ?? {}) },
  }
  for (const [k, val] of Object.entries(input.params!)) if (val === MASK) input.params![k] = stored[k]
  const v = validateNode(input)
  if (!v.ok) return c.json(fail('invalid', v.errors.join('；'), { errors: v.errors }), 400)
  const resetDay = body.reset_day ?? n.reset_day
  if (!Number.isInteger(resetDay) || resetDay < 1 || resetDay > 28) return c.json(fail('invalid', '流量重置日：1-28', { errors: ['流量重置日：1-28'] }), 400)
  const variant = findVariant(n.protocol, n.variant)!
  const params = keptParams(activeFields(variant, v.engine, input.params!), input.params!, stored)
  const server = (await getServer(c.env, n.server_id))!
  const joined = !!server.agent_token_hash
  const onServer = n.status === 'applied'
  const status = joined && (onServer || n.status === 'failed') ? 'queued' : n.status
  await c.env.DB.prepare(
    `UPDATE nodes SET address = ?, port = ?, public_port = ?, traffic_limit_gb = ?, reset_day = ?, labels = ?, params_enc = ?,
            status = ?, last_error = NULL WHERE id = ?`)
    .bind(input.address, input.port, input.public_port ?? null, input.traffic_limit_gb ?? 0, resetDay,
      JSON.stringify(cleanLabels(input.labels)), await encrypt(c.env.TOKEN_KEY, JSON.stringify(params)), status, n.id).run()
  const updated = (await getNode(c.env, n.id))!
  if (status === 'queued') await queueApply(c.env, updated, v.data, onServer ? 'update' : 'add')
  await audit(c.env, 'node.update', `${server.name}/${n.name}`)
  return c.json(await publicNode(c.env, updated))
})

// Delete a node: one on its server is removed by the agent first (202); one
// that never reached its server goes at once (204).
app.delete('/api/nodes/:id', async (c) => {
  const n = await getNode(c.env, c.req.param('id'))
  if (!n) return c.json(fail('not_found', 'no such node'), 404)
  const server = await getServer(c.env, n.server_id)
  if (n.status === 'applied' || n.status === 'deleting') {
    if (n.status === 'applied') {
      await enqueue(c.env, n.server_id, n.id, n.engine === 'standalone'
        ? { kind: 'standalone.remove', protocol: n.psm_protocol }
        : { kind: 'node.delete', core: n.engine, protocol: n.psm_protocol, tag: n.name })
      await c.env.DB.prepare(`UPDATE nodes SET status = 'deleting' WHERE id = ?`).bind(n.id).run()
      await audit(c.env, 'node.delete', `${server?.name}/${n.name}`)
    }
    return c.json({ status: 'deleting' }, 202)
  }
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM tasks WHERE node_id = ? AND status = 'queued'`).bind(n.id),
    c.env.DB.prepare('DELETE FROM nodes WHERE id = ?').bind(n.id),
  ])
  await audit(c.env, 'node.delete', `${server?.name}/${n.name}`)
  return c.body(null, 204)
})

// The client link (or Surge line for Snell), as the agent exported it.
app.get('/api/nodes/:id/link', async (c) => {
  const n = await getNode(c.env, c.req.param('id'))
  if (!n) return c.json(fail('not_found', 'no such node'), 404)
  if (!n.link_enc) return c.json(fail('no_link', 'the node has no link yet'), 409)
  return c.json({ format: linkFormat(n), content: await decrypt(c.env.TOKEN_KEY, n.link_enc) })
})

// ── traffic ──────────────────────────────────────────────────────────────────
// Every node's traffic this month (as its server counts it, reset on its
// reset day) and the bytes per day over the last `days` days.
app.get('/api/traffic', async (c) => {
  const days = Math.min(Math.max(Number(new URL(c.req.url).searchParams.get('days')) || 30, 1), 90)
  const { results: nodes } = await c.env.DB.prepare(
    `SELECT n.id, n.name, n.protocol, n.variant, n.engine, n.status, n.traffic_used, n.traffic_limit_gb, n.traffic_paused,
            n.traffic_at, n.reset_day, s.id AS server_id, s.name AS server
       FROM nodes n JOIN servers s ON s.id = n.server_id ORDER BY n.traffic_used DESC, n.id`).all()
  const { results: daily } = await c.env.DB.prepare(
    `SELECT day, SUM(bytes) AS bytes FROM traffic_daily WHERE day >= date('now', ?) GROUP BY day ORDER BY day`)
    .bind(`-${days - 1} days`).all()
  const { results: perNode } = await c.env.DB.prepare(
    `SELECT node_id, day, bytes FROM traffic_daily WHERE day >= date('now', ?) ORDER BY day`)
    .bind(`-${days - 1} days`).all()
  return c.json({ days, nodes: nodes.map((n) => ({ ...n, traffic_paused: !!n.traffic_paused })), daily, per_node: perNode })
})

// Ask every joined server for its counters now (they arrive within seconds).
app.post('/api/traffic/refresh', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT id FROM servers WHERE agent_token_hash IS NOT NULL').all<{ id: number }>()
  for (const s of results) await enqueue(c.env, s.id, null, { kind: 'traffic.report' })
  return c.json({ servers: results.length }, 202)
})

// Start a node's count from zero again (and lift a pause).
app.post('/api/nodes/:id/traffic/reset', async (c) => {
  const n = await getNode(c.env, c.req.param('id'))
  if (!n) return c.json(fail('not_found', 'no such node'), 404)
  if (n.status !== 'applied') return c.json(fail('not_applied', 'the node is not running on its server'), 409)
  await enqueue(c.env, n.server_id, n.id, { kind: 'traffic.reset', tag: trafficTag(n) })
  await audit(c.env, 'traffic.reset', n.name)
  return c.json({ status: 'queued' }, 202)
})

// ── subscriptions ────────────────────────────────────────────────────────────
type SubRow = { id: number; name: string; labels: string; token_hash: string; token_enc: string; last_used: string | null; created_at: string }

async function publicSub(c: C, s: SubRow) {
  const token = await decrypt(c.env.TOKEN_KEY, s.token_enc)
  const url = `${await panelUrl(c)}/sub/${token}`
  return { id: s.id, name: s.name, labels: JSON.parse(s.labels), last_used: s.last_used, created_at: s.created_at, url }
}

app.get('/api/subscriptions', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM subscriptions ORDER BY id').all<SubRow>()
  return c.json(await Promise.all(results.map((s) => publicSub(c, s))))
})

app.post('/api/subscriptions', async (c) => {
  const body = await c.req.json<{ name?: string; labels?: unknown }>().catch(() => null)
  const name = body?.name?.trim().slice(0, 48) ?? ''
  if (!name) return c.json(fail('bad_name', '订阅名称：必填'), 400)
  const token = randomToken(24)
  const r = await c.env.DB.prepare('INSERT INTO subscriptions (name, labels, token_hash, token_enc) VALUES (?, ?, ?, ?)')
    .bind(name, JSON.stringify(cleanLabels(body?.labels)), await sha256Hex(token), await encrypt(c.env.TOKEN_KEY, token)).run()
  await audit(c.env, 'subscription.add', name)
  const s = (await c.env.DB.prepare('SELECT * FROM subscriptions WHERE id = ?').bind(Number(r.meta.last_row_id)).first<SubRow>())!
  return c.json(await publicSub(c, s), 201)
})

app.patch('/api/subscriptions/:id', async (c) => {
  const s = await c.env.DB.prepare('SELECT * FROM subscriptions WHERE id = ?').bind(Number(c.req.param('id'))).first<SubRow>()
  if (!s) return c.json(fail('not_found', 'no such subscription'), 404)
  const body = await c.req.json<{ name?: string; labels?: unknown }>().catch(() => null)
  const name = body?.name?.trim().slice(0, 48) || s.name
  const labels = body?.labels !== undefined ? JSON.stringify(cleanLabels(body.labels)) : s.labels
  await c.env.DB.prepare('UPDATE subscriptions SET name = ?, labels = ? WHERE id = ?').bind(name, labels, s.id).run()
  await audit(c.env, 'subscription.update', name)
  return c.json(await publicSub(c, { ...s, name, labels }))
})

// A new URL; the old one stops working.
app.post('/api/subscriptions/:id/reset', async (c) => {
  const s = await c.env.DB.prepare('SELECT * FROM subscriptions WHERE id = ?').bind(Number(c.req.param('id'))).first<SubRow>()
  if (!s) return c.json(fail('not_found', 'no such subscription'), 404)
  const token = randomToken(24)
  const hash = await sha256Hex(token), enc = await encrypt(c.env.TOKEN_KEY, token)
  await c.env.DB.prepare('UPDATE subscriptions SET token_hash = ?, token_enc = ? WHERE id = ?').bind(hash, enc, s.id).run()
  await audit(c.env, 'subscription.reset', s.name)
  return c.json(await publicSub(c, { ...s, token_hash: hash, token_enc: enc }))
})

app.delete('/api/subscriptions/:id', async (c) => {
  const s = await c.env.DB.prepare('SELECT * FROM subscriptions WHERE id = ?').bind(Number(c.req.param('id'))).first<SubRow>()
  if (!s) return c.json(fail('not_found', 'no such subscription'), 404)
  await c.env.DB.prepare('DELETE FROM subscriptions WHERE id = ?').bind(s.id).run()
  await audit(c.env, 'subscription.delete', s.name)
  return c.body(null, 204)
})

// The subscription itself (no sign-in: the token in the URL is the key).
app.get('/sub/:token', async (c) => {
  const token = c.req.param('token')
  const s = token.length >= 24
    ? await c.env.DB.prepare('SELECT * FROM subscriptions WHERE token_hash = ?').bind(await sha256Hex(token)).first<SubRow>()
    : null
  if (!s) return c.text('not found', 404)
  const labels = JSON.parse(s.labels) as string[]
  const { results } = await c.env.DB.prepare(
    `SELECT n.name, n.labels, n.link_enc, n.outbound_enc, n.traffic_used, n.traffic_limit_gb, s.name AS server
       FROM nodes n JOIN servers s ON s.id = n.server_id
      WHERE n.status = 'applied' AND n.traffic_paused = 0 ORDER BY s.id, n.id`)
    .all<{ name: string; labels: string; link_enc: string | null; outbound_enc: string | null; traffic_used: number; traffic_limit_gb: number; server: string }>()
  const chosen = results.filter((n) => !labels.length || (JSON.parse(n.labels) as string[]).some((l) => labels.includes(l)))
  const nodes: SubNode[] = await Promise.all(chosen.map(async (n) => ({
    server: n.server, name: n.name,
    link: n.link_enc ? await decrypt(c.env.TOKEN_KEY, n.link_enc) : null,
    outbound: n.outbound_enc ? JSON.parse(await decrypt(c.env.TOKEN_KEY, n.outbound_enc)) : null,
  })))
  const url = new URL(c.req.url)
  const format = pickFormat(url.searchParams.get('format'), c.req.header('User-Agent') ?? '')
  const out = buildSubscription(format, nodes, `${await panelUrl(c)}/sub/${token}`)
  await c.env.DB.prepare(`UPDATE subscriptions SET last_used = datetime('now') WHERE id = ?`).bind(s.id).run()
  const used = chosen.reduce((a, n) => a + (n.traffic_used || 0), 0)
  const total = chosen.every((n) => n.traffic_limit_gb > 0) ? Math.round(chosen.reduce((a, n) => a + n.traffic_limit_gb * GB, 0)) : 0
  return c.body(out.body, 200, {
    'Content-Type': out.type,
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(s.name)}.${out.ext}`,
    'Profile-Update-Interval': '12',
    'Subscription-Userinfo': `upload=0; download=${used}; total=${total}`,
    'Cache-Control': 'no-store',
  })
})

// ── settings and the audit log ───────────────────────────────────────────────
app.get('/api/settings', async (c) => c.json({
  version: PANEL_VERSION,
  panel_url: (await getSetting(c.env, 'panel_url')) ?? '',
  effective_panel_url: await panelUrl(c),
  sync_interval: syncInterval(c.env),
  token_key: (await getSetting(c.env, 'token_key')) && c.env.TOKEN_KEY === (await getSetting(c.env, 'token_key')) ? 'panel' : 'secret',
}))

app.put('/api/settings', async (c) => {
  const body = await c.req.json<{ panel_url?: string }>().catch(() => null)
  const url = (body?.panel_url ?? '').trim().replace(/\/+$/, '')
  if (url && !/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(url)) {
    return c.json(fail('invalid', '面板地址：形如 https://psm.example.com', { errors: ['面板地址：形如 https://psm.example.com'] }), 400)
  }
  if (url) await c.env.DB.prepare(`INSERT INTO settings (key, value) VALUES ('panel_url', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(url).run()
  else await c.env.DB.prepare(`DELETE FROM settings WHERE key = 'panel_url'`).run()
  await audit(c.env, 'settings.update', 'panel_url', url)
  return c.json({ panel_url: url, effective_panel_url: await panelUrl(c) })
})

app.get('/api/audit', async (c) => {
  const limit = Math.min(Math.max(Number(new URL(c.req.url).searchParams.get('limit')) || 100, 1), 500)
  const { results } = await c.env.DB.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').bind(limit).all()
  return c.json(results)
})

// ── psm-agent ────────────────────────────────────────────────────────────────
// Join: a one-time join token becomes this server's agent token. Nodes that
// were waiting for the server get their tasks.
app.post('/api/agent/join', async (c) => {
  const body = await c.req.json<{ join_token?: string; hostname?: string; agent_version?: string }>().catch(() => null)
  const jt = body?.join_token ?? ''
  if (jt.length < 32) return c.json(fail('bad_token', 'invalid or expired join token'), 403)
  const row = await c.env.DB.prepare(
    `SELECT server_id FROM join_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > datetime('now')`)
    .bind(await sha256Hex(jt)).first<{ server_id: number }>()
  if (!row) return c.json(fail('bad_token', 'invalid or expired join token'), 403)
  const server = (await getServer(c.env, row.server_id))!
  const agentToken = randomToken()
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE join_tokens SET used_at = datetime('now') WHERE token_hash = ?`).bind(await sha256Hex(jt)),
    // the server has joined: any other install command handed out for it stops working
    c.env.DB.prepare(`DELETE FROM join_tokens WHERE server_id = ? AND used_at IS NULL`).bind(row.server_id),
    c.env.DB.prepare(`UPDATE servers SET agent_token_hash = ?, hostname = ?, agent_version = ?, last_seen = datetime('now') WHERE id = ?`)
      .bind(await sha256Hex(agentToken), body?.hostname?.slice(0, 64) ?? null, body?.agent_version?.slice(0, 16) ?? null, server.id),
  ])
  const { results: waiting } = await c.env.DB.prepare(
    `SELECT * FROM nodes WHERE server_id = ? AND status IN ('waiting', 'failed')`).bind(server.id).all<NodeRow>()
  for (const n of waiting) {
    await queueApply(c.env, n, await nodeData(c.env, n))
    await c.env.DB.prepare(`UPDATE nodes SET status = 'queued', last_error = NULL WHERE id = ?`).bind(n.id).run()
  }
  await enqueue(c.env, server.id, null, { kind: 'status' })
  await audit(c.env, 'server.join', server.name, body?.hostname ?? '', 'agent')
  return c.json({ agent_token: agentToken, server: { id: server.id, name: server.name }, interval: syncInterval(c.env) })
})

/** A task result on its node (and, for status reports, its server). */
async function applyResult(env: Env, server: ServerRow, t: TaskRow, r: AgentResult) {
  const error = r.ok ? null : String(r.error ?? 'failed').slice(0, 500)
  const link = r.ok && typeof r.link === 'string' && r.link ? await encrypt(env.TOKEN_KEY, r.link.slice(0, 8192)) : null
  const outbound = r.ok && r.outbound && typeof r.outbound === 'object' ? await encrypt(env.TOKEN_KEY, JSON.stringify(r.outbound).slice(0, 16384)) : null
  const db = env.DB
  switch (t.kind) {
    case 'status':
      if (r.ok && r.output) {
        const report = JSON.stringify(r.output)
        const version = (r.output as { psm_version?: unknown }).psm_version
        await db.prepare(`UPDATE servers SET status_enc = ?, status_at = datetime('now'), psm_version = COALESCE(?, psm_version) WHERE id = ?`)
          .bind(await encrypt(env.TOKEN_KEY, report.slice(0, 512 * 1024)), typeof version === 'string' ? version.slice(0, 40) : null, server.id).run()
      }
      return
    case 'node.add': case 'standalone.install':
      if (!t.node_id) return
      await db.prepare(`UPDATE nodes SET status = ?, last_error = ?, link_enc = COALESCE(?, link_enc), outbound_enc = COALESCE(?, outbound_enc) WHERE id = ?`)
        .bind(r.ok ? 'applied' : 'failed', error, link, outbound, t.node_id).run()
      return
    case 'node.update':
      if (!t.node_id) return
      // a failed update leaves the node running as before (PSM rolls back)
      await db.prepare(`UPDATE nodes SET status = 'applied', last_error = ?, link_enc = COALESCE(?, link_enc), outbound_enc = COALESCE(?, outbound_enc) WHERE id = ?`)
        .bind(error ? `修改没有生效：${error}` : null, link, outbound, t.node_id).run()
      return
    case 'node.delete': case 'standalone.remove':
      if (!t.node_id) return
      if (r.ok) await db.prepare('DELETE FROM nodes WHERE id = ?').bind(t.node_id).run()
      else await db.prepare(`UPDATE nodes SET status = 'applied', last_error = ? WHERE id = ?`).bind(error, t.node_id).run()
      return
    case 'node.export':
      if (t.node_id && (link || outbound)) {
        await db.prepare('UPDATE nodes SET link_enc = COALESCE(?, link_enc), outbound_enc = COALESCE(?, outbound_enc) WHERE id = ?')
          .bind(link, outbound, t.node_id).run()
      }
      return
    case 'traffic.set': case 'traffic.reset': {
      const o = r.output as { used_bytes?: unknown; paused?: unknown } | undefined
      if (t.node_id && r.ok && o && typeof o.used_bytes === 'number') {
        await db.prepare(`UPDATE nodes SET traffic_used = ?, traffic_paused = ?, traffic_at = datetime('now') WHERE id = ?`)
          .bind(Math.max(0, Math.floor(o.used_bytes)), o.paused === true ? 1 : 0, t.node_id).run()
      }
      return
    }
  }
}

/** The traffic counters a server sent: this month's totals, and today's increase. */
async function applyTraffic(env: Env, server: ServerRow, entries: TrafficEntry[]) {
  const { results: nodes } = await env.DB.prepare('SELECT * FROM nodes WHERE server_id = ?').bind(server.id).all<NodeRow>()
  const byTag = new Map(nodes.map((n) => [trafficTag(n), n]))
  const stmts: D1PreparedStatement[] = []
  for (const e of entries.slice(0, 500)) {
    const n = typeof e.tag === 'string' ? byTag.get(e.tag) : undefined
    if (!n || typeof e.used_bytes !== 'number' || !Number.isFinite(e.used_bytes)) continue
    const used = Math.max(0, Math.floor(e.used_bytes)), paused = e.paused === true ? 1 : 0
    if (used === n.traffic_used && paused === n.traffic_paused) continue
    // a smaller count means it was reset (monthly, or by hand): all of it is new
    const delta = used >= n.traffic_used ? used - n.traffic_used : used
    stmts.push(env.DB.prepare(`UPDATE nodes SET traffic_used = ?, traffic_paused = ?, traffic_at = datetime('now') WHERE id = ?`).bind(used, paused, n.id))
    if (delta > 0) {
      stmts.push(env.DB.prepare(`INSERT INTO traffic_daily (node_id, day, bytes) VALUES (?, date('now'), ?)
        ON CONFLICT(node_id, day) DO UPDATE SET bytes = bytes + excluded.bytes`).bind(n.id, delta))
    }
  }
  if (stmts.length) await env.DB.batch(stmts)
}

// Sync: the agent reports the results of its tasks (and its traffic
// counters) and takes new ones.
app.post('/api/agent/sync', async (c) => {
  const token = c.req.header('Authorization')?.replace(/^Bearer /, '') ?? ''
  const server = token.length >= 32
    ? await c.env.DB.prepare('SELECT * FROM servers WHERE agent_token_hash = ?').bind(await sha256Hex(token)).first<ServerRow>()
    : null
  if (!server) return c.json(fail('unauthorized', 'unknown agent token'), 401)
  type SyncBody = { hostname?: string; agent_version?: string; psm_version?: string; results?: AgentResult[]; traffic?: TrafficEntry[] }
  const body = await c.req.json<SyncBody>().catch((): SyncBody => ({}))
  await c.env.DB.prepare(`UPDATE servers SET last_seen = datetime('now'), hostname = COALESCE(?, hostname),
      agent_version = COALESCE(?, agent_version), psm_version = COALESCE(?, psm_version) WHERE id = ?`)
    .bind(body.hostname?.slice(0, 64) ?? null, body.agent_version?.slice(0, 16) ?? null,
      typeof body.psm_version === 'string' ? body.psm_version.slice(0, 40) : null, server.id).run()

  for (const r of (Array.isArray(body.results) ? body.results : []).slice(0, 100)) {
    const t = await c.env.DB.prepare(`SELECT * FROM tasks WHERE id = ? AND server_id = ? AND status = 'running'`)
      .bind(Number(r.task_id), server.id).first<TaskRow>()
    if (!t) continue
    await c.env.DB.prepare(`UPDATE tasks SET status = ?, error = ?, finished_at = datetime('now') WHERE id = ?`)
      .bind(r.ok ? 'done' : 'failed', r.ok ? null : String(r.error ?? 'failed').slice(0, 500), t.id).run()
    await applyResult(c.env, server, t, r)
  }
  if (Array.isArray(body.traffic)) await applyTraffic(c.env, server, body.traffic)

  const { results: due } = await c.env.DB.prepare(
    `SELECT * FROM tasks WHERE server_id = ? AND (status = 'queued' OR (status = 'running' AND claimed_at < datetime('now', '-${TASK_RETRY_MINUTES} minutes')))
     ORDER BY id LIMIT 20`).bind(server.id).all<TaskRow>()
  const tasks = []
  for (const t of due) {
    await c.env.DB.prepare(`UPDATE tasks SET status = 'running', claimed_at = datetime('now') WHERE id = ?`).bind(t.id).run()
    tasks.push({ id: t.id, ...JSON.parse(await decrypt(c.env.TOKEN_KEY, t.payload_enc)) })
  }
  // more queued behind these, or results just came in: come back soon
  const busy = tasks.length > 0 || (body.results?.length ?? 0) > 0 ||
    !!(await c.env.DB.prepare(`SELECT 1 FROM tasks WHERE server_id = ? AND status = 'queued' LIMIT 1`).bind(server.id).first())
  return c.json({ interval: busy ? FAST_INTERVAL : syncInterval(c.env), tasks })
})

app.all('/api/*', (c) => c.json(fail('not_found', 'no such endpoint'), 404))

export default app
