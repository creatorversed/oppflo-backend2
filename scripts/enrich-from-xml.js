/**
 * Enrich jobs from IMS XML feed: update descriptions by source_id or insert new rows.
 *
 * Usage:
 *   node scripts/enrich-from-xml.js
 */

const fs = require('fs');
const path = require('path');
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

/** IMS job URLs look like: .../jobs/510273619-slug-here */
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

function loadEnvFromFile(envPath) {
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const idx = t.indexOf('=');
    if (idx === -1) continue;
    const key = t.slice(0, idx).trim();
    let val = t.slice(idx + 1).trim().replace(/^['"]/, '').replace(/['"]$/, '');
    if (process.env[key] == null) process.env[key] = val;
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

/** Same source_id may repeat; keep last payload, emit once in feed order. */
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
          console.error(`Update failed source_id=${rec.source_id}:`, updateErr.message || updateErr);
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
        console.error(`Insert failed source_id=${rec.source_id}:`, insertErr.message || insertErr);
      } else {
        summary.inserted += 1;
        existingIds.add(rec.source_id);
      }
    } catch (err) {
      summary.errored += 1;
      console.error(`Row error source_id=${rec.source_id || '?'}:`, err?.message || err);
    }
  }
}

async function main() {
  const ROOT_DIR = path.resolve(__dirname, '..');
  loadEnvFromFile(path.join(ROOT_DIR, '.env'));

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_KEY in .env');
  }

  const summary = {
    totalParsed: 0,
    updated: 0,
    inserted: 0,
    skipped: 0,
    errored: 0,
  };

  console.log(`Fetching ${FEED_URL} ...`);
  const xml = await fetchFeedXml();

  let rows;
  try {
    rows = parseJobsFromXml(xml);
  } catch (err) {
    console.error('XML parse failed:', err?.message || err);
    process.exit(1);
  }

  const totalFromXml = rows.length;
  rows = dedupeFeedRows(rows);
  summary.totalParsed = totalFromXml;

  const supabase = createClient(supabaseUrl, supabaseKey);

  let processedInRun = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    await processBatch({ supabase, batch, summary });
    processedInRun += batch.length;
    if (processedInRun % BATCH_SIZE === 0 || processedInRun === rows.length) {
      console.log(
        `Progress: ${processedInRun}/${rows.length} | updated=${summary.updated} inserted=${summary.inserted} skipped=${summary.skipped} errored=${summary.errored}`
      );
    }
  }

  console.log('Done.');
  console.log(
    `Summary:\n` +
      `  total parsed: ${summary.totalParsed}\n` +
      `  updated:      ${summary.updated}\n` +
      `  inserted:     ${summary.inserted}\n` +
      `  skipped:      ${summary.skipped}\n` +
      `  errored:      ${summary.errored}`
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error('enrich-from-xml failed:', err?.message || err);
    process.exit(1);
  });
}
