/**
 * GET /api/jobs
 * Aggregates jobs from IMS RSS, Google Jobs (SerpAPI), and Y Combinator.
 * Uses Supabase to cache results for 6 hours.
 *
 * Query params: q, location, type, remote, page, limit
 */

const { createClient } = require('@supabase/supabase-js');
const Parser = require('rss-parser');
const SerpApi = require('google-search-results-nodejs');

const CACHE_HOURS = 6;
const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const IMS_RSS_URL = process.env.IMS_RSS_URL || 'https://www.influencermarketingsociety.com/jobs.rss';

function normalize(str) {
  return (str || '').toLowerCase().trim();
}

function dedupeKey(job) {
  return normalize(job.title) + '|' + normalize(job.company) + '|' + normalize(job.location || '');
}

/** Fetch and parse IMS RSS feed */
async function fetchImsJobs() {
  const parser = new Parser();
  const feed = await parser.parseURL(IMS_RSS_URL);
  return (feed.items || []).map((item) => ({
    title: item.title || '',
    company: item.creator || item['dc:creator'] || 'Unknown',
    location: item['location'] || item.contentSnippet?.match(/Location[:\s]+([^\n]+)/)?.[1]?.trim() || '',
    description: item.content || item.contentSnippet || '',
    link: item.link || '',
    pubDate: item.pubDate || null,
    source: 'IMS',
    is_verified: true,
  }));
}

/** Fetch Google Jobs via SerpAPI */
function fetchGoogleJobs(query, location) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.SERPAPI_KEY;
    if (!apiKey) {
      resolve([]);
      return;
    }
    const search = new SerpApi.GoogleSearch(apiKey);
    const params = {
      engine: 'google_jobs',
      q: query || 'creator economy jobs',
      hl: 'en',
    };
    if (location) params.location = location;
    search.json(params, (data) => {
      try {
        const jobsResults = data?.jobs_results;
        const jobList = jobsResults?.jobs ?? (Array.isArray(jobsResults) ? jobsResults : []);
        const jobs = (Array.isArray(jobList) ? jobList : []).map((j) => ({
          title: j.title || '',
          company: j.company_name || j.company || '',
          location: j.location || '',
          description: j.description || j.snippet || '',
          link: j.link || j.apply_link || '',
          pubDate: j.posted_at || j.detected_extensions?.posted_at || null,
          source: 'Google Jobs',
          is_verified: false,
          via: j.via || null,
        }));
        resolve(jobs);
      } catch (e) {
        resolve([]);
      }
    });
  });
}

/** Fetch Y Combinator / Work at a Startup jobs (skip if API unavailable) */
async function fetchYcJobs() {
  try {
    const url = 'https://www.workatastartup.com/companies.json';
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    const contentType = res.headers.get('content-type') || '';
    if (!res.ok || !contentType.includes('application/json')) {
      return [];
    }
    const data = await res.json();
    const jobs = [];
    const companies = data?.companies ?? data?.deals ?? Array.isArray(data) ? data : [];
    for (const co of companies) {
      const companyName = co.name ?? co.company_name ?? co.company ?? 'YC Company';
      const positions = co.positions ?? co.jobs ?? [];
      for (const pos of positions) {
        const title = typeof pos === 'string' ? pos : (pos.title ?? pos.name ?? '');
        const loc = typeof pos === 'string' ? '' : (pos.location ?? pos.remote ?? '');
        jobs.push({
          title,
          company: companyName,
          location: loc,
          description: typeof pos === 'object' ? (pos.description || '') : '',
          link: pos?.link ?? pos?.url ?? `https://www.workatastartup.com/companies/${co.slug || ''}`,
          pubDate: null,
          source: 'Y Combinator',
          is_verified: true,
        });
      }
    }
    return jobs;
  } catch {
    return [];
  }
}

/** Merge and dedupe: IMS first, then YC, then Google (drop Google duplicate if IMS/YC has same key) */
function mergeAndDedupe(ims, yc, google) {
  const byKey = new Map();
  const add = (job, priority) => {
    const key = dedupeKey(job);
    const existing = byKey.get(key);
    if (!existing || existing.priority > priority) {
      byKey.set(key, { ...job, priority });
    }
  };
  ims.forEach((j) => add(j, 1));
  yc.forEach((j) => add(j, 2));
  google.forEach((j) => add(j, 3));
  const ordered = [];
  [...ims].forEach((j) => {
    const key = dedupeKey(j);
    if (byKey.get(key)?.priority === 1) ordered.push(byKey.get(key));
  });
  [...yc].forEach((j) => {
    const key = dedupeKey(j);
    if (byKey.get(key)?.priority === 2) ordered.push(byKey.get(key));
  });
  [...google].forEach((j) => {
    const key = dedupeKey(j);
    if (byKey.get(key)?.priority === 3) ordered.push(byKey.get(key));
  });
  return ordered.map(({ priority, ...j }) => j);
}

/** Build Supabase query filters from query params */
function buildFilters(supabase, params) {
  let q = supabase.from('jobs').select('*', { count: 'exact' }).eq('status', 'active');
  if (params.q && params.q.trim()) {
    const term = `%${params.q.trim()}%`;
    q = q.or(`title.ilike.${term},company.ilike.${term},description.ilike.${term}`);
  }
  if (params.location && params.location.trim()) {
    q = q.ilike('location', `%${params.location.trim()}%`);
  }
  if (params.type && params.type.trim()) {
    q = q.ilike('job_type', `%${params.type.trim()}%`);
  }
  if (params.remote === 'true' || params.remote === true) {
    q = q.eq('is_remote', true);
  }
  return q;
}

/** Order by source: IMS (1), Y Combinator (2), Google Jobs (3) */
const sourceOrder = (a, b) => {
  const order = { 'IMS': 1, 'Y Combinator': 2, 'Google Jobs': 3 };
  return (order[a.source] ?? 4) - (order[b.source] ?? 4);
};

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

  const params = {
    q: req.query.q || '',
    location: req.query.location || '',
    type: req.query.type || '',
    remote: req.query.remote === 'true',
    page: Math.max(1, parseInt(req.query.page, 10) || DEFAULT_PAGE),
    limit: Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || DEFAULT_LIMIT)),
  };

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    res.setHeader('Content-Type', 'application/json');
    res.status(500).json({ error: 'Server misconfiguration: missing Supabase env' });
    return;
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const sixHoursAgo = new Date(Date.now() - CACHE_HOURS * 60 * 60 * 1000).toISOString();
    const { data: metaRow } = await supabase.from('app_meta').select('value').eq('key', 'last_job_sync').single();
    const lastSync = metaRow?.value ? new Date(metaRow.value) : null;
    const cacheFresh = lastSync && lastSync > sixHoursAgo;

    if (!cacheFresh) {
      const [ims, yc, google] = await Promise.all([
        fetchImsJobs().catch(() => []),
        fetchYcJobs(),
        fetchGoogleJobs(params.q || 'creator economy jobs', params.location || undefined),
      ]);
      const merged = mergeAndDedupe(ims, yc, google);
      const payload = merged.map((j) => ({
        title: j.title,
        company: j.company,
        location: j.location || '',
        description: j.description || '',
        source: j.source,
        source_url: j.link || '',
        via: j.via || null,
        is_verified: j.is_verified,
        posted_date: j.pubDate,
        job_type: null,
        is_remote: false,
      }));
      if (payload.length > 0) {
        await supabase.rpc('upsert_jobs_batch', { jobs_json: payload });
      }
      await supabase.from('app_meta').upsert({ key: 'last_job_sync', value: new Date().toISOString() }, { onConflict: 'key' });
    }

    const query = buildFilters(supabase, params);
    const { data: allJobs, error: fetchError, count } = await query
      .order('created_at', { ascending: false })
      .range(0, 1999);

    if (fetchError) {
      res.setHeader('Content-Type', 'application/json');
      res.status(500).json({ error: 'Failed to fetch jobs', details: fetchError.message });
      return;
    }

    const sorted = (allJobs || []).slice().sort(sourceOrder);
    const total = count ?? sorted.length;
    const offset = (params.page - 1) * params.limit;
    const pageJobs = sorted.slice(offset, offset + params.limit);

    const sources = { ims: 0, google: 0, yc: 0 };
    pageJobs.forEach((j) => {
      if (j.source === 'IMS') sources.ims += 1;
      else if (j.source === 'Google Jobs') sources.google += 1;
      else if (j.source === 'Y Combinator') sources.yc += 1;
    });

    const jobs = pageJobs.map((j) => ({
      id: j.id,
      title: j.title,
      company: j.company,
      location: j.location,
      description: j.description,
      salary_min: j.salary_min,
      salary_max: j.salary_max,
      job_type: j.job_type,
      is_remote: j.is_remote,
      source: j.source,
      source_url: j.source_url,
      is_verified: j.is_verified,
      posted_date: j.posted_date,
      created_at: j.created_at,
      via: j.via ?? undefined,
    }));

    res.setHeader('Content-Type', 'application/json');
    res.status(200).json({
      jobs,
      total,
      page: params.page,
      sources,
    });
  } catch (err) {
    res.setHeader('Content-Type', 'application/json');
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
};
