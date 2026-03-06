/**
 * User profile and stats. Requires Authorization: Bearer <jwt>.
 * GET  /api/user - profile + computed stats
 * PATCH /api/user - update name (and preferences when column exists)
 */

const { createClient } = require('@supabase/supabase-js');
const { verifyToken } = require('../lib/auth');

function parseBody(req) {
  if (typeof req.body === 'object' && req.body !== null) return req.body;
  try {
    return typeof req.body === 'string' ? JSON.parse(req.body) : {};
  } catch {
    return {};
  }
}

function getStartOfMonthUTC() {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (!['GET', 'PATCH'].includes(req.method)) {
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
    if (req.method === 'GET') {
      const { data: profile, error: profileErr } = await supabase
        .from('users')
        .select('email, name, tier, xp_points, level, streak_days, created_at')
        .eq('id', user.id)
        .single();
      if (profileErr || !profile) {
        res.setHeader('Content-Type', 'application/json');
        res.status(404).json({ error: 'User not found' });
        return;
      }

      const monthStart = getStartOfMonthUTC();

      const [appsRes, statusRes, aiRes, companiesRes] = await Promise.all([
        supabase.from('applications').select('id', { count: 'exact', head: true }).eq('user_id', user.id),
        supabase.from('applications').select('status').eq('user_id', user.id),
        supabase.from('ai_usage').select('id', { count: 'exact', head: true }).eq('user_id', user.id).gte('created_at', monthStart),
        supabase.from('applications').select('company').eq('user_id', user.id),
      ]);

      const total_applications = appsRes.count ?? 0;
      const applications_by_status = (statusRes.data || []).reduce((acc, row) => {
        acc[row.status] = (acc[row.status] || 0) + 1;
        return acc;
      }, {});
      const ai_tools_used_this_month = aiRes.count ?? 0;

      const companyCounts = (companiesRes.data || []).reduce((acc, row) => {
        const c = (row.company || '').trim() || 'Unknown';
        acc[c] = (acc[c] || 0) + 1;
        return acc;
      }, {});
      const favorite_companies = Object.entries(companyCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([company, count]) => ({ company, count }));

      res.setHeader('Content-Type', 'application/json');
      res.status(200).json({
        ...profile,
        total_applications,
        applications_by_status,
        ai_tools_used_this_month,
        favorite_companies,
      });
      return;
    }

    if (req.method === 'PATCH') {
      const body = parseBody(req);
      const updates = {};
      if (body.name !== undefined) updates.name = (body.name || '').trim() || null;
      if (Object.keys(updates).length === 0) {
        res.setHeader('Content-Type', 'application/json');
        res.status(400).json({ error: 'No valid fields to update (e.g. name)' });
        return;
      }
      const { data: updated, error: updateErr } = await supabase
        .from('users')
        .update(updates)
        .eq('id', user.id)
        .select('email, name, tier, xp_points, level, streak_days, created_at')
        .single();
      if (updateErr) {
        res.setHeader('Content-Type', 'application/json');
        res.status(500).json({ error: 'Failed to update profile', details: updateErr.message });
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.status(200).json(updated);
    }
  } catch (err) {
    res.setHeader('Content-Type', 'application/json');
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
};
