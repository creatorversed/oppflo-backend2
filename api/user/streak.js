/**
 * GET /api/user/streak
 * Check if user applied today; update streak. Requires Authorization: Bearer <jwt>.
 * Streak = consecutive calendar days (UTC) with at least one application, ending today or yesterday.
 * If they missed yesterday, streak resets to 0. If they applied today, streak includes today.
 * Returns current streak and whether they need to apply today to maintain it.
 */

const { createClient } = require('@supabase/supabase-js');
const { verifyToken } = require('../../lib/auth');

const MS_PER_DAY = 86400000;

function toDateKey(iso) {
  return iso.slice(0, 10);
}

/** Compute consecutive days with applications ending at endDate (UTC date string YYYY-MM-DD) */
function computeStreak(dateKeysSet, endDateKey) {
  if (!dateKeysSet.has(endDateKey)) return 0;
  const sorted = [...dateKeysSet].sort();
  const endIdx = sorted.indexOf(endDateKey);
  if (endIdx === -1) return 0;
  let count = 1;
  for (let i = endIdx - 1; i >= 0; i--) {
    const prev = sorted[i];
    const expected = new Date(sorted[i + 1]);
    expected.setUTCDate(expected.getUTCDate() - 1);
    const expectedKey = toDateKey(expected.toISOString());
    if (prev !== expectedKey) break;
    count++;
  }
  return count;
}

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

  let user;
  try {
    user = verifyToken(req);
  } catch (e) {
    res.setHeader('Content-Type', 'application/json');
    res.status(e.statusCode || 401).json({ error: e.message });
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
    const now = new Date();
    const todayKey = toDateKey(now.toISOString());
    const yesterday = new Date(now.getTime() - MS_PER_DAY);
    const yesterdayKey = toDateKey(yesterday.toISOString());

    const { data: applications, error: appErr } = await supabase
      .from('applications')
      .select('applied_date')
      .eq('user_id', user.id);
    if (appErr) {
      res.setHeader('Content-Type', 'application/json');
      res.status(500).json({ error: 'Failed to fetch applications', details: appErr.message });
      return;
    }

    const dateKeys = new Set();
    (applications || []).forEach((row) => {
      if (row.applied_date) dateKeys.add(toDateKey(new Date(row.applied_date).toISOString()));
    });

    const has_applied_today = dateKeys.has(todayKey);
    const has_applied_yesterday = dateKeys.has(yesterdayKey);

    let newStreak = 0;
    if (has_applied_today) {
      newStreak = computeStreak(dateKeys, todayKey);
    } else if (has_applied_yesterday) {
      newStreak = computeStreak(dateKeys, yesterdayKey);
    }

    await supabase.from('users').update({ streak_days: newStreak }).eq('id', user.id);

    res.setHeader('Content-Type', 'application/json');
    res.status(200).json({
      streak_days: newStreak,
      need_to_apply_today: !has_applied_today,
      applied_today: has_applied_today,
    });
  } catch (err) {
    res.setHeader('Content-Type', 'application/json');
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
};
