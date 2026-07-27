/**
 * Signed tier-token helpers (single source of truth).
 *
 * Token format: base64url(payload) + "." + base64url(HMAC_SHA256(payload, TOKEN_SECRET))
 * where payload is JSON { tier: <"pro"|"free-plus">, iat: <epoch>, exp: <epoch + 35 days> }.
 *
 * Reused by api/ai-tools-public.js — verify on tool calls, and mint on the
 * ?action=unlock / ?action=verify / ?action=register-email query-routed
 * actions. Keep the secret/signing logic here only.
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
 * Mint a signed token for the given tier, valid for 35 days.
 * Throws only if TOKEN_SECRET is not configured.
 */
function makeSignedToken(tier) {
  const secret = getTokenSecret();
  if (!secret) throw new Error('Server misconfiguration: TOKEN_SECRET not set.');
  const now = Math.floor(Date.now() / 1000);
  const payload = { tier, iat: now, exp: now + PRO_TOKEN_TTL_DAYS * 24 * 60 * 60 };
  const payloadB64 = base64urlEncode(JSON.stringify(payload));
  const sigB64 = base64urlEncode(signPayload(payloadB64, secret));
  return `${payloadB64}.${sigB64}`;
}

/** Mint a signed PRO token (tier "pro", unlimited use). */
function makeProToken() {
  return makeSignedToken('pro');
}

/** Mint a signed free-plus token (tier "free-plus", 7/day). */
function makeFreeToken() {
  return makeSignedToken('free-plus');
}

/**
 * Verify a signed token. Constant-time signature compare + exp check.
 * Never throws. Returns { valid, tier } where tier is the payload's tier
 * string when valid (e.g. "pro" or "free-plus"), otherwise null.
 */
function verifyToken(token) {
  try {
    const secret = getTokenSecret();
    if (!secret) return { valid: false, tier: null };
    if (typeof token !== 'string' || !token) return { valid: false, tier: null };

    const parts = token.split('.');
    if (parts.length !== 2) return { valid: false, tier: null };
    const [payloadB64, sigB64] = parts;
    if (!payloadB64 || !sigB64) return { valid: false, tier: null };

    const expectedSig = signPayload(payloadB64, secret);
    const providedSig = base64urlToBuffer(sigB64);
    if (providedSig.length !== expectedSig.length) return { valid: false, tier: null };
    if (!crypto.timingSafeEqual(providedSig, expectedSig)) return { valid: false, tier: null };

    const payload = JSON.parse(base64urlToBuffer(payloadB64).toString('utf8'));
    if (!payload || typeof payload.tier !== 'string' || !payload.tier) {
      return { valid: false, tier: null };
    }

    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== 'number' || payload.exp <= now) return { valid: false, tier: null };

    return { valid: true, tier: payload.tier };
  } catch {
    return { valid: false, tier: null };
  }
}

/**
 * Verify a signed PRO token specifically. Never throws — returns true only for
 * a valid, unexpired token whose tier is "pro". Kept for existing callers.
 */
function verifyProToken(token) {
  const result = verifyToken(token);
  return result.valid && result.tier === 'pro';
}

/**
 * Read a token from the given header, falling back to the "cv_pro" cookie.
 * Returns "" when neither is present. Never throws.
 */
function readTokenFromReq(req, headerName) {
  try {
    const header = req?.headers?.[headerName];
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

/** Read the PRO token from the "x-pro-token" header or the "cv_pro" cookie. */
function getProTokenFromReq(req) {
  return readTokenFromReq(req, 'x-pro-token');
}

/** Read the free-plus token from the "x-free-token" header or "cv_pro" cookie. */
function getFreeTokenFromReq(req) {
  return readTokenFromReq(req, 'x-free-token');
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
  makeFreeToken,
  verifyToken,
  verifyProToken,
  getProTokenFromReq,
  getFreeTokenFromReq,
  buildProCookie,
  constantTimeEquals,
  PRO_COOKIE_NAME,
  PRO_TOKEN_TTL_DAYS,
  PRO_COOKIE_MAX_AGE,
};
