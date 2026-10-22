import { createHmac, createHash, timingSafeEqual, randomBytes } from 'node:crypto';

// Minimal HS256 JWT + PKCE helpers using node:crypto only (ported from the
// adsrelay reference). Pure functions so they are easy to test in isolation.

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function b64urlJson(obj) {
  return b64url(JSON.stringify(obj));
}

/** Sign an HS256 JWT. `ttlSec` sets `exp` relative to now. */
export function signJwt(claims, secret, ttlSec) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64urlJson({ alg: 'HS256', typ: 'JWT' });
  const body = b64urlJson({ iat: now, exp: now + ttlSec, ...claims });
  const data = `${head}.${body}`;
  const sig = b64url(createHmac('sha256', secret).update(data).digest());
  return `${data}.${sig}`;
}

/** Verify an HS256 JWT. Returns the payload or throws (malformed, bad signature, expired). */
export function verifyJwt(token, secret) {
  if (typeof token !== 'string') throw new Error('jwt: not a string');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('jwt: malformed');
  const [head, body, sig] = parts;
  const expected = b64url(createHmac('sha256', secret).update(`${head}.${body}`).digest());
  if (!constantTimeEq(sig, expected)) throw new Error('jwt: bad signature');
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw new Error('jwt: bad payload');
  }
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || now >= payload.exp) throw new Error('jwt: expired');
  return payload;
}

/** base64url(SHA-256(input)) — PKCE S256. */
export function sha256base64url(input) {
  return b64url(createHash('sha256').update(input).digest());
}

/** Cryptographically random URL-safe token. */
export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Constant-time string comparison. Both sides are hashed first so the
 * comparison doesn't leak the secret's length either.
 */
export function constantTimeEq(a, b) {
  const ah = createHash('sha256').update(String(a ?? '')).digest();
  const bh = createHash('sha256').update(String(b ?? '')).digest();
  return timingSafeEqual(ah, bh);
}
