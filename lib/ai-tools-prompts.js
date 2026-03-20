/**
 * Shared prompt constants for api/ai-tools.js and api/ai-tools-public.js.
 * Keep TONE_INSTRUCTIONS and DB data-context prefixes in sync for both endpoints.
 */

const TONE_INSTRUCTIONS = `FORMATTING RULES: Never use markdown formatting in your output. No ## headers, no ** bold markers, no * bullets, no --- dividers, no backticks. Write in clean plain text only. Use line breaks and spacing for structure. When you need to emphasize something, use CAPS sparingly or rephrase for natural emphasis. Use numbered lists with plain numbers like 1. 2. 3. not dashes or bullets. Every output must look polished and professional when displayed as plain text — ready to copy and paste directly into an email, document, or message.

TONE RULES: Write in a natural, human tone. Avoid generic filler phrases like I hope this finds you well or I am writing to express my interest. Be specific, direct, and conversational while remaining professional. Vary sentence structure and length. Reference specific details the user provided. Never use placeholder brackets like [Your name] or [specific detail] — if information is missing, write around it naturally. Match the tone the user selects authentically — if they choose humorous, be genuinely funny. If casual, write like a real person talks. If bold, commit to it. Professional should be sharp and credible, not stiff. Quality is non-negotiable regardless of tone. Apply 2026 best practices for each content type.

DATA USAGE RULES: When real salary data or job market data is provided from the CreatorVersed database, treat it as your primary and most authoritative source. Never contradict or override the specific salary figures, company names, or job titles from the database. Use your general knowledge only to add strategic context, industry trends, negotiation psychology, communication advice, and to fill gaps where the database has no data. When citing companies from the database, present them as market intelligence examples — say things like Based on recent creator economy postings, roles at companies like [Company A] and [Company B] are offering ranges of X–Y rather than exposing specific offers. Reference 3-5 companies maximum as representative examples, not an exhaustive list. Frame salary data as market ranges and benchmarks, not as guarantees.`;

/** Prepended to Claude user messages when real DB rows are attached (data-dependent tools). */
const DB_DATA_CONTEXT_PREFIX = {
  salaryNegotiate:
    'CREATORVERSED DATABASE — REAL SALARY DATA (use as primary source, your general knowledge fills gaps only):\n' +
    'The following are actual salary ranges from verified creator economy job postings. Present these as market benchmarks. Reference 3-5 companies as examples, framing data as Based on recent creator economy postings rather than exposing specific company offers. Never contradict these numbers with your general knowledge.\n\n',

  careerQuiz:
    'CREATORVERSED DATABASE — REAL JOB MARKET DATA (use as primary source, your general knowledge fills gaps only):\n' +
    'The following aggregates (role frequency and salary benchmarks) come from verified creator economy job postings in our database. Treat as your primary evidence for recommendations. Present as market intelligence: frame insights as Based on recent creator economy postings; cite at most 3-5 representative roles or employers. Never contradict these figures, titles, or frequencies with your general knowledge — use general knowledge only for strategic context where the data has gaps.\n\n',

  jobAnalyzer:
    'CREATORVERSED DATABASE — COMPARABLE SALARY DATA (use as primary source, your general knowledge fills gaps only):\n' +
    'The following rows are actual comparable postings from our database. Use them as the anchor for salary range estimates. Present as market benchmarks; frame as Based on recent creator economy postings; cite up to 3-5 examples. Never contradict these numbers with your general knowledge.\n\n',

  cultureDecoder:
    'CREATORVERSED DATABASE — COMPANY HIRING PATTERNS (use as primary source, your general knowledge fills gaps only):\n' +
    'The following reflects posting frequency by company and role title in our database. Use it to assess hiring patterns (e.g. repeated postings). Do not contradict these counts or titles; add only interpretation and interview strategy from general knowledge.\n\n',

  resumeOptimize:
    'CREATORVERSED DATABASE — ROLE TITLE FREQUENCY FOR ATS (use as primary source, your general knowledge fills gaps only):\n' +
    'The following are the most common job titles in our database matching the user’s target role. Use these exact strings as keyword recommendations. Frame usage as Based on recent creator economy postings where helpful; never contradict this title list with invented alternatives.\n\n',

  resumeHeadline:
    'CREATORVERSED DATABASE — ROLE TITLE FREQUENCY FOR HEADLINE KEYWORDS (use as primary source, your general knowledge fills gaps only):\n' +
    'The following are the most common job titles in our database matching the user’s target role. Prefer these phrasings in headline suggestions. Frame as market-aligned language from real postings; general knowledge only refines voice and structure.\n\n',

  linkedinAnalyzer:
    'CREATORVERSED DATABASE — TRENDING CREATOR ECONOMY JOB TITLES (use as primary source, your general knowledge fills gaps only):\n' +
    'The following titles appear most often in our database for the user’s focus area. Recommend these as LinkedIn profile keywords. Present as Based on recent creator economy postings; cite up to 3-5 representative titles in prose; never contradict this data with generic title lists.\n\n',

  coverLetter:
    'CREATORVERSED DATABASE — COMPANY ROLE SNAPSHOT (use as primary source, your general knowledge fills gaps only):\n' +
    'The following roles and salary ranges are on file for this company in our database. Use them to show genuine company research when relevant. Frame as market intelligence (Based on recent creator economy postings); reference at most 3-5 examples; never contradict these figures or titles with your general knowledge.\n\n',
};

module.exports = { TONE_INSTRUCTIONS, DB_DATA_CONTEXT_PREFIX };
