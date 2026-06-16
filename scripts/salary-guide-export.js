/**
 * One-off read-only export for salary guide analytics.
 * Uses SUPABASE_SERVICE_KEY when set (else SUPABASE_KEY). Does not write to DB.
 */
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

function loadDotEnv(dotPath) {
  if (!fs.existsSync(dotPath)) return;
  const raw = fs.readFileSync(dotPath, 'utf8');
  for (let line of raw.split('\n')) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
      v = v.slice(1, -1).replace(/\\n/g, '\n');
    if (!process.env[k]) process.env[k] = v;
  }
}

const STOP = new Set(
  `
  and the for with from into your this that have has been will can may our are was were not but what all any their one two more most some such when who how which while about than then them its also into over other only same such most such than then these those under very just like through after before between both each few because being both off out up down than first also new must should could would needs need including include based around looking seek seeking join team great good strong excellent well help build work working experience years year day days time full part contract role roles position Job opportunity apply application applications via using use used using
  remote hybrid onsite on-site office location united states canada uk emea latam america na eu apac london new york california texas florida canada senior junior mid director manager specialist coordinator analyst associate assistant executive vp partner brand marketing digital media social creator content business development sales growth analyst lead head chief staff principal intern freelance contractor temporary temp perm permanent global national regional hq hybrid flexible
`.split(/\s+/).filter(Boolean)
);

function tokenizeSkills(text) {
  if (!text || typeof text !== 'string') return [];
  const m = text.toLowerCase().match(/[a-z][a-z+#'-]{2,}/g);
  return m || [];
}

function seniorityBucket(title) {
  const t = String(title || '').toLowerCase();
  if (/\b(c\s*-suite|chief|president|cfo|clo|cio|cco|cto|cmo|ceo|chief executive|evp\b|svp\b|vp\b|vice\s+president)\b/.test(t))
    return 'VP / Executive / C‑suite';
  if (/\b(director|dir\.|dir\b|head of)\b/.test(t)) return 'Director';
  if (/\b(senior|sr\.?\b|lead\b|principal\b|staff\b)\b/.test(t)) return 'Senior / Lead';
  if (/\b(junior|jr\.?\b|intern(ship)?|entry[\s-]level)\b/.test(t)) return 'Entry / Junior / Intern';
  return 'Mid / Unspecified seniority';
}

function workArrangement(loc, isRemote) {
  const l = String(loc || '').toLowerCase();
  if (/\bhybrid\b/.test(l)) return 'Hybrid (from location text)';
  if (isRemote === true || /\bremote\b|\bwork from home\b|\bwfh\b/.test(l)) return 'Remote';
  return 'On‑site / not marked remote';
}

function midpoint(r) {
  const a = r.salary_min != null ? Number(r.salary_min) : NaN;
  const b = r.salary_max != null ? Number(r.salary_max) : NaN;
  if (!Number.isFinite(a) && !Number.isFinite(b)) return null;
  if (Number.isFinite(a) && Number.isFinite(b)) return (a + b) / 2;
  if (Number.isFinite(a)) return a;
  return b;
}

function hasSalaryPair(r) {
  const a = r.salary_min != null ? Number(r.salary_min) : NaN;
  const b = r.salary_max != null ? Number(r.salary_max) : NaN;
  return Number.isFinite(a) && Number.isFinite(b);
}

function formatUsd(n) {
  if (!Number.isFinite(n)) return '—';
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

function median(nums) {
  const s = [...nums].filter(Number.isFinite).sort((x, y) => x - y);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  if (s.length % 2) return s[m];
  return (s[m - 1] + s[m]) / 2;
}

function avg(nums) {
  const s = nums.filter(Number.isFinite);
  return s.length ? s.reduce((a, b) => a + b, 0) / s.length : null;
}

async function fetchAllJobs(supabase) {
  const page = 1000;
  let from = 0;
  const rows = [];
  for (;;) {
    const { data, error } = await supabase
      .from('jobs')
      .select('title,company,location,description,salary_min,salary_max,is_remote,posted_date,job_type,status,source')
      .range(from, from + page - 1);
    if (error) throw error;
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < page) break;
    from += page;
    if (from > 2000000) throw new Error('Safety stop: unexpectedly large dataset');
  }
  return rows;
}

async function main() {
  loadDotEnv(path.join(__dirname, '..', '.env'));
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY or SUPABASE_KEY required');

  const supabase = createClient(url, key);
  console.error('Fetching jobs…');
  const rows = await fetchAllJobs(supabase);
  console.error(`Loaded ${rows.length} rows`);

  const active = rows.filter((r) => (r.status || 'active') === 'active');
  const used = active.length ? active : rows;

  // Top 20 titles
  const titleFreq = {};
  for (const r of used) {
    const t = (r.title || '').trim();
    if (!t) continue;
    titleFreq[t] = (titleFreq[t] || 0) + 1;
  }
  const topTitles = Object.entries(titleFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);

  // Salary stats per top title where salary_min & salary_max exist
  const titleSalaryLines = [];
  for (const [tit, freq] of topTitles) {
    const subset = used.filter((r) => (r.title || '').trim() === tit && hasSalaryPair(r));
    const mins = subset.map((r) => Number(r.salary_min));
    const maxs = subset.map((r) => Number(r.salary_max));
    const mids = subset.map(midpoint).filter(Number.isFinite);
    if (!subset.length) {
      titleSalaryLines.push(`  • "${tit}" (total postings counted: ${freq}) — No rows with both salary_min and salary_max`);
      continue;
    }
    const mi = Math.min(...mins);
    const ma = Math.max(...maxs);
    titleSalaryLines.push(
      [
        `  • "${tit}"`,
        `    Postings (all statuses in export): ${freq}; with usable min+max salaries: ${subset.length}`,
        `    Minimum salary (lowest salary_min among those rows): ${formatUsd(mi)}`,
        `    Maximum salary (highest salary_max among those rows): ${formatUsd(ma)}`,
        `    Average of midpoint (${formatUsd(avg(mids))}): midpoint = (salary_min + salary_max) / 2 per posting, then averaged`,
        `    Median of midpoint: ${formatUsd(median(mids))}`,
      ].join('\n')
    );
  }

  // Skills-like terms from descriptions (schema has no skills column)
  const skillCounts = {};
  for (const r of used) {
    for (const w of tokenizeSkills(r.description)) {
      if (STOP.has(w) || /^\d+$/.test(w)) continue;
      skillCounts[w] = (skillCounts[w] || 0) + 1;
    }
  }
  const topSkills = Object.entries(skillCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  // Top 10 companies
  const companyFreq = {};
  for (const r of used) {
    const c = (r.company || '').trim();
    if (!c) continue;
    companyFreq[c] = (companyFreq[c] || 0) + 1;
  }
  const topCompanies = Object.entries(companyFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  // Seniority — inferred from title text only (no seniority column in schema)
  const senGroups = {};
  for (const r of used) {
    const k = seniorityBucket(r.title);
    if (!senGroups[k]) senGroups[k] = [];
    senGroups[k].push(r);
  }
  const senLines = [];
  for (const k of Object.keys(senGroups).sort()) {
    const g = senGroups[k].filter(hasSalaryPair);
    const mids = g.map(midpoint).filter(Number.isFinite);
    if (!mids.length) {
      senLines.push(`### ${k}\nPosting count: ${senGroups[k].length}\nSalary (min+max present): insufficient data`);
      continue;
    }
    const mins = g.map((r) => Number(r.salary_min));
    const maxs = g.map((r) => Number(r.salary_max));
    senLines.push(
      [
        `### ${k}`,
        `Posting count: ${senGroups[k].length} (classified from job title wording; heuristic)`,
        `Postings with both salary_min and salary_max: ${g.length}`,
        `Overall min (lowest salary_min): ${formatUsd(Math.min(...mins))}`,
        `Overall max (highest salary_max): ${formatUsd(Math.max(...maxs))}`,
        `Average midpoint: ${formatUsd(avg(mids))}`,
        `Median midpoint: ${formatUsd(median(mids))}`,
        '',
      ].join('\n')
    );
  }

  // 2025–2026 volume by normalized title (top roles)
  const y2025 = new Date('2025-01-01T00:00:00.000Z');
  const y2027 = new Date('2027-01-01T00:00:00.000Z');
  const recent = used.filter((r) => {
    if (!r.posted_date) return false;
    const d = new Date(r.posted_date);
    return !Number.isNaN(d.getTime()) && d >= y2025 && d < y2027;
  });
  const recentTitle = {};
  for (const r of recent) {
    const t = (r.title || '').trim();
    if (!t) continue;
    recentTitle[t] = (recentTitle[t] || 0) + 1;
  }
  const topRecentTitles = Object.entries(recentTitle)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25);

  // Location modality
  const modGroups = {};
  for (const r of used) {
    const k = workArrangement(r.location, r.is_remote);
    if (!modGroups[k]) modGroups[k] = [];
    modGroups[k].push(r);
  }
  const modLines = [];
  for (const k of Object.keys(modGroups).sort()) {
    const g = modGroups[k].filter(hasSalaryPair);
    const mids = g.map(midpoint).filter(Number.isFinite);
    if (!mids.length) {
      modLines.push(`### ${k}\nPosting count: ${modGroups[k].length}\nSalary: insufficient paired min+max data`);
      continue;
    }
    const mins = g.map((r) => Number(r.salary_min));
    const maxs = g.map((r) => Number(r.salary_max));
    modLines.push(
      [
        `### ${k}`,
        `Posting count: ${modGroups[k].length}`,
        `Postings with both salary_min and salary_max: ${g.length}`,
        `Min salary_min: ${formatUsd(Math.min(...mins))}; Max salary_max: ${formatUsd(Math.max(...maxs))}`,
        `Avg midpoint: ${formatUsd(avg(mids))}; Median midpoint: ${formatUsd(median(mids))}`,
        '',
      ].join('\n')
    );
  }

  const out = [];
  out.push('# Creator Economy Salary & Negotiation Guide — Database summary');
  out.push('');
  out.push('**Methodology notes (read-first)**');
  out.push('- Active jobs only (`status = active`) when present; otherwise all exported rows.');
  out.push('- The `jobs` table has **no dedicated skills or seniority columns**: “skills” are **top tokens from descriptions** after a stop-word filter (noisy signal). Seniority buckets are **inferred from title text**.');
  out.push('- Salaries require **both** `salary_min` and `salary_max` for per-segment calculations below. USD assumed as stored integers.');
  out.push('- Average / median salary = **average or median of (min+max)/2** per eligible posting.');
  out.push('');
  out.push(`**Dataset:** ${used.length} job rows analyzed${active.length !== rows.length ? ' (filtered to active)' : ''}.`);
  out.push('');
  out.push('## 1. Top 20 most common job titles (frequency)');
  topTitles.forEach(([t, c], i) => out.push(`${i + 1}. ${t} — ${c} postings`));
  out.push('');
  out.push('## 2. Salary summary for those top titles (where min+max exist)');
  out.push(titleSalaryLines.join('\n\n'));
  out.push('');
  out.push('## 3. Top 10 recurring terms from job descriptions (“skills‑like” vocabulary)');
  if (!topSkills.length) out.push('No description text available.');
  else topSkills.forEach(([w, c], i) => out.push(`${i + 1}. ${w} — ${c} mentions`));
  out.push('');
  out.push('## 4. Top 10 companies by posting volume');
  topCompanies.forEach(([co, c], i) => out.push(`${i + 1}. ${co} — ${c} postings`));
  out.push('');
  out.push('## 5. Salary by inferred seniority (from title)');
  out.push(senLines.join('\n'));
  out.push('');
  out.push(
    '## 6. Most frequent roles by posting volume (posted_date between 2025-01-01 and 2026-12-31 inclusive)'
  );
  out.push(`Postings with a valid date in range: **${recent.length}**`);
  if (!topRecentTitles.length)
    out.push('_No postings in window or dates missing — check posted_date completeness._');
  else topRecentTitles.forEach(([t, c], i) => out.push(`${i + 1}. ${t} — ${c} postings`));
  out.push('');
  out.push('## 7. Location / work arrangement vs salary');
  out.push('_Remote vs hybrid inferred from `is_remote` and `location` text (Hybrid if “hybrid” appears in location)._');
  out.push(modLines.join('\n'));

  process.stdout.write(out.join('\n'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
