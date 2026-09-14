// Subscriptions: the running nodes of every server behind one URL, in the
// format the client wants — a base64 list of share links (v2rayN, Shadowrocket,
// Hiddify …), Clash / mihomo YAML, a sing-box config, or Surge proxy lines.
// Node names become "<server>-<node>" so nodes of the same name on different
// servers stay apart.

export type SubNode = {
  server: string
  name: string
  link: string | null
  outbound: Record<string, unknown> | null
}

export type Format = 'uri' | 'clash' | 'singbox' | 'surge'
export const FORMATS: Format[] = ['uri', 'clash', 'singbox', 'surge']

/** ?format= first, then the client's User-Agent; share links by default. */
export function pickFormat(query: string | null | undefined, userAgent: string): Format {
  if (query && (FORMATS as string[]).includes(query)) return query as Format
  if (/sing-box|\bSF[AIMT]\//i.test(userAgent)) return 'singbox'
  if (/clash|mihomo|stash|verge|nyanpasu/i.test(userAgent)) return 'clash'
  if (/surge/i.test(userAgent)) return 'surge'
  return 'uri'
}

export const displayName = (n: SubNode) => `${n.server}-${n.name}`

function b64(s: string): string {
  let bin = ''
  for (const byte of new TextEncoder().encode(s)) bin += String.fromCharCode(byte)
  return btoa(bin)
}

function unb64(s: string): string {
  const std = s.replace(/-/g, '+').replace(/_/g, '/')
  const padded = std + '='.repeat((4 - (std.length % 4)) % 4)
  return new TextDecoder().decode(Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0)))
}

const isShareLink = (link: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(link)
const isSurgeLine = (link: string) => / = [a-z0-9-]+, /i.test(link) && !isShareLink(link)

/** A share link with its display name set (vmess carries it inside its JSON). */
export function renameLink(link: string, name: string): string {
  if (link.startsWith('vmess://')) {
    try {
      const j = JSON.parse(unb64(link.slice('vmess://'.length)))
      j.ps = name
      return 'vmess://' + b64(JSON.stringify(j))
    } catch {
      return link
    }
  }
  const hash = link.indexOf('#')
  return (hash < 0 ? link : link.slice(0, hash)) + '#' + encodeURIComponent(name)
}

function uriList(nodes: SubNode[]): string[] {
  return nodes.filter((n) => n.link && isShareLink(n.link)).map((n) => renameLink(n.link!, displayName(n)))
}

function clashYaml(selfUrl: string): string {
  // The proxies come from a proxy-provider on this subscription's share-link
  // format: mihomo parses share links itself, so no protocol is translated here.
  const url = `${selfUrl}${selfUrl.includes('?') ? '&' : '?'}format=uri`
  return `# PSM Panel subscription for mihomo / Clash Meta
mixed-port: 7890
allow-lan: false
mode: rule
log-level: info

proxy-providers:
  psm:
    type: http
    url: ${JSON.stringify(url)}
    interval: 3600
    path: ./psm-panel.yaml
    health-check:
      enable: true
      url: http://www.gstatic.com/generate_204
      interval: 300

proxy-groups:
  - name: PSM
    type: select
    proxies:
      - 自动选择
      - DIRECT
    use:
      - psm
  - name: 自动选择
    type: url-test
    url: http://www.gstatic.com/generate_204
    interval: 300
    use:
      - psm

rules:
  - GEOIP,PRIVATE,DIRECT,no-resolve
  - MATCH,PSM
`
}

function singboxConfig(nodes: SubNode[]): string {
  const outbounds = nodes
    .filter((n) => n.outbound)
    .map((n) => ({ ...n.outbound!, tag: displayName(n) }))
  const tags = outbounds.map((o) => o.tag as string)
  const groups: Record<string, unknown>[] = [
    { type: 'selector', tag: 'PSM', outbounds: [...(tags.length ? ['自动选择'] : []), ...tags, 'direct'], default: tags.length ? '自动选择' : 'direct' },
  ]
  if (tags.length) groups.push({ type: 'urltest', tag: '自动选择', outbounds: tags, url: 'https://www.gstatic.com/generate_204', interval: '5m' })
  return JSON.stringify({
    log: { level: 'info' },
    inbounds: [{ type: 'mixed', tag: 'mixed-in', listen: '127.0.0.1', listen_port: 7890 }],
    outbounds: [...groups, ...outbounds, { type: 'direct', tag: 'direct' }],
    route: { rules: [{ action: 'sniff' }, { ip_is_private: true, outbound: 'direct' }], final: 'PSM' },
  }, null, 2)
}

function surgeProxies(nodes: SubNode[]): string {
  const lines = nodes
    .filter((n) => n.link && isSurgeLine(n.link))
    .map((n) => `${displayName(n)} = ${n.link!.slice(n.link!.indexOf(' = ') + 3)}`)
  return `[Proxy]\n${lines.join('\n')}\n`
}

/** The subscription body and its content type. selfUrl: this subscription's URL. */
export function buildSubscription(format: Format, nodes: SubNode[], selfUrl: string): { body: string; type: string; ext: string } {
  switch (format) {
    case 'clash': return { body: clashYaml(selfUrl), type: 'text/yaml; charset=utf-8', ext: 'yaml' }
    case 'singbox': return { body: singboxConfig(nodes), type: 'application/json; charset=utf-8', ext: 'json' }
    case 'surge': return { body: surgeProxies(nodes), type: 'text/plain; charset=utf-8', ext: 'conf' }
    default: return { body: b64(uriList(nodes).join('\n')), type: 'text/plain; charset=utf-8', ext: 'txt' }
  }
}
