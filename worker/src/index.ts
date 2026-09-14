// PSM panel backend: servers, nodes, the one-click install command, and the
// task queue that each server's psm-agent syncs with. The panel never connects
// to a server: agents connect out to it (like Xboard's node backends), so no
// server needs a subdomain or an open port.
import { Hono } from 'hono'
import { decrypt, encrypt } from './crypto'
import { activeFields, findVariant, validateNode, type NodeInput } from '../../shared/protocols'

export type Env = {
  DB: D1Database
  ASSETS: Fetcher
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
}
type NodeRow = {
  id: number; server_id: number; protocol: string; variant: string; engine: string; psm_protocol: string
  name: string; address: string; port: number; public_port: number | null; traffic_limit_gb: number
  labels: string; params_enc: string; link_enc: string | null; status: string; last_error: string | null; created_at: string
}
type TaskRow = { id: number; server_id: number; node_id: number | null; kind: string; payload_enc: string; status: string }
type AgentResult = { task_id: number; ok: boolean; link?: string; error?: string; output?: unknown }

const app = new Hono<{ Bindings: Env }>()

const fail = (code: string, message: string, extra: Record<string, unknown> = {}) => ({ error: { code, message, ...extra } })
const SERVER_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/
const JOIN_TTL_HOURS = 24
const FAST_INTERVAL = 3        // seconds between syncs while a server has tasks under way
const TASK_RETRY_MINUTES = 5   // a task claimed but not reported for this long is handed out again

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

function installCommand(env: Env, origin: string, token: string): string {
  const install = env.INSTALL_URL ?? 'https://psm.jinqians.com'
  return `bash <(curl -fsSL ${install}) --panel ${env.PANEL_URL ?? origin} --join ${token}`
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

/** The task psm-agent runs to create a node, with the export for its link. */
function addTask(n: { engine: string; psm_protocol: string; address: string }, data: Record<string, unknown>) {
  return {
    kind: 'node.add', core: n.engine, protocol: n.psm_protocol, data,
    server: n.address, format: n.psm_protocol === 'snell' ? 'surge' : 'uri',
  }
}

async function enqueue(env: Env, serverId: number, nodeId: number | null, task: Record<string, unknown>) {
  await env.DB.prepare('INSERT INTO tasks (server_id, node_id, kind, payload_enc) VALUES (?, ?, ?, ?)')
    .bind(serverId, nodeId, task.kind as string, await encrypt(env.TOKEN_KEY, JSON.stringify(task))).run()
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
  for (const k of Object.keys(params)) if (secret.has(k) && params[k]) params[k] = '••••••'
  const { params_enc: _p, link_enc: _l, ...rest } = n
  return { ...rest, labels: JSON.parse(n.labels), params, has_link: !!n.link_enc }
}

// ── servers ──────────────────────────────────────────────────────────────────
app.get('/api/servers', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT s.id, s.name, ${serverStatusSQL(c.env)} AS status, s.hostname, s.agent_version, s.note, s.last_seen, s.created_at,
            (SELECT COUNT(*) FROM nodes n WHERE n.server_id = s.id) AS node_count
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
  return c.json({ id, install_command: installCommand(c.env, new URL(c.req.url).origin, await newJoinToken(c.env, id)) }, 201)
})

app.post('/api/servers/:id/install-command', async (c) => {
  const s = await getServer(c.env, c.req.param('id'))
  if (!s) return c.json(fail('not_found', 'no such server'), 404)
  return c.json({ install_command: installCommand(c.env, new URL(c.req.url).origin, await newJoinToken(c.env, s.id)) })
})

app.delete('/api/servers/:id', async (c) => {
  const r = await c.env.DB.prepare('DELETE FROM servers WHERE id = ?').bind(Number(c.req.param('id'))).run()
  return r.meta.changes ? c.body(null, 204) : c.json(fail('not_found', 'no such server'), 404)
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

// Create a node: checked against the protocol table and saved. On a server
// that has joined, a task for its agent is queued; otherwise the node waits
// for the install command, which is always returned.
app.post('/api/nodes', async (c) => {
  const body = await c.req.json<NodeInput & { server_id?: number }>().catch(() => null)
  if (!body) return c.json(fail('bad_body', 'the body must be a JSON object'), 400)
  const server = await getServer(c.env, body.server_id ?? '')
  if (!server) return c.json(fail('bad_server', 'choose a server'), 400)
  const v = validateNode(body)
  if (!v.ok) return c.json(fail('invalid', v.errors.join('；'), { errors: v.errors }), 400)

  const variant = findVariant(body.protocol, body.variant)!
  const params: Record<string, unknown> = {}
  for (const f of activeFields(variant, v.engine, body.params ?? {}))
    if (body.params?.[f.key] !== undefined && body.params[f.key] !== '') params[f.key] = body.params[f.key]
  const labels = (body.labels ?? []).map(String).filter((l) => l.trim()).slice(0, 10).map((l) => l.trim().slice(0, 24))
  // standalone installs arrive with M2; until then such nodes wait
  const joined = !!server.agent_token_hash
  const status = joined && v.engine !== 'standalone' ? 'queued' : 'waiting'

  let id: number
  try {
    const r = await c.env.DB.prepare(
      `INSERT INTO nodes (server_id, protocol, variant, engine, psm_protocol, name, address, port, public_port, traffic_limit_gb, labels, params_enc, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(server.id, body.protocol, body.variant, v.engine, v.psmProtocol, body.name, body.address, body.port,
        body.public_port ?? null, body.traffic_limit_gb ?? 0, JSON.stringify(labels), await encrypt(c.env.TOKEN_KEY, JSON.stringify(params)), status)
      .run()
    id = Number(r.meta.last_row_id)
  } catch (e) {
    if (String(e).includes('UNIQUE')) return c.json(fail('exists', `${server.name} already has a node named ${body.name}`), 409)
    throw e
  }
  if (status === 'queued') await enqueue(c.env, server.id, id, addTask({ engine: v.engine, psm_protocol: v.psmProtocol, address: body.address }, v.data))
  // a server that has not joined needs the install command; one that has gets
  // the node through its agent (to reinstall it, the servers page issues one)
  const install_command = joined ? undefined : installCommand(c.env, new URL(c.req.url).origin, await newJoinToken(c.env, server.id))
  return c.json({ id, status, joined, install_command }, 201)
})

// Delete a node: one on its server is removed by the agent first (202); one
// that never reached its server goes at once (204).
app.delete('/api/nodes/:id', async (c) => {
  const n = await c.env.DB.prepare('SELECT * FROM nodes WHERE id = ?').bind(Number(c.req.param('id'))).first<NodeRow>()
  if (!n) return c.json(fail('not_found', 'no such node'), 404)
  if (n.status === 'applied' || n.status === 'deleting') {
    if (n.status === 'applied') {
      await enqueue(c.env, n.server_id, n.id, { kind: 'node.delete', core: n.engine, protocol: n.psm_protocol, tag: n.name })
      await c.env.DB.prepare(`UPDATE nodes SET status = 'deleting' WHERE id = ?`).bind(n.id).run()
    }
    return c.json({ status: 'deleting' }, 202)
  }
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM tasks WHERE node_id = ? AND status = 'queued'`).bind(n.id),
    c.env.DB.prepare('DELETE FROM nodes WHERE id = ?').bind(n.id),
  ])
  return c.body(null, 204)
})

// The client link (or Surge line for Snell), as the agent exported it.
app.get('/api/nodes/:id/link', async (c) => {
  const n = await c.env.DB.prepare('SELECT * FROM nodes WHERE id = ?').bind(Number(c.req.param('id'))).first<NodeRow>()
  if (!n) return c.json(fail('not_found', 'no such node'), 404)
  if (!n.link_enc) return c.json(fail('no_link', 'the node has no link yet'), 409)
  return c.json({ format: n.psm_protocol === 'snell' ? 'surge' : 'uri', content: await decrypt(c.env.TOKEN_KEY, n.link_enc) })
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
    `SELECT * FROM nodes WHERE server_id = ? AND status IN ('waiting', 'failed') AND engine != 'standalone'`).bind(server.id).all<NodeRow>()
  for (const n of waiting) {
    await enqueue(c.env, server.id, n.id, addTask(n, await nodeData(c.env, n)))
    await c.env.DB.prepare(`UPDATE nodes SET status = 'queued', last_error = NULL WHERE id = ?`).bind(n.id).run()
  }
  return c.json({ agent_token: agentToken, server: { id: server.id, name: server.name }, interval: syncInterval(c.env) })
})

// Sync: the agent reports the results of its tasks and takes new ones.
app.post('/api/agent/sync', async (c) => {
  const token = c.req.header('Authorization')?.replace(/^Bearer /, '') ?? ''
  const server = token.length >= 32
    ? await c.env.DB.prepare('SELECT * FROM servers WHERE agent_token_hash = ?').bind(await sha256Hex(token)).first<ServerRow>()
    : null
  if (!server) return c.json(fail('unauthorized', 'unknown agent token'), 401)
  type SyncBody = { hostname?: string; agent_version?: string; results?: AgentResult[] }
  const body = await c.req.json<SyncBody>().catch((): SyncBody => ({}))
  await c.env.DB.prepare(`UPDATE servers SET last_seen = datetime('now'), hostname = COALESCE(?, hostname), agent_version = COALESCE(?, agent_version) WHERE id = ?`)
    .bind(body.hostname?.slice(0, 64) ?? null, body.agent_version?.slice(0, 16) ?? null, server.id).run()

  for (const r of (body.results ?? []).slice(0, 100)) {
    const t = await c.env.DB.prepare(`SELECT * FROM tasks WHERE id = ? AND server_id = ? AND status = 'running'`)
      .bind(Number(r.task_id), server.id).first<TaskRow>()
    if (!t) continue
    const error = r.ok ? null : String(r.error ?? 'failed').slice(0, 500)
    await c.env.DB.prepare(`UPDATE tasks SET status = ?, error = ?, finished_at = datetime('now') WHERE id = ?`)
      .bind(r.ok ? 'done' : 'failed', error, t.id).run()
    if (!t.node_id) continue
    if (t.kind === 'node.add') {
      await c.env.DB.prepare(`UPDATE nodes SET status = ?, last_error = ?, link_enc = COALESCE(?, link_enc) WHERE id = ?`)
        .bind(r.ok ? 'applied' : 'failed', error, r.ok && r.link ? await encrypt(c.env.TOKEN_KEY, r.link.slice(0, 8192)) : null, t.node_id).run()
    } else if (t.kind === 'node.delete') {
      if (r.ok) await c.env.DB.prepare('DELETE FROM nodes WHERE id = ?').bind(t.node_id).run()
      else await c.env.DB.prepare(`UPDATE nodes SET status = 'applied', last_error = ? WHERE id = ?`).bind(error, t.node_id).run()
    } else if (t.kind === 'node.export' && r.ok && r.link) {
      await c.env.DB.prepare('UPDATE nodes SET link_enc = ? WHERE id = ?').bind(await encrypt(c.env.TOKEN_KEY, r.link.slice(0, 8192)), t.node_id).run()
    }
  }

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
