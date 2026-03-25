const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-key');
}

function runMiddleware(req, res, fn) {
  return new Promise((resolve, reject) => {
    fn(req, res, (result) => {
      if (result instanceof Error) return reject(result);
      resolve(result);
    });
  });
}

function sanitizeFilename(input) {
  return String(input || '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function parseBoolean(value) {
  if (typeof value === 'boolean') return value;
  const v = String(value || '').trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

function parseNullableInteger(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? null : n;
}

function parseOpportunities(raw) {
  if (Array.isArray(raw)) return raw;
  const s = String(raw ?? '').trim();
  if (!s) return [];
  let parsed;
  try {
    parsed = JSON.parse(s);
  } catch {
    throw new Error('Invalid opportunities format: must be a JSON array string.');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('Invalid opportunities format: expected a JSON array.');
  }
  return parsed;
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

function requireAdmin(req) {
  const adminHeader = req.headers?.['x-admin-key'];
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return { ok: false, error: 'Server misconfiguration: ADMIN_PASSWORD not set.' };
  if (!adminHeader || adminHeader !== expected) return { ok: false, error: 'Unauthorized: invalid admin key.' };
  return { ok: true };
}

function createSupabaseClient() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error('Server misconfiguration: missing SUPABASE_URL or SUPABASE_SERVICE_KEY.');
  }
  return createClient(supabaseUrl, supabaseServiceKey);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      return cb(new Error('Invalid file type. Allowed: PDF, DOC, DOCX.'));
    }
    cb(null, true);
  },
}).single('resume');

async function handleSubmit(req, res, supabase) {
  try {
    await runMiddleware(req, res, upload);
  } catch (err) {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      res.status(400).json({ error: 'Resume file is too large. Max size is 10MB.' });
      return;
    }
    res.status(400).json({ error: err?.message || 'Invalid multipart form data.' });
    return;
  }

  if (!req.file) {
    res.status(400).json({ error: 'Missing resume file. Upload under field name "resume".' });
    return;
  }

  try {
    const body = req.body || {};
    const opportunities = parseOpportunities(body.opportunities);

    const safeLastName = sanitizeFilename(body.last_name || 'unknown');
    const safeOriginalName = sanitizeFilename(req.file.originalname || 'resume');
    const fileName = `${Date.now()}_${safeLastName}_${safeOriginalName}`;

    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('resumes')
      .upload(fileName, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false,
      });

    if (uploadError) {
      res.status(500).json({ error: 'Failed to upload resume.', details: uploadError.message });
      return;
    }

    const insertPayload = {
      first_name: body.first_name || null,
      last_name: body.last_name || null,
      current_title: body.current_title || null,
      current_company: body.current_company || null,
      phone: body.phone || null,
      email: body.email || null,
      linkedin_url: body.linkedin_url || null,
      portfolio_url: body.portfolio_url || null,
      media_kit_url: body.media_kit_url || null,
      resume_path: uploadData?.path || fileName,
      opportunities,
      career_level: body.career_level || null,
      total_followers: parseNullableInteger(body.total_followers),
      bluesky_url: body.bluesky_url || null,
      youtube_url: body.youtube_url || null,
      tiktok_url: body.tiktok_url || null,
      instagram_url: body.instagram_url || null,
      threads_url: body.threads_url || null,
      facebook_url: body.facebook_url || null,
      twitch_url: body.twitch_url || null,
      onlyfans_url: body.onlyfans_url || null,
      other_url: body.other_url || null,
      talent_solution: body.talent_solution || null,
      spotlight: body.spotlight || null,
      consent: body.consent || null,
      status: 'new',
    };

    const { error: insertError } = await supabase.from('talent_collective').insert(insertPayload);
    if (insertError) {
      res.status(500).json({ error: 'Failed to save talent profile.', details: insertError.message });
      return;
    }

    res.status(200).json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Submission failed.', details: err?.message || String(err) });
  }
}

async function handleList(_req, res, supabase) {
  const { data, error } = await supabase.from('talent_collective').select('*').order('created_at', { ascending: false });
  if (error) {
    res.status(500).json({ error: 'Failed to fetch submissions.', details: error.message });
    return;
  }
  res.status(200).json({ success: true, data: data || [] });
}

async function handleUpdateStatus(req, res, supabase) {
  let body;
  try {
    body = await parseJsonBody(req);
  } catch (e) {
    res.status(400).json({ error: e.message });
    return;
  }

  const id = body?.id;
  const status = typeof body?.status === 'string' ? body.status.trim() : '';
  if (!id || !status) {
    res.status(400).json({ error: 'Missing required fields: id and status.' });
    return;
  }

  const { error } = await supabase.from('talent_collective').update({ status }).eq('id', id);
  if (error) {
    res.status(500).json({ error: 'Failed to update status.', details: error.message });
    return;
  }
  res.status(200).json({ success: true });
}

async function handleUpdateNotes(req, res, supabase) {
  let body;
  try {
    body = await parseJsonBody(req);
  } catch (e) {
    res.status(400).json({ error: e.message });
    return;
  }

  const id = body?.id;
  const notes = body?.notes ?? null;
  if (!id) {
    res.status(400).json({ error: 'Missing required field: id.' });
    return;
  }

  const { error } = await supabase.from('talent_collective').update({ notes }).eq('id', id);
  if (error) {
    res.status(500).json({ error: 'Failed to update notes.', details: error.message });
    return;
  }
  res.status(200).json({ success: true });
}

async function handleResumeUrl(req, res, supabase) {
  let body;
  try {
    body = await parseJsonBody(req);
  } catch (e) {
    res.status(400).json({ error: e.message });
    return;
  }

  const path = typeof body?.path === 'string' ? body.path.trim() : '';
  if (!path) {
    res.status(400).json({ error: 'Missing required field: path.' });
    return;
  }

  const { data, error } = await supabase.storage.from('resumes').createSignedUrl(path, 3600);
  if (error) {
    res.status(500).json({ error: 'Failed to create signed URL.', details: error.message });
    return;
  }
  res.status(200).json({ success: true, signedUrl: data?.signedUrl || null });
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
    res.status(400).json({ error: 'Missing action query param. Use ?action=submit|list|update-status|update-notes|resume-url' });
    return;
  }

  let supabase;
  try {
    supabase = createSupabaseClient();
  } catch (e) {
    res.status(500).json({ error: e.message });
    return;
  }

  const protectedActions = new Set(['list', 'update-status', 'update-notes', 'resume-url']);
  if (protectedActions.has(action)) {
    const auth = requireAdmin(req);
    if (!auth.ok) {
      res.status(auth.error.includes('misconfiguration') ? 500 : 401).json({ error: auth.error });
      return;
    }
  }

  if (action === 'submit') {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed for submit. Use POST.' });
      return;
    }
    await handleSubmit(req, res, supabase);
    return;
  }

  if (action === 'list') {
    if (req.method !== 'GET') {
      res.status(405).json({ error: 'Method not allowed for list. Use GET.' });
      return;
    }
    await handleList(req, res, supabase);
    return;
  }

  if (action === 'update-status') {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed for update-status. Use POST.' });
      return;
    }
    await handleUpdateStatus(req, res, supabase);
    return;
  }

  if (action === 'update-notes') {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed for update-notes. Use POST.' });
      return;
    }
    await handleUpdateNotes(req, res, supabase);
    return;
  }

  if (action === 'resume-url') {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed for resume-url. Use POST.' });
      return;
    }
    await handleResumeUrl(req, res, supabase);
    return;
  }

  res.status(400).json({ error: `Unknown action: ${action}` });
};

module.exports.config = { api: { bodyParser: false } };

