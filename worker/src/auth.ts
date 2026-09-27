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
// A signed cookie keeps the session for 7 days. It carries the session epoch
// (a number in `settings`): signing out raises it, which ends every session
// signed before — on every device, since a cookie cannot be taken back from a
// browser that still has it. Failed sign-ins are limited per address (an
// IPv6 address per /64, what one machine usually has): 10 in 15 minutes.
import type { Env } from './index'

const COOKIE = 'psm_session'
const SESSION_SECONDS = 7 * 24 * 3600
const MAX_FAILURES = 10
const FAILURE_WINDOW_MINUTES = 15
const PW_SETTING = 'admin_pw'
const EPOCH_SETTING = 'session_epoch'
// Workers' WebCrypto refuses PBKDF2 above 100,000 iterations (the audit's
// 210,000 cannot run here); the record keeps its own count, so a later
// runtime can raise it and old records still verify.
const PBKDF2_ROUNDS = 100_000
// how long an isolate trusts the epoch it read: a sign-out elsewhere reaches
// it within this, and at once in the isolate that handled it
const EPOCH_TTL_MS = 15_000
const enc = new TextEncoder()

/** This isolate's stored record; `null` once looked for and not found. */
let stored: string | null | undefined
/** The secret already checked against `stored`, so the check runs once. */
let checkedSecret: string | undefined

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
  const secret = env.ADMIN_PASSWORD ?? ''
  // Checking the secret against the record is a PBKDF2 pass: a hundred
  // milliseconds and more. This runs from the middleware every request takes,
  // so it has to happen once per isolate — not once per click.
  if (stored !== undefined && (secret.length < 8 || secret === checkedSecret)) return
  if (stored === undefined) {
    const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(PW_SETTING).first<{ value: string }>()
    stored = row?.value ?? null
  }
  if (secret.length < 8) return
  if (stored && (await recordMatches(stored, secret))) {
    checkedSecret = secret
    return
  }
  const record = await makeRecord(secret)
  await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(PW_SETTING, record).run()
  stored = record
  checkedSecret = secret
}

export const adminConfigured = (env: Env) => (env.ADMIN_PASSWORD ?? '').length >= 8 || !!stored

/** ADMIN_PASSWORD is set but too short to be used (the page says so rather than "not set"). */
export const passwordIgnored = (env: Env) => {
  const n = (env.ADMIN_PASSWORD ?? '').length
  return n > 0 && n < 8
}

// The signature must not depend on the plain password: after a deploy that
// dropped the secret, only the stored record is left. TOKEN_KEY is stable (it
// has its own fallback in D1), and the record as the salt keeps the old
// promise that changing the password signs everyone out — a new password
// means a new record, and every cookie signed with the old one stops
// verifying. HKDF gives the session its own key: TOKEN_KEY itself only ever
// encrypts (AES-GCM), and nothing signs with it directly.
let keyCache: { tokenKey: string; record: string; key: CryptoKey } | null = null
async function sessionKey(env: Env): Promise<CryptoKey> {
  const record = stored ?? env.ADMIN_PASSWORD ?? ''
  if (keyCache && keyCache.tokenKey === env.TOKEN_KEY && keyCache.record === record) return keyCache.key
  const ikm = await crypto.subtle.importKey('raw', unb64(env.TOKEN_KEY), 'HKDF', false, ['deriveKey'])
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(record), info: enc.encode('psm-panel session v2') },
    ikm, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign', 'verify'])
  keyCache = { tokenKey: env.TOKEN_KEY, record, key }
  return key
}

/** TOKEN_KEY's bytes (standard base64, as crypto.ts reads it). */
const unb64 = (s: string) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0))

let epochCache: { value: number; at: number } | null = null
async function currentEpoch(db: D1Database, fresh = false): Promise<number> {
  if (!fresh && epochCache && Date.now() - epochCache.at < EPOCH_TTL_MS) return epochCache.value
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(EPOCH_SETTING).first<{ value: string }>()
  epochCache = { value: Number.parseInt(row?.value ?? '0', 10) || 0, at: Date.now() }
  return epochCache.value
}

/** Ends every session signed so far (sign-out, on every device). */
export async function revokeSessions(db: D1Database): Promise<void> {
  await db.prepare(`INSERT INTO settings (key, value) VALUES (?, '1')
    ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`).bind(EPOCH_SETTING).run()
  await currentEpoch(db, true)
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

// <expiry>.<epoch>.<signature of both>
export async function sessionCookie(env: Env, secure: boolean): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + SESSION_SECONDS
  const epoch = await currentEpoch(env.DB, true)
  const sig = await crypto.subtle.sign('HMAC', await sessionKey(env), enc.encode(`v2.${exp}.${epoch}`))
  return `${COOKIE}=${exp}.${epoch}.${b64url(sig)}; Max-Age=${SESSION_SECONDS}; ${attrs(secure)}`
}

export const clearedCookie = (secure: boolean) => `${COOKIE}=; Max-Age=0; ${attrs(secure)}`

export async function validSession(env: Env, cookieHeader: string | undefined): Promise<boolean> {
  if (!adminConfigured(env) || !cookieHeader) return false
  const value = cookieHeader.split(/;\s*/).find((p) => p.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) ?? ''
  const m = /^(\d{10})\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(value)
  if (!m || Number(m[1]) < Date.now() / 1000) return false
  const sig = unb64url(m[3])
  if (!(await crypto.subtle.verify('HMAC', await sessionKey(env), sig, enc.encode(`v2.${m[1]}.${m[2]}`)))) return false
  // a cookie newer than this isolate's epoch means the epoch moved on since it was read
  const cookieEpoch = Number(m[2])
  let epoch = await currentEpoch(env.DB)
  if (cookieEpoch > epoch) epoch = await currentEpoch(env.DB, true)
  return cookieEpoch === epoch
}

/** The address failed sign-ins are counted by: an IPv6 address by its /64. */
export function ipKey(ip: string): string {
  if (!ip.includes(':')) return ip
  // expand "::" to get the first four groups
  const [head, tail = ''] = ip.toLowerCase().split('::')
  const h = head ? head.split(':') : []
  const t = tail ? tail.split(':') : []
  const groups = ip.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`
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
