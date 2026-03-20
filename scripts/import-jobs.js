/**
 * Import JobBoard.io CSV exports into Supabase `jobs`.
 *
 * Usage:
 *   node scripts/import-jobs.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const csvParser = require('csv-parser');
const { createClient } = require('@supabase/supabase-js');

const BATCH_SIZE = 100;
const BATCH_DELAY_MS = 2000;
const SOURCE = 'IMS';

function trimToNull(value) {
  const s = value == null ? '' : String(value);
  const t = s.trim();
  return t.length ? t : null;
}

function normalizeKeyPart(value) {
  return String(value ?? '').trim().toLowerCase();
}

function normalizeLocation(location, city, state) {
  const locFromCsv = trimToNull(location);
  if (locFromCsv) return locFromCsv;

  const c = trimToNull(city);
  const st = trimToNull(state);
  if (!c && !st) return null;
  if (c && st) return `${c}, ${st}`;
  return c || st || null;
}

function parseDate(value) {
  const s = trimToNull(value);
  if (!s) return null;

  // JobBoard.io exports look like: "2023-11-06 22:02:48 UTC"
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?\s*(UTC)?$/i);
  if (m) {
    const iso = `${m[1]}T${m[2]}${m[3] || ''}Z`;
    const dt = new Date(iso);
    return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
  }

  const dt = new Date(s);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}

function parseInteger(value) {
  const s = trimToNull(value);
  if (!s) return null;
  const cleaned = s.replace(/[^0-9-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === 'NaN') return null;
  const n = parseInt(cleaned, 10);
  return Number.isNaN(n) ? null : n;
}

function parseIntegerOr0(value) {
  const n = parseInteger(value);
  return n == null ? 0 : n;
}

function parseBooleanRemote(value) {
  const s = trimToNull(value);
  if (!s) return false;
  return s.toLowerCase() === 'full';
}

function parseMoneyNumber(value) {
  const s = trimToNull(value);
  if (!s) return null;

  // Common CSV values may be boolean strings ("true"/"false"). If so, we don't parse salary.
  const lower = s.toLowerCase();
  if (lower === 'true' || lower === 'false') return null;

  const cleaned = s.replace(/\$/g, '').replace(/,/g, '').trim();
  const n = parseFloat(cleaned);
  return Number.isNaN(n) ? null : n;
}

function parseMoneyNumbers(value) {
  const s = trimToNull(value);
  if (!s) return [];

  const lower = s.toLowerCase();
  if (lower === 'true' || lower === 'false') return [];

  const cleaned = s.replace(/\$/g, '').replace(/,/g, '');
  const matches = cleaned.match(/-?\d+(\.\d+)?/g) || [];
  return matches.map((m) => parseFloat(m)).filter((n) => !Number.isNaN(n)).slice(0, 2);
}

function normalizeTimeframeFactor(timeframeValue) {
  const t = trimToNull(timeframeValue)?.toLowerCase() || '';
  if (t.includes('hour')) return 2080;
  if (t.includes('month')) return 12;
  return 1; // yearly/annual/annually
}

function normalizeSalaryMinMax({ salary_min, salary_max, display_salary, salary_timeframe }) {
  const factor = normalizeTimeframeFactor(salary_timeframe);

  let min = parseMoneyNumber(salary_min);
  let max = parseMoneyNumber(salary_max);

  const hasMin = min != null;
  const hasMax = max != null;
  const needsFromDisplay = !hasMin || !hasMax;

  if (needsFromDisplay) {
    const nums = parseMoneyNumbers(display_salary);
    if (nums.length === 1) {
      if (min == null) min = nums[0];
      if (max == null) max = nums[0];
    } else if (nums.length >= 2) {
      if (min == null) min = nums[0];
      if (max == null) max = nums[1];
    }
  }

  // Normalize to annual values.
  min = min != null ? Math.round(min * factor) : null;
  max = max != null ? Math.round(max * factor) : null;
  return { min, max };
}

function computeStatus({ expiration_date, published_at }) {
  const expIso = parseDate(expiration_date);
  const postedIso = parseDate(published_at);

  if (expIso) {
    const expYear = new Date(expIso).getUTCFullYear();
    if (expYear >= 2030) return 'archived';
  }

  if (!postedIso) return 'expired';

  const postedMs = new Date(postedIso).getTime();
  const within60Days = Date.now() - postedMs <= 60 * 24 * 60 * 60 * 1000;
  return within60Days ? 'active' : 'expired';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadEnvFromFile(envPath) {
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, 'utf8');
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;

    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    // Remove surrounding quotes if present.
    value = value.replace(/^['"]/, '').replace(/['"]$/, '');

    // Don't override existing env vars.
    if (process.env[key] == null) process.env[key] = value;
  }
}

async function processBatch({ supabase, rows, existingSourceIds, existingSourceByDedupeKey }) {
  const toWrite = [];
  let updated = 0;
  let inserted = 0;
  let skippedDuplicates = 0;

  for (const r of rows) {
    const { __dedupeKey, ...rest } = r;
    const sourceId = rest.source_id;
    const existingSourceForDedupe = existingSourceByDedupeKey.get(__dedupeKey) || null;

    // If same title/company/location exists under a different source_id, skip to avoid idx_jobs_dedup conflicts.
    if (existingSourceForDedupe && existingSourceForDedupe !== sourceId) {
      skippedDuplicates += 1;
      continue;
    }

    if (existingSourceIds.has(sourceId)) updated += 1;
    else inserted += 1;

    toWrite.push({
      // Ensure UUID exists for potential inserts.
      id: crypto.randomUUID(),
      ...rest,
    });
  }

  if (!toWrite.length) {
    return { success: true, inserted: 0, updated: 0, skippedDuplicates, errors: 0, batchRows: rows.length };
  }

  try {
    const { error } = await supabase.from('jobs').upsert(toWrite, { onConflict: 'source_id' });
    if (error) throw error;
    return { success: true, inserted, updated, skippedDuplicates, errors: 0, batchRows: rows.length };
  } catch (err) {
    console.error('Batch upsert(source_id) failed:', err?.message || err);
    try {
      const { error: ignoreErr } = await supabase
        .from('jobs')
        .upsert(toWrite, { onConflict: 'source_id', ignoreDuplicates: true });
      if (ignoreErr) throw ignoreErr;
      return { success: true, inserted, updated, skippedDuplicates, errors: 0, batchRows: rows.length };
    } catch (fallbackErr) {
      console.error('Batch fallback upsert(ignoreDuplicates) failed:', fallbackErr?.message || fallbackErr);
      return {
        success: false,
        inserted: 0,
        updated: 0,
        skippedDuplicates: 0,
        errors: rows.length,
        batchRows: rows.length,
        error: fallbackErr,
      };
    }
  }
}

async function prefetchBatchExistingContext({ supabase, rows }) {
  const sourceIds = Array.from(new Set(rows.map((r) => r.source_id).filter(Boolean)));
  const titles = Array.from(new Set(rows.map((r) => r.title).filter(Boolean)));
  const companies = Array.from(new Set(rows.map((r) => r.company).filter(Boolean)));

  const existingSourceIds = new Set();
  const existingSourceByDedupeKey = new Map();

  if (sourceIds.length) {
    const { data: bySource, error: sourceErr } = await supabase
      .from('jobs')
      .select('source_id')
      .in('source_id', sourceIds);
    if (sourceErr) throw sourceErr;
    for (const row of bySource || []) {
      if (row.source_id) existingSourceIds.add(row.source_id);
    }
  }

  if (titles.length && companies.length) {
    const { data: byDedupe, error: dedupeErr } = await supabase
      .from('jobs')
      .select('title,company,location,source_id')
      .in('title', titles)
      .in('company', companies);
    if (dedupeErr) throw dedupeErr;
    for (const row of byDedupe || []) {
      const key = `${normalizeKeyPart(row.title)}|${normalizeKeyPart(row.company)}|${normalizeKeyPart(row.location || '')}`;
      if (!existingSourceByDedupeKey.has(key)) {
        existingSourceByDedupeKey.set(key, row.source_id || null);
      }
    }
  }

  return { existingSourceIds, existingSourceByDedupeKey };
}

function mapCsvRowToJobPayload(row) {
  const title = trimToNull(row.title);
  const company = trimToNull(row.company);
  if (!title || !company) {
    return { kind: 'skip', reason: 'missing_title_or_company' };
  }

  const id = trimToNull(row.id);
  const location = normalizeLocation(row.location, row.city, row.state);

  const postedFromCreatedAt = parseDate(row.created_at);
  const postedFromPublishedAt = parseDate(row.published_at);
  const posted_date = postedFromCreatedAt || postedFromPublishedAt || null;

  const is_remote = parseBooleanRemote(row.remote);

  const salary_timeframe = trimToNull(row.salary_timeframe);
  const salary_description = trimToNull(row.display_salary);

  const { min: salary_min, max: salary_max } = normalizeSalaryMinMax({
    salary_min: row.salary_min,
    salary_max: row.salary_max,
    display_salary: row.display_salary,
    salary_timeframe,
  });

  const status = computeStatus({
    expiration_date: row.expiration_date,
    published_at: row.published_at,
  });

  const source_url = trimToNull(row.apply_url) || trimToNull(row.url) || null;

  const payload = {
    source_id: id, // text field (not uuid primary key)
    company,
    title,
    is_remote,
    location,

    salary_min,
    salary_max,
    salary_timeframe: salary_timeframe ? salary_timeframe.toLowerCase() : null,
    salary_description,

    posted_date,
    source_url,
    expiration_date: parseDate(row.expiration_date),
    status,

    applicants_count: parseIntegerOr0(row.applicants_count),
    click_count: parseIntegerOr0(row.apply_link_click_count),
    views_count: parseIntegerOr0(row.views),

    source: SOURCE,
    is_verified: true,

    // Internal dedupe key for the batch.
    __dedupeKey: `${normalizeKeyPart(title)}|${normalizeKeyPart(company)}|${normalizeKeyPart(location || '')}`,
  };

  return { kind: 'row', payload };
}

async function importJobs() {
  const ROOT_DIR = path.resolve(__dirname, '..');
  const envPath = path.resolve(ROOT_DIR, '.env');
  loadEnvFromFile(envPath);

  const dryRun = process.argv.includes('--dry-run');
  const DRY_RUN_LIMIT = 5;

  const csvFiles = fs
    .readdirSync(ROOT_DIR)
    .filter((f) => f.toLowerCase().endsWith('.csv'))
    .map((f) => path.join(ROOT_DIR, f));

  if (!csvFiles.length) {
    console.log('No CSV files found in project root.');
    return;
  }

  const summary = {
    totalRowsRead: 0,
    processed: 0,
    inserted: 0,
    updated: 0,
    skipped: 0,
    skippedDuplicates: 0,
    errored: 0,
    statusCounts: { active: 0, archived: 0, expired: 0 },
  };

  let supabase = null;
  if (!dryRun) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_KEY;
    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Missing SUPABASE_URL or SUPABASE_KEY in .env');
    }
    supabase = createClient(supabaseUrl, supabaseKey);
  }

  // Deduplicate within batch by title+company+location.
  let batchMap = new Map();

  async function flushBatch() {
    const rows = Array.from(batchMap.values());
    if (!rows.length) return { success: true };

    summary.processed += rows.length;

    try {
      const { existingSourceIds, existingSourceByDedupeKey } = await prefetchBatchExistingContext({ supabase, rows });
      const result = await processBatch({ supabase, rows, existingSourceIds, existingSourceByDedupeKey });

      if (!result.success) {
        summary.errored += result.errors || rows.length;
        return { success: false, error: result.error };
      }

      summary.inserted += result.inserted;
      summary.updated += result.updated;
      summary.skippedDuplicates += result.skippedDuplicates || 0;
      for (const r of rows) {
        if (r.status && summary.statusCounts[r.status] != null) summary.statusCounts[r.status] += 1;
      }
      return { success: true };
    } catch (err) {
      summary.errored += rows.length;
      console.error('Batch flush failed:', err?.message || err);
      return { success: false, error: err };
    } finally {
      batchMap = new Map();
    }
  }

  if (dryRun) {
    const dryLogs = [];
    let read = 0;

    for (const filePath of csvFiles) {
      console.log(`Reading CSV (dry-run): ${path.basename(filePath)}`);
      const stream = fs
        .createReadStream(filePath)
        .pipe(
          csvParser({
            mapHeaders: ({ header }) => (header == null ? header : String(header).trim()),
            strict: false,
          })
        );

      for await (const row of stream) {
        read += 1;
        summary.totalRowsRead += 1;

        const mapped = mapCsvRowToJobPayload(row);
        if (mapped.kind === 'skip') {
          summary.skipped += 1;
          dryLogs.push({ kind: 'skip', reason: mapped.reason, raw: { title: row.title, company: row.company } });
        } else {
          dryLogs.push({ kind: 'row', payload: mapped.payload });
          // For dry-run, count status summary only for valid mapped rows.
          if (mapped.payload.status && summary.statusCounts[mapped.payload.status] != null) {
            summary.statusCounts[mapped.payload.status] += 1;
          }
        }

        if (read >= DRY_RUN_LIMIT) break;
      }
      if (read >= DRY_RUN_LIMIT) break;
    }

    console.log('Dry-run mapped data (first 5 rows):');
    console.log(JSON.stringify(dryLogs, null, 2));
    console.log(
      `Summary (dry-run): totalRowsRead=${summary.totalRowsRead}, inserted=0, updated=0, skipped=${summary.skipped}, errored=0, statusCounts=${JSON.stringify(
        summary.statusCounts
      )}`
    );
    return;
  }

  let batchFlushes = 0;

  for (const filePath of csvFiles) {
    console.log(`Reading CSV: ${path.basename(filePath)}`);
    const stream = fs
      .createReadStream(filePath)
      .pipe(
        csvParser({
          mapHeaders: ({ header }) => (header == null ? header : String(header).trim()),
          strict: false,
        })
      );

    for await (const row of stream) {
      summary.totalRowsRead += 1;

      try {
        const mapped = mapCsvRowToJobPayload(row);
        if (mapped.kind === 'skip') {
          summary.skipped += 1;
          continue;
        }

        const payload = mapped.payload;
        if (!payload.title || !payload.company) {
          summary.skipped += 1;
          continue;
        }

        // Deduplicate within the batch.
        batchMap.set(payload.__dedupeKey, payload);

        if (batchMap.size >= BATCH_SIZE) {
          batchFlushes += 1;
          const res = await flushBatch();
          if (!res.success && res.error) {
            // flushBatch already increments errored.
            console.error('Continuing after batch error.');
          }
          await sleep(BATCH_DELAY_MS);

          if (summary.totalRowsRead % 500 === 0) {
            console.log(
              `Progress: totalRowsRead=${summary.totalRowsRead} processed=${summary.processed} inserted=${summary.inserted} updated=${summary.updated} skipped=${summary.skipped} errored=${summary.errored}`
            );
          }
        }
      } catch (err) {
        summary.errored += 1;
        console.error('Row mapping error (continuing):', err?.message || err);
      }
    }
  }

  // Final partial batch (no delay needed after the last one).
  await flushBatch();

  console.log('Import complete.');
  console.log(
    `totalRowsRead=${summary.totalRowsRead}\n` +
      `processed=${summary.processed}\n` +
      `inserted=${summary.inserted}\n` +
      `updated=${summary.updated}\n` +
      `skipped=${summary.skipped}\n` +
      `skippedDuplicates=${summary.skippedDuplicates}\n` +
      `errored=${summary.errored}\n` +
      `statusCounts=${JSON.stringify(summary.statusCounts)}`
  );
}

if (require.main === module) {
  importJobs().catch((err) => {
    console.error('Import failed:', err?.message || err);
    process.exit(1);
  });
}

