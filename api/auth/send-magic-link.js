/**
 * POST /api/auth/send-magic-link
 * Accepts { email }. Creates magic link (15 min expiry) and returns token.
 * Creates user in users table if they don't exist (tier 'free').
 */

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const EXPIRY_MINUTES = 15;

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
};
