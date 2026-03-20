/**
 * Enrich jobs from IMS XML feed, one job at a time.
 *
 * Usage:
 *   node scripts/enrich-xml.js
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const Parser = require('rss-parser');
const { createClient } = require('@supabase/supabase-js');

const FEED_URL = 'https://www.influencermarketingsociety.com/feed.xml';
const ITEM_DELAY_MS = 100;

function trimToNull(value) {
  const s = value == null ? '' : String(value).trim();
  return s.length ? s : null;
}

function isBlank(value) {
  return value == null || (typeof value === 'string' && value.trim().length === 0);
}

function parseDate(value) {
  const s = trimToNull(value);
  if (!s) return null;
  const dt = new Date(s);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}

function parseNumberToInt(value) {
  const s = trimToNull(value);
  if (!s) return null;
  const n = Number(String(s).replace(/[^0-9.-]/g, ''));
  if (Number.isNaN(n)) return null;
  return Math.round(n);
}

function parseBoolean(value) {
  const s = trimToNull(value);
  if (!s) return false;
  const v = s.toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'remote' || v === 'full';
}

function normalizeSalaryTimeframe(value) {
  const s = trimToNull(value);
  if (!s) return null;
  const v = s.toLowerCase();
  if (v.includes('annual') || v.includes('year')) return 'yearly';
  if (v.includes('hour')) return 'hourly';
  if (v.includes('month')) return 'monthly';
  if (v.includes('week')) return 'weekly';
  if (v.includes('day')) return 'daily';
  return v;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    const val = t.slice(idx + 1).trim().replace(/^['"]/, '').replace(/['"]$/, '');
    if (process.env[key] == null) process.env[key] = val;
  }
}

function fetchRawContent(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (
          redirectsLeft > 0 &&
          [301, 302, 303, 307, 308].includes(res.statusCode) &&
          res.headers.location
        ) {
          const nextUrl = res.headers.location.startsWith('http')
            ? res.headers.location
            : new URL(res.headers.location, url).toString();
          res.resume();
          fetchRawContent(nextUrl, redirectsLeft - 1).then(resolve).catch(reject);
          return;
        }
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          resolve({ statusCode: res.statusCode, contentType: res.headers['content-type'] || '', body: data });
        });
      })
      .on('error', reject);
  });
}

function decodeXmlEntities(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function stripXmlTags(text) {
  const withCdata = String(text || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  return decodeXmlEntities(withCdata.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function extractAllTagValues(block) {
  const fields = {};
  const inner = String(block || '')
    .replace(/^<([a-zA-Z0-9:_-]+)\b[^>]*>/, '')
    .replace(/<\/([a-zA-Z0-9:_-]+)>\s*$/, '');
  const re = /<([a-zA-Z0-9:_-]+)\b[^>]*>([\s\S]*?)<\/\1>/g;

  let match = re.exec(inner);
  while (match) {
    const tag = match[1];
    const value = stripXmlTags(match[2]);
    if (trimToNull(value)) {
      if (fields[tag] == null) fields[tag] = value;
      else if (Array.isArray(fields[tag])) fields[tag].push(value);
      else fields[tag] = [fields[tag], value];
    }
    match = re.exec(inner);
  }
  return fields;
}

function getTagValue(block, tagName) {
  const escaped = tagName.replace(':', '\\:');
  const re = new RegExp(`<${escaped}[^>]*>([\\s\\S]*?)<\\/${escaped}>`, 'i');
  const m = block.match(re);
  if (!m) return null;
  return stripXmlTags(m[1]);
}

function getLinkFromBlock(block) {
  const linkTag = getTagValue(block, 'link');
  if (trimToNull(linkTag)) return trimToNull(linkTag);
  const atomLink = block.match(/<link[^>]*href=["']([^"']+)["'][^>]*>/i);
  if (atomLink && atomLink[1]) return trimToNull(atomLink[1]);
  return null;
}

function parseRawXmlFallback(rawXml) {
  const blocks = [];
  for (const pattern of [/<item\b[\s\S]*?<\/item>/gi, /<entry\b[\s\S]*?<\/entry>/gi, /<job\b[\s\S]*?<\/job>/gi]) {
    const matches = rawXml.match(pattern);
    if (matches?.length) blocks.push(...matches);
  }

  return blocks.map((block) => {
    const fields = extractAllTagValues(block);
    return {
      title: getTagValue(block, 'title') || fields.title || null,
      company: getTagValue(block, 'company') || fields.company || null,
      referencenumber: getTagValue(block, 'referencenumber') || fields.referencenumber || null,
      expiration_date: getTagValue(block, 'expiration_date') || fields.expiration_date || null,
      description:
        getTagValue(block, 'description') ||
        getTagValue(block, 'body') ||
        getTagValue(block, 'content') ||
        getTagValue(block, 'summary') ||
        fields.description ||
        fields.body ||
        fields.content ||
        fields.summary ||
        null,
      compensation_min: getTagValue(block, 'compensation_min') || fields.compensation_min || null,
      compensation_max: getTagValue(block, 'compensation_max') || fields.compensation_max || null,
      compensation_interval: getTagValue(block, 'compensation_interval') || fields.compensation_interval || null,
      remote: getTagValue(block, 'remote') || fields.remote || null,
      location: getTagValue(block, 'location') || fields.location || null,
      city: getTagValue(block, 'city') || fields.city || null,
      state: getTagValue(block, 'state') || fields.state || null,
      logo: getTagValue(block, 'logo') || fields.logo || null,
      url: getTagValue(block, 'url') || fields.url || getLinkFromBlock(block) || null,
      link: getLinkFromBlock(block),
      date: getTagValue(block, 'date') || fields.date || null,
      jobtype: getTagValue(block, 'jobtype') || fields.jobtype || null,
      _rawFields: fields,
    };
  });
}

async function parseFeedItems(rawXml) {
  const parser = new Parser();
  try {
    const feed = await parser.parseString(rawXml);
    return { items: Array.isArray(feed.items) ? feed.items : [], strategy: 'rss-parser' };
  } catch {
    return { items: parseRawXmlFallback(rawXml), strategy: 'raw-xml-fallback' };
  }
}

function mapFeedItem(item) {
  const source_id = trimToNull(item.referencenumber);
  const title = trimToNull(item.title);
  const company = trimToNull(item.company || item.creator);
  const description = trimToNull(item.description || item.body || item.content || item.summary);
  const location =
    trimToNull(item.location) ||
    (trimToNull(item.city) && trimToNull(item.state)
      ? `${trimToNull(item.city)}, ${trimToNull(item.state)}`
      : trimToNull(item.city) || trimToNull(item.state) || null);
  const salary_min = parseNumberToInt(item.compensation_min);
  const salary_max = parseNumberToInt(item.compensation_max);
  const salary_timeframe = normalizeSalaryTimeframe(item.compensation_interval);
  const is_remote = parseBoolean(item.remote);
  const company_logo = trimToNull(item.logo);
  const source_url = trimToNull(item.url) || trimToNull(item.link);
  const posted_date = parseDate(item.date || item.pubDate || item.updated || item.isoDate);
  const expiration_date = parseDate(item.expiration_date);
  const jobtype = trimToNull(item.jobtype) || '';
  const status = jobtype.toLowerCase().includes('archived') ? 'archived' : 'active';

  return {
    source_id,
    title,
    company,
    description,
    location,
    salary_min,
    salary_max,
    salary_timeframe,
    is_remote,
    company_logo,
    source_url,
    posted_date,
    expiration_date,
    status,
  };
}

async function processOneJob({ supabase, mapped, summary }) {
  const sourceId = mapped.source_id;
  if (!sourceId) {
    summary.skippedNoSourceId += 1;
    return;
  }

  const { data: existing, error: findErr } = await supabase
    .from('jobs')
    .select('id,description,salary_min,salary_max,company_logo')
    .eq('source_id', sourceId)
    .maybeSingle();

  if (findErr) {
    summary.errors += 1;
    console.error(`Lookup error for source_id=${sourceId}:`, findErr.message || findErr);
    return;
  }

  if (existing) {
    const update = {};
    let changed = false;

    if (isBlank(existing.description) && !isBlank(mapped.description)) {
      update.description = mapped.description;
      summary.descriptionsAdded += 1;
      changed = true;
    }
    if (existing.salary_min == null && mapped.salary_min != null) {
      update.salary_min = mapped.salary_min;
      summary.salaryDataAdded += 1;
      changed = true;
    }
    if (existing.salary_max == null && mapped.salary_max != null) {
      update.salary_max = mapped.salary_max;
      summary.salaryDataAdded += 1;
      changed = true;
    }
    if (isBlank(existing.company_logo) && !isBlank(mapped.company_logo)) {
      update.company_logo = mapped.company_logo;
      summary.logosAdded += 1;
      changed = true;
    }

    if (!changed) {
      summary.alreadyComplete += 1;
      return;
    }

    const { error: updateErr } = await supabase.from('jobs').update(update).eq('id', existing.id);
    if (updateErr) {
      summary.errors += 1;
      console.error(`Update error for id=${existing.id}:`, updateErr.message || updateErr);
    }
    return;
  }

  if (isBlank(mapped.title) || isBlank(mapped.company)) {
    summary.alreadyComplete += 1;
    return;
  }

  const insertRow = {
    id: crypto.randomUUID(),
    source_id: mapped.source_id,
    title: mapped.title,
    company: mapped.company,
    description: mapped.description,
    location: mapped.location,
    salary_min: mapped.salary_min,
    salary_max: mapped.salary_max,
    salary_timeframe: mapped.salary_timeframe,
    is_remote: mapped.is_remote,
    company_logo: mapped.company_logo,
    source_url: mapped.source_url,
    posted_date: mapped.posted_date,
    expiration_date: mapped.expiration_date,
    status: mapped.status,
    source: 'IMS',
    is_verified: true,
  };

  const { error: insertErr } = await supabase.from('jobs').upsert(insertRow, { onConflict: 'source_id' });
  if (insertErr) {
    summary.errors += 1;
    console.error(`Insert/upsert error for source_id=${sourceId}:`, insertErr.message || insertErr);
    return;
  }
  summary.newJobsInserted += 1;
}

async function main() {
  const ROOT_DIR = path.resolve(__dirname, '..');
  loadEnvFromFile(path.join(ROOT_DIR, '.env'));

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;
  if (!supabaseUrl || !supabaseKey) throw new Error('Missing SUPABASE_URL or SUPABASE_KEY in .env');

  const fetched = await fetchRawContent(FEED_URL);
  const raw = fetched.body || '';
  const { items, strategy } = await parseFeedItems(raw);

  console.log(`Feed parse strategy: ${strategy}`);
  console.log(`Total feed items: ${items.length}`);

  const supabase = createClient(supabaseUrl, supabaseKey);
  const summary = {
    totalFeedItems: items.length,
    descriptionsAdded: 0,
    salaryDataAdded: 0,
    logosAdded: 0,
    newJobsInserted: 0,
    alreadyComplete: 0,
    skippedNoSourceId: 0,
    errors: 0,
  };

  for (let i = 0; i < items.length; i += 1) {
    const mapped = mapFeedItem(items[i]);

    try {
      await processOneJob({ supabase, mapped, summary });
    } catch (err) {
      summary.errors += 1;
      console.error(`Unexpected processing error at item ${i + 1}:`, err?.message || err);
    }

    if ((i + 1) % 200 === 0 || i + 1 === items.length) {
      console.log(
        `Progress ${i + 1}/${items.length} | descriptionsAdded=${summary.descriptionsAdded} salaryDataAdded=${summary.salaryDataAdded} logosAdded=${summary.logosAdded} newInserted=${summary.newJobsInserted} alreadyComplete=${summary.alreadyComplete} errors=${summary.errors}`
      );
    }

    if (i + 1 < items.length) {
      await sleep(ITEM_DELAY_MS);
    }
  }

  console.log('Enrichment complete.');
  console.log(
    `Summary:\n` +
      `totalFeedItems=${summary.totalFeedItems}\n` +
      `descriptionsAdded=${summary.descriptionsAdded}\n` +
      `salaryDataAdded=${summary.salaryDataAdded}\n` +
      `logosAdded=${summary.logosAdded}\n` +
      `newJobsInserted=${summary.newJobsInserted}\n` +
      `alreadyComplete=${summary.alreadyComplete}\n` +
      `skippedNoSourceId=${summary.skippedNoSourceId}\n` +
      `errors=${summary.errors}`
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error('XML enrich failed:', err?.message || err);
    process.exit(1);
  });
}

