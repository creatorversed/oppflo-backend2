/**
 * Handlers for POST /api/auth/verify and POST /api/auth/send-magic-link
 * (routed by api/auth/[[...slug]].js for a single Vercel serverless function).
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const JWT_EXPIRY = '7d';
const EXPIRY_MINUTES = 15;

function parseBody(req) {
  if (typeof req.body === 'object' && req.body !== null) return req.body;
  try {
    return typeof req.body === 'string' ? JSON.parse(req.body) : {};
  } catch {
    return {};
  }
}

async function handleVerify(req, res) {
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.setHeader('Content-Type', 'application/json');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const body = parseBody(req);
  const token = (body.token || '').trim();
  if (!token) {
    res.setHeader('Content-Type', 'application/json');
    res.status(400).json({ error: 'token is required' });
    return;
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;
  const jwtSecret = process.env.JWT_SECRET;
  if (!supabaseUrl || !supabaseKey) {
    res.setHeader('Content-Type', 'application/json');
    res.status(500).json({ error: 'Server misconfiguration: missing Supabase env' });
    return;
  }
  if (!jwtSecret) {
    res.setHeader('Content-Type', 'application/json');
    res.status(500).json({ error: 'Server misconfiguration: JWT_SECRET not set' });
    return;
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const now = new Date().toISOString();
    const { data: link, error: linkError } = await supabase
      .from('magic_links')
      .select('id, email, used, expires_at')
      .eq('token', token)
      .maybeSingle();

    if (linkError || !link) {
      res.setHeader('Content-Type', 'application/json');
      res.status(401).json({ error: 'Invalid or expired magic link' });
      return;
    }
    if (link.used) {
      res.setHeader('Content-Type', 'application/json');
      res.status(401).json({ error: 'Magic link has already been used' });
      return;
    }
    if (new Date(link.expires_at) < new Date()) {
      res.setHeader('Content-Type', 'application/json');
      res.status(401).json({ error: 'Magic link has expired' });
      return;
    }

    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id, email, tier')
      .eq('email', link.email)
      .single();

    if (userError || !user) {
      res.setHeader('Content-Type', 'application/json');
      res.status(401).json({ error: 'User not found' });
      return;
    }

    await supabase.from('magic_links').update({ used: true }).eq('id', link.id);

    const payload = { id: user.id, email: user.email, tier: user.tier || 'free' };
    const jwtToken = jwt.sign(payload, jwtSecret, { expiresIn: JWT_EXPIRY });

    res.setHeader('Content-Type', 'application/json');
    res.status(200).json({ token: jwtToken, user: payload });
  } catch (err) {
    res.setHeader('Content-Type', 'application/json');
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
}

async function handleSendMagicLink(req, res) {
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.setHeader('Content-Type', 'application/json');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const body = parseBody(req);
  const email = (body.email || '').trim().toLowerCase();
  if (!email) {
    res.setHeader('Content-Type', 'application/json');
    res.status(400).json({ error: 'email is required' });
    return;
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    res.setHeader('Content-Type', 'application/json');
    res.status(500).json({ error: 'Server misconfiguration: missing Supabase env' });
    return;
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    let { data: user, error: userError } = await supabase
      .from('users')
      .select('id, email, tier')
      .eq('email', email)
      .maybeSingle();

    if (userError) {
      res.setHeader('Content-Type', 'application/json');
      res.status(500).json({ error: 'Failed to look up user', details: userError.message });
      return;
    }

    if (!user) {
      const { data: newUser, error: insertError } = await supabase
        .from('users')
        .insert({ email, tier: 'free' })
        .select('id, email, tier')
        .single();
      if (insertError) {
        res.setHeader('Content-Type', 'application/json');
        res.status(500).json({ error: 'Failed to create user', details: insertError.message });
        return;
      }
      user = newUser;
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + EXPIRY_MINUTES * 60 * 1000).toISOString();

    const { error: linkError } = await supabase.from('magic_links').insert({
      email,
      token,
      expires_at: expiresAt,
      used: false,
    });

    if (linkError) {
      res.setHeader('Content-Type', 'application/json');
      res.status(500).json({ error: 'Failed to create magic link', details: linkError.message });
      return;
    }

    res.setHeader('Content-Type', 'application/json');
    res.status(200).json({
      token,
      expiresAt,
      expiresIn: EXPIRY_MINUTES * 60,
    });
  } catch (err) {
    res.setHeader('Content-Type', 'application/json');
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
}

module.exports = {
  handleVerify,
  handleSendMagicLink,
};
