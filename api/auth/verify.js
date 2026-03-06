/**
 * POST /api/auth/verify
 * Accepts { token }. Verifies magic link, marks used, returns JWT.
 */

const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const JWT_EXPIRY = '7d';

function parseBody(req) {
  if (typeof req.body === 'object' && req.body !== null) return req.body;
  try {
    return typeof req.body === 'string' ? JSON.parse(req.body) : {};
  } catch {
    return {};
  }
}

module.exports = async (req, res) => {
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
};
