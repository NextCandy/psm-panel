// PSM panel backend: keeps the list of servers and forwards requests to each
// server's psm-api, which is reachable only through Cloudflare Tunnel behind
// Cloudflare Access (the Access service token is a Worker secret).
import { Hono } from 'hono'
import { decrypt, encrypt } from './crypto'

export type Env = {
  DB: D1Database
  ASSETS: Fetcher
  TOKEN_KEY: string
  ACCESS_CLIENT_ID?: string
  ACCESS_CLIENT_SECRET?: string
  // local development only: accept http:// API addresses
  ALLOW_HTTP_API?: string
}

type ServerRow = { id: number; name: string; api_url: string; api_token_enc: string; note: string; created_at: string }

const app = new Hono<{ Bindings: Env }>()

const fail = (code: string, message: string) => ({ error: { code, message } })

app.onError((err, c) => {
  console.error(err)
  return c.json(fail('internal', 'internal error'), 500)
})

app.get('/api/servers', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT id, name, api_url, note, created_at FROM servers ORDER BY id').all()
  return c.json(results)
})

app.post('/api/servers', async (c) => {
  const body = await c.req.json<{ name?: string; api_url?: string; api_token?: string; note?: string }>().catch(() => null)
  const name = body?.name?.trim() ?? ''
  const apiUrl = body?.api_url?.trim().replace(/\/+$/, '') ?? ''
  const token = body?.api_token?.trim() ?? ''
  if (!/^[\p{L}\p{N} ._-]{1,64}$/u.test(name)) return c.json(fail('bad_name', 'name: 1-64 letters, digits, spaces, . _ -'), 400)
  let url: URL
  try {
    url = new URL(apiUrl)
  } catch {
    return c.json(fail('bad_url', 'api_url is not a URL'), 400)
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && c.env.ALLOW_HTTP_API === '1'))
    return c.json(fail('bad_url', 'api_url must be https://'), 400)
  if (token.length < 32) return c.json(fail('bad_token', 'api_token is too short'), 400)

  const enc = await encrypt(c.env.TOKEN_KEY, token)
  try {
    const r = await c.env.DB.prepare('INSERT INTO servers (name, api_url, api_token_enc, note) VALUES (?, ?, ?, ?)')
      .bind(name, apiUrl, enc, body?.note?.slice(0, 200) ?? '')
      .run()
    return c.json({ id: r.meta.last_row_id }, 201)
  } catch (e) {
    if (String(e).includes('UNIQUE')) return c.json(fail('exists', 'a server with this name exists'), 409)
    throw e
  }
})

app.delete('/api/servers/:id', async (c) => {
  const r = await c.env.DB.prepare('DELETE FROM servers WHERE id = ?').bind(Number(c.req.param('id'))).run()
  return r.meta.changes ? c.body(null, 204) : c.json(fail('not_found', 'no such server'), 404)
})

async function getServer(env: Env, id: string): Promise<ServerRow | null> {
  if (!/^\d+$/.test(id)) return null
  return env.DB.prepare('SELECT * FROM servers WHERE id = ?').bind(Number(id)).first<ServerRow>()
}

// Calls a server's psm-api with its bearer token and, when configured, the
// Access service token; the response (JSON) is passed through unchanged.
async function callApi(env: Env, server: ServerRow, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${await decrypt(env.TOKEN_KEY, server.api_token_enc)}`)
  if (env.ACCESS_CLIENT_ID && env.ACCESS_CLIENT_SECRET) {
    headers.set('CF-Access-Client-Id', env.ACCESS_CLIENT_ID)
    headers.set('CF-Access-Client-Secret', env.ACCESS_CLIENT_SECRET)
  }
  let r: Response
  try {
    r = await fetch(server.api_url + path, { ...init, headers, redirect: 'manual', signal: AbortSignal.timeout(130_000) })
  } catch (e) {
    return Response.json(fail('unreachable', `${server.name}: ${String(e)}`), { status: 502 })
  }
  // Access answers an unauthenticated request with a redirect to its login page
  if (r.status >= 300 && r.status < 400)
    return Response.json(fail('access_denied', `${server.name}: Cloudflare Access refused the request`), { status: 502 })
  return new Response(r.body, { status: r.status, headers: { 'content-type': r.headers.get('content-type') ?? 'application/json' } })
}

app.get('/api/servers/:id/health', async (c) => {
  const s = await getServer(c.env, c.req.param('id'))
  return s ? callApi(c.env, s, '/v1/health') : c.json(fail('not_found', 'no such server'), 404)
})

app.get('/api/servers/:id/nodes', async (c) => {
  const s = await getServer(c.env, c.req.param('id'))
  if (!s) return c.json(fail('not_found', 'no such server'), 404)
  const q = new URL(c.req.url).searchParams
  const pass = new URLSearchParams()
  for (const k of ['core', 'protocol']) if (q.get(k)) pass.set(k, q.get(k)!)
  return callApi(c.env, s, '/v1/nodes' + (pass.size ? `?${pass}` : ''))
})

app.all('/api/*', (c) => c.json(fail('not_found', 'no such endpoint'), 404))

export default app
