/**
 * POST /api/verify-subscriber
 * Body: { email }. If the (lowercased/trimmed) email exists in the
 * paid_subscribers table, mint a PRO token and return it (+ set cv_pro cookie).
 * Otherwise return a generic { success: false, error: "not_subscribed" }.
 *
 * Dormant until the subscriber list is uploaded — safe to deploy now.
 * Token helpers live in lib/pro-token.js (shared, no duplicated secret logic).
 */

const { createClient } = require('@supabase/supabase-js');
const { makeProToken, buildProCookie } = require('../lib/pro-token');

function setCors(req, res) {
  const origin = req.headers?.origin;
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-pro-token, x-device-id');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

function getServiceClient() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  return url && serviceKey ? createClient(url, serviceKey) : null;
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

  let body;
  try {
    body = await parseJsonBody(req);
  } catch {
    res.status(400).json({ success: false, error: 'invalid_email' });
    return;
  }

  const email = String(body?.email || '').trim().toLowerCase();
  if (!email) {
    res.status(400).json({ success: false, error: 'invalid_email' });
    return;
  }

  const db = getServiceClient();
  if (!db) {
    res.status(500).json({ success: false, error: 'server_misconfigured' });
    return;
  }

  let subscriber = null;
  try {
    const { data } = await db
      .from('paid_subscribers')
      .select('email')
      .eq('email', email)
      .maybeSingle();
    subscriber = data || null;
  } catch {
    subscriber = null;
  }

  if (!subscriber) {
    // Keep the message generic — do not reveal whether the email exists.
    res.status(200).json({ success: false, error: 'not_subscribed' });
    return;
  }

  // TODO(email-verification): For stronger proof-of-ownership, replace this
  // direct token issue with a magic-link flow — email the subscriber a signed,
  // single-use link that, when clicked, mints the PRO token. Direct issue on
  // match is acceptable for launch.
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
