// Admin sign-in: one password, the ADMIN_PASSWORD secret (the Deploy to
// Cloudflare form asks for it). A signed cookie keeps the session for 7 days;
// changing the password signs everyone out. Failed sign-ins are limited per
// address: 10 in 15 minutes.
import type { Env } from './index'

const COOKIE = 'psm_session'
const SESSION_SECONDS = 7 * 24 * 3600
const MAX_FAILURES = 10
const FAILURE_WINDOW_MINUTES = 15
const enc = new TextEncoder()

export const adminConfigured = (env: Env) => (env.ADMIN_PASSWORD ?? '').length >= 8

function b64url(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function sessionKey(env: Env): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(`psm-session\0${env.ADMIN_PASSWORD}`),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

export async function passwordMatches(env: Env, given: string): Promise<boolean> {
  if (!adminConfigured(env)) return false
  // compare digests, in constant time
  const [a, b] = await Promise.all([given, env.ADMIN_PASSWORD!].map((s) => crypto.subtle.digest('SHA-256', enc.encode(s))))
  return crypto.subtle.timingSafeEqual(a, b)
}

const attrs = (secure: boolean) => `Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`

export async function sessionCookie(env: Env, secure: boolean): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + SESSION_SECONDS
  const sig = await crypto.subtle.sign('HMAC', await sessionKey(env), enc.encode(`v1.${exp}`))
  return `${COOKIE}=${exp}.${b64url(sig)}; Max-Age=${SESSION_SECONDS}; ${attrs(secure)}`
}

export const clearedCookie = (secure: boolean) => `${COOKIE}=; Max-Age=0; ${attrs(secure)}`

export async function validSession(env: Env, cookieHeader: string | undefined): Promise<boolean> {
  if (!adminConfigured(env) || !cookieHeader) return false
  const value = cookieHeader.split(/;\s*/).find((p) => p.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) ?? ''
  const m = /^(\d{10})\.([A-Za-z0-9_-]{43})$/.exec(value)
  if (!m || Number(m[1]) < Date.now() / 1000) return false
  const sig = Uint8Array.from(atob(m[2].replace(/-/g, '+').replace(/_/g, '/') + '='), (ch) => ch.charCodeAt(0))
  return crypto.subtle.verify('HMAC', await sessionKey(env), sig, enc.encode(`v1.${m[1]}`))
}

export async function tooManyFailures(db: D1Database, ip: string): Promise<boolean> {
  const r = await db.prepare(
    `SELECT COUNT(*) AS n FROM login_failures WHERE ip = ? AND at > datetime('now', '-${FAILURE_WINDOW_MINUTES} minutes')`)
    .bind(ip).first<{ n: number }>()
  return (r?.n ?? 0) >= MAX_FAILURES
}

export async function recordFailure(db: D1Database, ip: string) {
  await db.batch([
    db.prepare(`DELETE FROM login_failures WHERE at <= datetime('now', '-${FAILURE_WINDOW_MINUTES} minutes')`),
    db.prepare('INSERT INTO login_failures (ip) VALUES (?)').bind(ip),
  ])
}

export async function clearFailures(db: D1Database, ip: string) {
  await db.prepare('DELETE FROM login_failures WHERE ip = ?').bind(ip).run()
}
