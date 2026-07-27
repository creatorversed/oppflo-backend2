/**
 * Signed PRO token helpers (single source of truth).
 *
 * Token format: base64url(payload) + "." + base64url(HMAC_SHA256(payload, TOKEN_SECRET))
 * where payload is JSON { tier: "pro", iat: <epoch>, exp: <epoch + 35 days> }.
 *
 * Reused by api/ai-tools-public.js (verify), api/unlock.js and
 * api/verify-subscriber.js (mint). Keep the secret/signing logic here only.
 */

const crypto = require('crypto');

const PRO_TOKEN_TTL_DAYS = 35;
const PRO_COOKIE_NAME = 'cv_pro';
// 35 days in seconds (Max-Age used on the cv_pro cookie).
const PRO_COOKIE_MAX_AGE = PRO_TOKEN_TTL_DAYS * 24 * 60 * 60;

function base64urlEncode(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64urlToBuffer(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s + pad, 'base64');
}

function getTokenSecret() {
  return process.env.TOKEN_SECRET || '';
}

function signPayload(payloadB64, secret) {
  return crypto.createHmac('sha256', secret).update(payloadB64).digest();
}

/**
 * Mint a signed PRO token valid for 35 days.
 * Throws only if TOKEN_SECRET is not configured.
 */
function makeProToken() {
  const secret = getTokenSecret();
  if (!secret) throw new Error('Server misconfiguration: TOKEN_SECRET not set.');
  const now = Math.floor(Date.now() / 1000);
  const payload = { tier: 'pro', iat: now, exp: now + PRO_TOKEN_TTL_DAYS * 24 * 60 * 60 };
  const payloadB64 = base64urlEncode(JSON.stringify(payload));
  const sigB64 = base64urlEncode(signPayload(payloadB64, secret));
  return `${payloadB64}.${sigB64}`;
}

/**
 * Verify a signed PRO token. Constant-time signature compare + exp check.
 * Never throws — returns false on any malformed / expired / invalid input.
 */
function verifyProToken(token) {
  try {
    const secret = getTokenSecret();
    if (!secret) return false;
    if (typeof token !== 'string' || !token) return false;

    const parts = token.split('.');
    if (parts.length !== 2) return false;
    const [payloadB64, sigB64] = parts;
    if (!payloadB64 || !sigB64) return false;

    const expectedSig = signPayload(payloadB64, secret);
    const providedSig = base64urlToBuffer(sigB64);
    if (providedSig.length !== expectedSig.length) return false;
    if (!crypto.timingSafeEqual(providedSig, expectedSig)) return false;

    const payload = JSON.parse(base64urlToBuffer(payloadB64).toString('utf8'));
    if (!payload || payload.tier !== 'pro') return false;

    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== 'number' || payload.exp <= now) return false;

    return true;
  } catch {
    return false;
  }
}

/**
 * Read the PRO token from the "x-pro-token" header or the "cv_pro" cookie.
 * Returns "" when neither is present. Never throws.
 */
function getProTokenFromReq(req) {
  try {
    const header = req?.headers?.['x-pro-token'];
    if (typeof header === 'string' && header.trim()) return header.trim();

    const cookieHeader = req?.headers?.cookie;
    if (typeof cookieHeader === 'string' && cookieHeader) {
      for (const part of cookieHeader.split(';')) {
        const idx = part.indexOf('=');
        if (idx === -1) continue;
        const name = part.slice(0, idx).trim();
        if (name === PRO_COOKIE_NAME) {
          const val = part.slice(idx + 1).trim();
          if (val) {
            try {
              return decodeURIComponent(val);
            } catch {
              return val;
            }
          }
        }
      }
    }
  } catch {
    /* fall through */
  }
  return '';
}

/**
 * Build the Set-Cookie value for the PRO token.
 * HttpOnly is intentionally omitted so the frontend can also read/store the
 * token. Secure + SameSite=None are kept for cross-site (iframe) use.
 */
function buildProCookie(token) {
  return `${PRO_COOKIE_NAME}=${token}; Max-Age=${PRO_COOKIE_MAX_AGE}; Path=/; Secure; SameSite=None`;
}

/** Constant-time string comparison that never throws. */
function constantTimeEquals(a, b) {
  const bufA = Buffer.from(String(a ?? ''), 'utf8');
  const bufB = Buffer.from(String(b ?? ''), 'utf8');
  if (bufA.length !== bufB.length) return false;
  try {
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

module.exports = {
  makeProToken,
  verifyProToken,
  getProTokenFromReq,
  buildProCookie,
  constantTimeEquals,
  PRO_COOKIE_NAME,
  PRO_TOKEN_TTL_DAYS,
  PRO_COOKIE_MAX_AGE,
};
