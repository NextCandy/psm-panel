// REALITY camouflage candidates from a cyberspace-mapping engine, asked by the
// panel itself so the engine's API key never leaves it (the 2026-09-26 audit:
// it used to travel to every server that searched). The queries and the
// fields read are PSM's own (lib/xray/sni_finder.sh): hosts with a
// certificate in the server's ASN, or in its country when the ASN has none.
// The server then checks each candidate with one TLS handshake
// (`psm sni check`), which only it can do from where it is.

export const SNI_ENGINES = ['netlas', 'quake', 'zoomeye', 'fofa']

export type SniPair = { sni: string; dest: string }
type Row = { name: string; ip: string }
type Query = { engine: string; key: string; asn: number; country: string; max: number; netlasBase?: string }

const TIMEOUT_MS = 20_000
const LABELS: Record<string, string> = { netlas: 'Netlas', quake: 'Quake', zoomeye: 'ZoomEye', fofa: 'FOFA' }

class EngineError extends Error {}

async function call(engine: string, url: string, init: RequestInit = {}): Promise<unknown> {
  let r: Response
  try {
    r = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch (e) {
    throw new EngineError(`连不上 ${LABELS[engine]}：${(e as Error).message}`)
  }
  if (r.status === 401 || r.status === 403) throw new EngineError(`${LABELS[engine]} 拒绝了这个 API Key（${r.status}）`)
  if (r.status === 402 || r.status === 429) throw new EngineError(`${LABELS[engine]} 的额度用完了（${r.status}）`)
  const body = await r.json().catch(() => null)
  if (!r.ok) throw new EngineError(`${LABELS[engine]} 回答 ${r.status}`)
  return body
}

const strings = (...vs: unknown[]): string[] =>
  vs.flat(2).filter((v): v is string => typeof v === 'string' && v !== '')

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)))

type Obj = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

async function netlas(q: Query, query: string): Promise<Row[]> {
  const base = q.netlasBase || 'https://app.netlas.io'
  const body = await call('netlas', `${base}/api/responses/?q=${encodeURIComponent(query)}&start=0`,
    { headers: { 'X-API-Key': q.key } }) as Obj | null
  const rows: Row[] = []
  for (const item of (Array.isArray(body?.items) ? body!.items : []) as Obj[]) {
    const d: Obj = item?.data ?? item ?? {}
    const cert: Obj = d.certificate ?? {}
    const ip = String(d.ip ?? d.host ?? '')
    for (const name of strings(cert.subject?.common_name, cert.subject_common_name, cert.names, cert.subject_alternative_name, d.domain))
      rows.push({ name, ip })
  }
  return rows
}

async function quake(q: Query, query: string): Promise<Row[]> {
  const body = await call('quake', 'https://quake.360.net/api/v3/search/quake_service', {
    method: 'POST', headers: { 'X-QuakeToken': q.key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, start: 0, size: q.max, ignore_cache: false }),
  }) as Obj | null
  const rows: Row[] = []
  for (const d of (Array.isArray(body?.data) ? body!.data : []) as Obj[]) {
    for (const name of strings(d?.domain, d?.hostname)) rows.push({ name, ip: String(d?.ip ?? '') })
  }
  return rows
}

async function zoomeye(q: Query, query: string): Promise<Row[]> {
  const body = await call('zoomeye', 'https://api.zoomeye.ai/v2/search', {
    method: 'POST', headers: { 'API-KEY': q.key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ qbase64: b64(query), page: 1, pagesize: q.max }),
  }) as Obj | null
  if (body && body.code !== undefined && body.code !== 60000)
    throw new EngineError(`ZoomEye：${body.message ?? body.error ?? body.code}`)
  const rows: Row[] = []
  for (const d of (Array.isArray(body?.data) ? body!.data : []) as Obj[]) {
    const ip = String(d?.ip ?? d?.ipv4 ?? d?.ip_addr ?? '')
    for (const name of strings(d?.domain, d?.hostname, d?.rdns, d?.ssl?.cert?.subject?.cn, d?.ssl_cert?.subject_cn))
      rows.push({ name, ip })
  }
  return rows
}

async function fofa(q: Query, query: string): Promise<Row[]> {
  const u = new URL('https://fofa.info/api/v1/search/all')
  u.searchParams.set('key', q.key)
  u.searchParams.set('qbase64', b64(query))
  u.searchParams.set('fields', 'ip,port,domain,host,as_number')
  u.searchParams.set('size', String(q.max))
  const body = await call('fofa', u.toString()) as Obj | null
  if (body?.error === true) throw new EngineError(`FOFA：${body.errmsg ?? 'error'}`)
  // each result is [ip, port, domain, host, as_number], as the fields ask
  return ((Array.isArray(body?.results) ? body!.results : []) as unknown[][])
    .map((r) => ({ name: String(r?.[2] ?? ''), ip: String(r?.[0] ?? '') }))
}

const SEARCH: Record<string, { run: (q: Query, query: string) => Promise<Row[]>; asn: (a: number) => string; country: (c: string) => string }> = {
  netlas: { run: netlas, asn: (a) => `whois.asn.number:${a} AND port:443 AND protocol:https`, country: (c) => `geo.country:${c} AND port:443 AND protocol:https` },
  quake: { run: quake, asn: (a) => `asn:"${a}" AND service:"http/ssl"`, country: (c) => `country:"${c}" AND service:"http/ssl"` },
  zoomeye: { run: zoomeye, asn: (a) => `asn=${a} && service="https"`, country: (c) => `country="${c}" && service="https"` },
  fofa: {
    run: fofa,
    asn: (a) => `asn="${a}" && port="443" && protocol="https" && domain!=""`,
    country: (c) => `country="${c}" && port="443" && protocol="https" && domain!=""`,
  },
}

const NAME_RE = /^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z][A-Za-z0-9-]{0,62}$/
const IP_RE = /^(\d{1,3}(\.\d{1,3}){3}|[0-9a-fA-F:]{2,45})$/

/**
 * One candidate per name: "*." dropped, host names only, the engine's address
 * for it as the destination when it gave one (the host in the same ASN), the
 * name itself otherwise.
 */
function pairs(rows: Row[], max: number): SniPair[] {
  const seen = new Set<string>()
  const out: SniPair[] = []
  for (const r of rows) {
    const name = r.name.trim().replace(/^\*\./, '').toLowerCase()
    if (!NAME_RE.test(name) || name.length > 253 || seen.has(name)) continue
    seen.add(name)
    const ip = r.ip.trim()
    const dest = IP_RE.test(ip) ? (ip.includes(':') ? `[${ip}]:443` : `${ip}:443`) : `${name}:443`
    out.push({ sni: name, dest })
    if (out.length >= max) break
  }
  return out
}

/** Candidates in the ASN (or the country, when the ASN has none); `error` says why there are none. */
export async function findSniCandidates(q: Query): Promise<{ pairs: SniPair[]; error?: string }> {
  const search = SEARCH[q.engine]
  if (!search) return { pairs: [], error: `未知的网络测绘引擎：${q.engine}` }
  try {
    let found = pairs(await search.run(q, search.asn(q.asn)), q.max)
    if (!found.length && /^[A-Z]{2}$/.test(q.country)) found = pairs(await search.run(q, search.country(q.country)), q.max)
    return { pairs: found }
  } catch (e) {
    if (e instanceof EngineError) return { pairs: [], error: e.message }
    throw e
  }
}
