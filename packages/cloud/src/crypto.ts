import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const randomId = (prefix: string, bytes = 9) => `${prefix}${randomBytes(bytes).toString('base64url').replace(/[-_]/g, 'x').toLowerCase()}`;

export function hmac(secret: string | Buffer, data: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Signed, expiring token: base64url(json).sig */
export function signToken(secret: string, payload: Record<string, unknown>, ttlSec: number): string {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec })).toString('base64url');
  return `${body}.${hmac(secret, body)}`;
}

export function verifyToken<T = Record<string, unknown>>(secret: string, token: string | undefined): (T & { exp: number }) | null {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig || !safeEqual(sig, hmac(secret, body))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return p.exp > Date.now() / 1000 ? p : null;
  } catch {
    return null;
  }
}

/** API tokens are stored as scrypt hashes, never in plain text. */
export function hashToken(token: string, salt = randomBytes(16).toString('hex')) {
  return { salt, hash: scryptSync(token, salt, 32).toString('hex') };
}

export function checkToken(token: string, stored: { salt: string; hash: string }) {
  return safeEqual(hashToken(token, stored.salt).hash, stored.hash);
}

/** AES-256-GCM envelope: iv.tag.ciphertext (base64url). */
export function seal(key: Buffer, plaintext: Buffer | string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return [iv, c.getAuthTag(), ct].map((b) => b.toString('base64url')).join('.');
}

export function open(key: Buffer, sealed: string): Buffer {
  const [iv, tag, ct] = sealed.split('.').map((s) => Buffer.from(s, 'base64url'));
  const d = createDecipheriv('aes-256-gcm', key, iv!);
  d.setAuthTag(tag!);
  return Buffer.concat([d.update(ct!), d.final()]);
}
