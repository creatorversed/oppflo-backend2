/**
 * POST /api/unlock
 * Body: { code }. If code === UNLOCK_CODE (constant-time compare), mint a signed
 * PRO token and return it in JSON AND set the cv_pro cookie.
 *
 * Token helpers live in lib/pro-token.js (shared with ai-tools-public.js) so the
 * signing secret logic is never duplicated.
 */

const { makeProToken, buildProCookie, constantTimeEquals } = require('../lib/pro-token');

function setCors(req, res) {
  const origin = req.headers?.origin;
  // Echo the caller's Origin so credentialed requests work; fall back to "*".
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-pro-token, x-device-id');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

async function parseJsonBody(req) {
  if (typeof req.body === 'object' && req.body !== null) return req.body;
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      throw new Error('Invalid JSON body.');
    }
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON body.');
  }
}

module.exports = async (req, res) => {
  setCors(req, res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'Method not allowed. Use POST.' });
    return;
  }

  const expected = process.env.UNLOCK_CODE;
  if (!expected) {
    res.status(500).json({ success: false, error: 'server_misconfigured' });
    return;
  }

  let body;
  try {
    body = await parseJsonBody(req);
  } catch {
    res.status(401).json({ success: false, error: 'invalid_code' });
    return;
  }

  const code = typeof body?.code === 'string' ? body.code : '';
  if (!code || !constantTimeEquals(code, expected)) {
    res.status(401).json({ success: false, error: 'invalid_code' });
    return;
  }

  let token;
  try {
    token = makeProToken();
  } catch {
    res.status(500).json({ success: false, error: 'server_misconfigured' });
    return;
  }

  res.setHeader('Set-Cookie', buildProCookie(token));
  res.status(200).json({ success: true, token });
};

module.exports.config = { api: { bodyParser: false } };
