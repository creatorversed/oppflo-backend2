/**
 * POST /api/webhooks/beehiiv
 * Webhook endpoint for Beehiiv subscription events (upgrade, tier change).
 * Updates user tier in users table. Map: free → 'free', $29 tier → 'pro', $129 tier → 'mogul'.
 */

const { createClient } = require('@supabase/supabase-js');
const { mapBeehiivToTier } = require('../../lib/beehiiv');

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

  const payload = parseBody(req);
  const eventType = payload.event_type || payload.type;
  const data = payload.data || payload;
  const email = (data.email || '').trim().toLowerCase();

  if (!email) {
    console.warn('[beehiiv webhook] Missing email in payload', { eventType, payloadKeys: Object.keys(payload) });
    res.setHeader('Content-Type', 'application/json');
    res.status(400).json({ error: 'Missing subscriber email' });
    return;
  }

  const subscription_tier = data.subscription_tier || 'free';
  const subscription_premium_tier_names = data.subscription_premium_tier_names || [];
  const oppfloTier = mapBeehiivToTier(subscription_tier, subscription_premium_tier_names);

  console.log('[beehiiv webhook]', {
    event_type: eventType,
    uid: payload.uid,
    event_timestamp: payload.event_timestamp,
    email,
    subscription_tier,
    subscription_premium_tier_names,
    mapped_tier: oppfloTier,
  });

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    console.error('[beehiiv webhook] Missing Supabase env');
    res.setHeader('Content-Type', 'application/json');
    res.status(500).json({ error: 'Server misconfiguration' });
    return;
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  const { data: user, error: fetchErr } = await supabase
    .from('users')
    .select('id, tier')
    .eq('email', email)
    .maybeSingle();

  if (fetchErr) {
    console.error('[beehiiv webhook] Supabase fetch error', fetchErr);
    res.setHeader('Content-Type', 'application/json');
    res.status(500).json({ error: 'Failed to look up user', details: fetchErr.message });
    return;
  }

  if (!user) {
    console.log('[beehiiv webhook] No user found for email', email);
    res.setHeader('Content-Type', 'application/json');
    res.status(200).json({ received: true, updated: false, reason: 'user_not_found' });
    return;
  }

  if (user.tier === oppfloTier) {
    console.log('[beehiiv webhook] Tier unchanged', { email, tier: oppfloTier });
    res.setHeader('Content-Type', 'application/json');
    res.status(200).json({ received: true, updated: false, tier: oppfloTier });
    return;
  }

  const { error: updateErr } = await supabase
    .from('users')
    .update({ tier: oppfloTier })
    .eq('id', user.id);

  if (updateErr) {
    console.error('[beehiiv webhook] Supabase update error', updateErr);
    res.setHeader('Content-Type', 'application/json');
    res.status(500).json({ error: 'Failed to update tier', details: updateErr.message });
    return;
  }

  console.log('[beehiiv webhook] Tier updated', { email, previous: user.tier, tier: oppfloTier });
  res.setHeader('Content-Type', 'application/json');
  res.status(200).json({ received: true, updated: true, tier: oppfloTier });
};
