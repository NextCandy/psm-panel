// Admin sign-in: one password. It comes from the ADMIN_PASSWORD secret (the
// Deploy to Cloudflare form asks for it), and the first time the panel sees it
// a salted PBKDF2 record is kept in `settings`, so a deploy that loses the
// secret no longer locks everyone out. That happens: `wrangler deploy` keeps
// encrypted secrets but replaces plain variables, which the deploy config does
// not declare, so a password added as a *variable* disappears on every build.
//
// The secret stays the source of truth. When it disagrees with what is stored
// it wins and the stored record is rewritten, so changing the password in the
// Cloudflare dashboard still works — and still signs everyone out.
//
// A signed cookie keeps the session for 7 days. Failed sign-ins are limited
// per address: 10 in 15 minutes.
import type { Env } from './index'

const COOKIE = 'psm_session'
const SESSION_SECONDS = 7 * 24 * 3600
const MAX_FAILURES = 10
const FAILURE_WINDOW_MINUTES = 15
const PW_SETTING = 'admin_pw'
const PBKDF2_ROUNDS = 100_000
const enc = new TextEncoder()

/** This isolate's stored record; `null` once looked for and not found. */
let stored: string | null | undefined

function b64url(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function unb64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  return Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (ch) => ch.charCodeAt(0))
}

function derive(password: string, salt: Uint8Array, rounds: number): Promise<ArrayBuffer> {
  return crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
    .then((key) => crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: rounds }, key, 256))
}

/** pbkdf2$<rounds>$<salt>$<hash> — a plain digest would be worth guessing offline. */
async function makeRecord(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  return `pbkdf2$${PBKDF2_ROUNDS}$${b64url(salt.buffer)}$${b64url(await derive(password, salt, PBKDF2_ROUNDS))}`
}

async function recordMatches(record: string, password: string): Promise<boolean> {
  const [scheme, rounds, salt, want] = record.split('$')
  if (scheme !== 'pbkdf2' || !/^\d{1,8}$/.test(rounds ?? '') || !salt || !want) return false
  const got = b64url(await derive(password, unb64url(salt), Number(rounds)))
  const a = enc.encode(got), b = enc.encode(want)
  return a.length === b.length && crypto.subtle.timingSafeEqual(a, b)
}

/**
 * Loads the stored record and adopts the secret when there is one: the first
 * time it is seen, and again whenever it was changed. Once per isolate.
 */
export async function syncAdminPassword(env: Env): Promise<void> {
  if (stored === undefined) {
    const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(PW_SETTING).first<{ value: string }>()
    stored = row?.value ?? null
  }
  const secret = env.ADMIN_PASSWORD ?? ''
  if (secret.length < 8) return
  if (stored && (await recordMatches(stored, secret))) return
  const record = await makeRecord(secret)
  await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(PW_SETTING, record).run()
  stored = record
}

export const adminConfigured = (env: Env) => (env.ADMIN_PASSWORD ?? '').length >= 8 || !!stored

// The signature must not depend on the plain password: after a deploy that
// dropped the secret, only the stored record is left. TOKEN_KEY is stable (it
// has its own fallback in D1), and mixing the record in keeps the old promise
// that changing the password signs everyone out — a new password means a new
// record, and every cookie signed with the old one stops verifying.
function sessionKey(env: Env): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(`psm-session\0${env.TOKEN_KEY}\0${stored ?? env.ADMIN_PASSWORD ?? ''}`),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

export async function passwordMatches(env: Env, given: string): Promise<boolean> {
  const secret = env.ADMIN_PASSWORD ?? ''
  if (secret.length >= 8) {
    // compare digests, in constant time
    const [a, b] = await Promise.all([given, secret].map((s) => crypto.subtle.digest('SHA-256', enc.encode(s))))
    return crypto.subtle.timingSafeEqual(a, b)
  }
  return !!stored && recordMatches(stored, given)
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
