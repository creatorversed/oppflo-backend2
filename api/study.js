const { createClient } = require('@supabase/supabase-js');

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-key');
}

async function parseJsonBody(req) {
  if (typeof req.body === 'object' && req.body !== null) return req.body;
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      throw new Error('Invalid JSON body.');
    }
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON body.');
  }
}

function getAction(req) {
  const val = req.query?.action;
  if (Array.isArray(val)) return (val[0] || '').toLowerCase().trim();
  return String(val || '').toLowerCase().trim();
}

function createSupabaseClient() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error('Server misconfiguration: missing SUPABASE_URL or SUPABASE_SERVICE_KEY.');
  }
  return createClient(supabaseUrl, supabaseServiceKey);
}

async function handleSubmit(req, res, supabase) {
  let body;
  try {
    body = await parseJsonBody(req);
  } catch (e) {
    res.status(400).json({ error: e.message });
    return;
  }

  try {
    const insertPayload = {
      first_name: body.first_name || null,
      last_name: body.last_name || null,
      tiktok_handle: body.tiktok_handle || null,
      payout_email: body.payout_email || null,
      posts_political: body.posts_political || null,
      post_frequency: body.post_frequency || null,
      monetized: body.monetized || null,
      source: body.source || null,
    };

    const { error: insertError } = await supabase.from('creator_study').insert(insertPayload);
    if (insertError) {
      res.status(500).json({ error: 'Failed to save creator study response.', details: insertError.message });
      return;
    }

    res.status(200).json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Submission failed.', details: err?.message || String(err) });
  }
}

module.exports = async (req, res) => {
  setCors(res);
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  const action = getAction(req);
  if (!action) {
    res.status(400).json({ error: 'Missing action query param. Use ?action=submit' });
    return;
  }

  let supabase;
  try {
    supabase = createSupabaseClient();
  } catch (e) {
    res.status(500).json({ error: e.message });
    return;
  }

  if (action === 'submit') {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed for submit. Use POST.' });
      return;
    }
    await handleSubmit(req, res, supabase);
    return;
  }

  res.status(400).json({ error: `Unknown action: ${action}` });
};

module.exports.config = { api: { bodyParser: false } };
