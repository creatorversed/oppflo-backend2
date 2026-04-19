/**
 * GET/POST /api/cron-enrich
 * Daily IMS feed sync (Vercel Cron). Secured with Authorization: Bearer <CRON_SECRET>.
 * Enriches Supabase `jobs` from https://www.influencermarketingsociety.com/feed.xml
 */

const crypto = require('crypto');
const fetch = require('node-fetch');
const { XMLParser } = require('fast-xml-parser');
const { createClient } = require('@supabase/supabase-js');

const FEED_URL = 'https://www.influencermarketingsociety.com/feed.xml';
const BATCH_SIZE = 50;
const SOURCE = 'IMS';

function trimToNull(value) {
  const s = value == null ? '' : String(value);
  const t = s.trim();
  return t.length ? t : null;
}

function parseDate(value) {
  const s = trimToNull(value);
  if (!s) return null;
  const dt = new Date(s);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}

function ensureArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function extractSourceIdFromUrl(link) {
  const s = trimToNull(link);
  if (!s) return null;
  try {
    const u = new URL(s);
    const m = u.pathname.match(/\/jobs\/(\d+)/i);
    if (m) return m[1];
    const q = u.searchParams.get('id') || u.searchParams.get('job_id');
    return q && /^\d+$/.test(q.trim()) ? q.trim() : null;
  } catch {
    return null;
  }
}

function mapJobNode(job) {
  const url = trimToNull(job?.url);
  const source_id = extractSourceIdFromUrl(url);
  const title = trimToNull(job?.title);
  const company = trimToNull(job?.company);
  const description = job?.description != null ? String(job.description) : '';
  const published_at = parseDate(job?.date || job?.updated);

  return {
    source_id,
    title,
    company,
    description,
    published_at,
    url,
  };
}

function dedupeFeedRows(rows) {
  const lastForId = new Map();
  for (const r of rows) {
    if (r.source_id) lastForId.set(r.source_id, r);
  }
  const emitted = new Set();
  const out = [];
  for (const r of rows) {
    if (!r.source_id) {
      out.push(r);
      continue;
    }
    if (emitted.has(r.source_id)) continue;
    emitted.add(r.source_id);
    out.push(lastForId.get(r.source_id));
  }
  return out;
}

async function fetchFeedXml() {
  const res = await fetch(FEED_URL);
  if (!res.ok) {
    throw new Error(`Feed HTTP ${res.status} ${res.statusText}`);
  }
  return res.text();
}

function parseJobsFromXml(xml) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    trimValues: true,
  });
  const doc = parser.parse(xml);
  const rawJobs = ensureArray(doc?.source?.job);
  return rawJobs.map(mapJobNode);
}

async function processBatch({ supabase, batch, summary }) {
  const withId = batch.filter((r) => r.source_id);
  const ids = withId.map((r) => r.source_id);

  const existingIds = new Set();
  if (ids.length) {
    const { data, error } = await supabase.from('jobs').select('source_id').in('source_id', ids);
    if (error) throw error;
    for (const row of data || []) {
      if (row.source_id) existingIds.add(row.source_id);
    }
  }

  for (const rec of batch) {
    try {
      if (!rec.source_id) {
        summary.skipped += 1;
        continue;
      }

      if (existingIds.has(rec.source_id)) {
        const { error: updateErr } = await supabase
          .from('jobs')
          .update({ description: rec.description, status: 'active' })
          .eq('source_id', rec.source_id);
        if (updateErr) {
          summary.errored += 1;
        } else {
          summary.updated += 1;
        }
        continue;
      }

      if (!rec.title || !rec.company) {
        summary.skipped += 1;
        continue;
      }

      const insertRow = {
        id: crypto.randomUUID(),
        source_id: rec.source_id,
        title: rec.title,
        company: rec.company,
        description: rec.description || null,
        posted_date: rec.published_at,
        source_url: rec.url,
        source: SOURCE,
        is_verified: true,
        status: 'active',
      };

      const { error: insertErr } = await supabase.from('jobs').insert(insertRow);
      if (insertErr) {
        summary.errored += 1;
      } else {
        summary.inserted += 1;
        existingIds.add(rec.source_id);
      }
    } catch {
      summary.errored += 1;
    }
  }
}

function authorizeCron(req) {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const auth = req.headers?.authorization || req.headers?.Authorization || '';
  const trimmed = auth.trim();
  if (trimmed.toLowerCase().startsWith('bearer ')) {
    return trimmed.slice(7).trim() === expected;
  }
  const h = req.headers?.['x-cron-secret'] || req.headers?.['cron-secret'];
  return h === expected;
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Content-Type', 'application/json');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  if (!authorizeCron(req)) {
    res.setHeader('Content-Type', 'application/json');
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    res.setHeader('Content-Type', 'application/json');
    res.status(500).json({ error: 'Missing SUPABASE_URL or SUPABASE_KEY' });
    return;
  }

  const summary = {
    total_parsed: 0,
    updated: 0,
    inserted: 0,
    skipped: 0,
    errored: 0,
  };

  try {
    const xml = await fetchFeedXml();
    let rows = parseJobsFromXml(xml);
    const totalFromXml = rows.length;
    rows = dedupeFeedRows(rows);
    summary.total_parsed = totalFromXml;

    const supabase = createClient(supabaseUrl, supabaseKey);

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      await processBatch({ supabase, batch, summary });
    }

    res.setHeader('Content-Type', 'application/json');
    res.status(200).json({
      ok: true,
      feed: FEED_URL,
      total_parsed: summary.total_parsed,
      updated: summary.updated,
      inserted: summary.inserted,
      skipped: summary.skipped,
      errored: summary.errored,
    });
  } catch (err) {
    res.setHeader('Content-Type', 'application/json');
    res.status(500).json({
      ok: false,
      error: err?.message || String(err),
      ...summary,
    });
  }
};
