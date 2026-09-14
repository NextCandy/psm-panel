// psm-api tokens are stored encrypted with AES-GCM. The key is the TOKEN_KEY
// Worker secret: 32 random bytes, base64. Stored form: base64(iv || ciphertext).

async function importKey(secret: string): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(secret), (ch) => ch.charCodeAt(0))
  if (raw.length !== 32) throw new Error('TOKEN_KEY must be 32 bytes, base64-encoded')
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

export async function encrypt(secret: string, plaintext: string): Promise<string> {
  const key = await importKey(secret)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext)))
  const out = new Uint8Array(iv.length + ct.length)
  out.set(iv)
  out.set(ct, iv.length)
  return toBase64(out)
}

export async function decrypt(secret: string, stored: string): Promise<string> {
  const key = await importKey(secret)
  const data = Uint8Array.from(atob(stored), (ch) => ch.charCodeAt(0))
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.slice(0, 12) }, key, data.slice(12))
  return new TextDecoder().decode(pt)
}
