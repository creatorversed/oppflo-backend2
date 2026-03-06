/**
 * Map Beehiiv subscription_tier + premium tier names to OppFlo tier.
 * Configure Beehiiv tier names to match: e.g. $29 tier named "Pro", $129 named "Mogul".
 * Fallback: names containing "mogul" or "129" → mogul; "pro" or "29" → pro; else free/premium → free/pro.
 */

function mapBeehiivToTier(subscription_tier, subscription_premium_tier_names = []) {
  const names = (subscription_premium_tier_names || []).map((n) => (n || '').toLowerCase());
  if (subscription_tier === 'free' && names.length === 0) return 'free';
  if (names.some((n) => n.includes('mogul') || n.includes('129'))) return 'mogul';
  if (names.some((n) => n.includes('pro') || n.includes('29'))) return 'pro';
  if (subscription_tier === 'premium' || names.length > 0) return 'pro';
  return 'free';
}

module.exports = { mapBeehiivToTier };
