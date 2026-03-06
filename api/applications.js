/**
 * CRUD for job applications. All routes require Authorization: Bearer <jwt>.
 * GET    /api/applications - list my applications (optional ?status=)
 * POST   /api/applications - create application, award 10 XP, level up if needed
 * PATCH  /api/applications - update application; if status -> 'offer', award 50 XP + confetti
 * DELETE /api/applications - delete my application by id
 */

const { createClient } = require('@supabase/supabase-js');
const { verifyToken } = require('../lib/auth');

const XP_PER_APPLICATION = 10;
const XP_OFFER_BONUS = 50;
const XP_PER_LEVEL = 100;

function parseBody(req) {
  if (typeof req.body === 'object' && req.body !== null) return req.body;
  try {
    return typeof req.body === 'string' ? JSON.parse(req.body) : {};
  } catch {
    return {};
  }
}

function computeLevel(xp) {
  return Math.floor(xp / XP_PER_LEVEL) + 1;
}

async function addXpAndLevelUp(supabase, userId, xpToAdd) {
  const { data: user, error: fetchErr } = await supabase
    .from('users')
    .select('xp_points, level')
    .eq('id', userId)
    .single();
  if (fetchErr || !user) return null;
  const newXp = (user.xp_points ?? 0) + xpToAdd;
  const newLevel = computeLevel(newXp);
  const { error: updateErr } = await supabase
    .from('users')
    .update({ xp_points: newXp, level: newLevel })
    .eq('id', userId);
  if (updateErr) return null;
  return { xp_points: newXp, level: newLevel };
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  const allowed = ['GET', 'POST', 'PATCH', 'DELETE'];
  if (!allowed.includes(req.method)) {
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
      let q = supabase
        .from('applications')
        .select('*')
        .eq('user_id', user.id)
        .order('applied_date', { ascending: false });
      const status = (req.query.status || '').trim();
      if (status) q = q.eq('status', status);
      const { data: applications, error } = await q;
      if (error) {
        res.setHeader('Content-Type', 'application/json');
        res.status(500).json({ error: 'Failed to fetch applications', details: error.message });
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.status(200).json({ applications: applications || [] });
      return;
    }

    if (req.method === 'POST') {
      const body = parseBody(req);
      const job_title = (body.job_title || '').trim();
      const company = (body.company || '').trim();
      const source_platform = (body.source_platform || '').trim();
      if (!job_title || !company) {
        res.setHeader('Content-Type', 'application/json');
        res.status(400).json({ error: 'job_title and company are required' });
        return;
      }
      const payload = {
        user_id: user.id,
        job_title,
        company,
        source_platform: source_platform || null,
        job_id: body.job_id || null,
        notes: (body.notes || '').trim() || null,
        status: 'applied',
      };
      const { data: application, error: insertErr } = await supabase
        .from('applications')
        .insert(payload)
        .select()
        .single();
      if (insertErr) {
        res.setHeader('Content-Type', 'application/json');
        res.status(500).json({ error: 'Failed to create application', details: insertErr.message });
        return;
      }
      const leveled = await addXpAndLevelUp(supabase, user.id, XP_PER_APPLICATION);
      res.setHeader('Content-Type', 'application/json');
      res.status(201).json({
        application,
        xp_awarded: XP_PER_APPLICATION,
        ...(leveled && { xp_points: leveled.xp_points, level: leveled.level }),
      });
      return;
    }

    if (req.method === 'PATCH') {
      const body = parseBody(req);
      const id = (body.id || '').trim();
      if (!id) {
        res.setHeader('Content-Type', 'application/json');
        res.status(400).json({ error: 'id is required' });
        return;
      }
      const { data: existing, error: fetchErr } = await supabase
        .from('applications')
        .select('id, status')
        .eq('id', id)
        .eq('user_id', user.id)
        .single();
      if (fetchErr || !existing) {
        res.setHeader('Content-Type', 'application/json');
        res.status(404).json({ error: 'Application not found' });
        return;
      }
      const updates = {};
      if (body.status !== undefined) updates.status = body.status.trim();
      if (body.notes !== undefined) updates.notes = (body.notes || '').trim() || null;
      if (Object.keys(updates).length === 0) {
        res.setHeader('Content-Type', 'application/json');
        res.status(400).json({ error: 'Provide at least status or notes to update' });
        return;
      }
      const { data: application, error: updateErr } = await supabase
        .from('applications')
        .update(updates)
        .eq('id', id)
        .eq('user_id', user.id)
        .select()
        .single();
      if (updateErr) {
        res.setHeader('Content-Type', 'application/json');
        res.status(500).json({ error: 'Failed to update application', details: updateErr.message });
        return;
      }
      let confetti = false;
      let leveled = null;
      if (updates.status === 'offer' && existing.status !== 'offer') {
        leveled = await addXpAndLevelUp(supabase, user.id, XP_OFFER_BONUS);
        confetti = true;
      }
      res.setHeader('Content-Type', 'application/json');
      res.status(200).json({
        application,
        ...(confetti && {
          confetti: true,
          xp_awarded: XP_OFFER_BONUS,
          ...(leveled && { xp_points: leveled.xp_points, level: leveled.level }),
        }),
      });
      return;
    }

    if (req.method === 'DELETE') {
      const id = (req.query.id || parseBody(req).id || '').trim();
      if (!id) {
        res.setHeader('Content-Type', 'application/json');
        res.status(400).json({ error: 'id is required' });
        return;
      }
      const { data: deleted, error } = await supabase
        .from('applications')
        .delete()
        .eq('id', id)
        .eq('user_id', user.id)
        .select('id');
      if (error) {
        res.setHeader('Content-Type', 'application/json');
        res.status(500).json({ error: 'Failed to delete application', details: error.message });
        return;
      }
      if (!deleted || deleted.length === 0) {
        res.setHeader('Content-Type', 'application/json');
        res.status(404).json({ error: 'Application not found' });
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.status(200).json({ success: true, deleted: id });
    }
  } catch (err) {
    res.setHeader('Content-Type', 'application/json');
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
};
