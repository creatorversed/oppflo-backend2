/**
 * GET /api/benchmark
 * Salary benchmark data from Supabase (no AI, no usage credits).
 *
 * Query: ?title=<keyword>&location=<optional>
 * Auth: Authorization: Bearer <PUBLIC_TOOLS_KEY> (same as /api/ai-tools-public)
 */

const { createClient } = require('@supabase/supabase-js');

const CACHE_MAX_AGE = 3600;

function validateApiKey(req) {
  const authHeader = req.headers?.authorization || req.headers?.Authorization;
  if (!authHeader || typeof authHeader !== 'string') return false;
  const parts = authHeader.trim().split(/\s+/);
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') return false;
  const key = process.env.PUBLIC_TOOLS_KEY;
  if (!key) return false;
  return parts[1] === key;
}

function mean(nums) {
  const a = nums.filter((n) => n != null && Number.isFinite(Number(n)));
  if (!a.length) return null;
  const sum = a.reduce((s, n) => s + Number(n), 0);
  return Math.round(sum / a.length);
}

function medianSorted(sorted) {
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return Math.round(sorted[mid]);
  return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** p in [0, 100], arr sorted ascending */
function percentileSorted(sorted, p) {
  if (!sorted.length) return null;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return Math.round(sorted[lo]);
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo));
}

function buildStats(rows) {
  const mins = rows.map((r) => r.salary_min).filter((n) => n != null && Number.isFinite(Number(n))).map(Number);
  const maxs = rows.map((r) => r.salary_max).filter((n) => n != null && Number.isFinite(Number(n))).map(Number);

  const minsSorted = [...mins].sort((a, b) => a - b);
  const maxsSorted = [...maxs].sort((a, b) => a - b);

  const uniqueTitles = [...new Set(rows.map((r) => (r.title || '').trim()).filter(Boolean))];

  return {
    count: rows.length,
    avg_min: mean(mins),
    avg_max: mean(maxs),
    median_min: medianSorted(minsSorted),
    median_max: medianSorted(maxsSorted),
    low_end: percentileSorted(minsSorted, 10),
    high_end: percentileSorted(maxsSorted, 90),
    sample_titles: uniqueTitles,
    results: rows,
  };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', `public, max-age=${CACHE_MAX_AGE}`);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'GET') {
    res.setHeader('Content-Type', 'application/json');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  if (!validateApiKey(req)) {
    res.setHeader('Content-Type', 'application/json');
    res.status(401).json({ error: 'Missing or invalid API key. Use Authorization: Bearer <PUBLIC_TOOLS_KEY>.' });
    return;
  }

  const titleParam = typeof req.query?.title === 'string' ? req.query.title.trim() : '';
  if (!titleParam) {
    res.setHeader('Content-Type', 'application/json');
    res.status(400).json({ error: 'Missing required query parameter: title' });
    return;
  }

  const locationParam =
    typeof req.query?.location === 'string' && req.query.location.trim() ? req.query.location.trim() : '';

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    res.setHeader('Content-Type', 'application/json');
    res.status(500).json({ error: 'Server misconfiguration: missing Supabase env' });
    return;
  }

  try {
    const supabase = createClient(supabaseUrl, supabaseKey);
    let q = supabase
      .from('jobs')
      .select('title,salary_min,salary_max,location,company')
      .not('salary_min', 'is', null)
      .ilike('title', `%${titleParam}%`);

    if (locationParam) {
      q = q.ilike('location', `%${locationParam}%`);
    }

    const { data: rows, error } = await q.order('salary_min', { ascending: false }).limit(50);

    if (error) {
      res.setHeader('Content-Type', 'application/json');
      res.status(500).json({ error: 'Database query failed', details: error.message });
      return;
    }

    const list = Array.isArray(rows) ? rows : [];

    res.setHeader('Content-Type', 'application/json');
    if (list.length === 0) {
      res.status(200).json({ count: 0, message: 'No matching roles found' });
      return;
    }

    res.status(200).json(buildStats(list));
  } catch (err) {
    res.setHeader('Content-Type', 'application/json');
    res.status(500).json({ error: 'Benchmark request failed', details: err?.message || String(err) });
  }
};
