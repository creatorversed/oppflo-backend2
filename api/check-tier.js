/**
 * GET /api/check-tier?email=...
 * Fallback: check subscriber's tier via Beehiiv API and return OppFlo tier (free/pro/mogul).
 * Uses BEEHIIV_API_KEY and BEEHIIV_PUBLICATION_ID.
 */

const { mapBeehiivToTier } = require('../lib/beehiiv');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'GET') {
    res.setHeader('Content-Type', 'application/json');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const email = (req.query.email || '').trim().toLowerCase();
  if (!email) {
    res.setHeader('Content-Type', 'application/json');
    res.status(400).json({ error: 'email query parameter is required' });
    return;
  }

  const apiKey = process.env.BEEHIIV_API_KEY;
  const publicationId = process.env.BEEHIIV_PUBLICATION_ID;
  if (!apiKey || !publicationId) {
    res.setHeader('Content-Type', 'application/json');
    res.status(500).json({ error: 'Server misconfiguration: BEEHIIV_API_KEY or BEEHIIV_PUBLICATION_ID not set' });
    return;
  }

  const encodedEmail = encodeURIComponent(email);
  const url = `https://api.beehiiv.com/v2/publications/${publicationId}/subscriptions/by_email/${encodedEmail}`;

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    const body = await response.json().catch(() => ({}));

    if (response.status === 404) {
      res.setHeader('Content-Type', 'application/json');
      res.status(404).json({ error: 'Subscriber not found', email });
      return;
    }

    if (!response.ok) {
      res.setHeader('Content-Type', 'application/json');
      res.status(response.status).json({
        error: 'Beehiiv API error',
        status: response.status,
        details: body?.errors?.[0]?.message || body?.message || response.statusText,
      });
      return;
    }

    const data = body.data || body;
    const subscription_tier = data.subscription_tier || 'free';
    const subscription_premium_tier_names = data.subscription_premium_tier_names || [];
    const tier = mapBeehiivToTier(subscription_tier, subscription_premium_tier_names);

    res.setHeader('Content-Type', 'application/json');
    res.status(200).json({
      email,
      tier,
      subscription_tier,
      subscription_premium_tier_names,
    });
  } catch (err) {
    res.setHeader('Content-Type', 'application/json');
    res.status(500).json({
      error: 'Failed to check tier',
      details: err.message,
    });
  }
};
