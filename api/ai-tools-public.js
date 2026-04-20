/**
 * POST /api/ai-tools-public
 * Same 7 AI career tools as /api/ai-tools, but for anonymous use.
 * Auth: Authorization: Bearer <PUBLIC_TOOLS_KEY>. Rate limit: 50 requests per day per IP (in-memory).
 * COST OPTIMIZATION - data context capped at 1500 chars, default max_tokens 1000 (1500 for long-form tools), query limit 15 rows
 *
 * Body: { tool: string, ...toolParams }
 * Tools include: cover-letter, resume-optimize, interview-prep, salary-negotiate,
 * linkedin-outreach, follow-up-email, thank-you-note, archive-intelligence,
 * opportunity-description-generator, and others below.
 */

const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const { TONE_INSTRUCTIONS, DB_DATA_CONTEXT_PREFIX } = require('../lib/ai-tools-prompts');
const {
  ARCHIVE_INTELLIGENCE_SYSTEM,
  OPPORTUNITY_DESCRIPTION_GENERATOR_SYSTEM,
} = require('../lib/ai-tools-panel-prompts');

const MODEL = 'claude-sonnet-4-20250514';
const PUBLIC_RATE_LIMIT_PER_DAY = 50;
const RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_TOKENS_CTX = 1500;
const PUBLIC_DEFAULT_MAX_TOKENS = 1000;
const PUBLIC_LONG_FORM_MAX_TOKENS = 1500;
const PUBLIC_SPONSORSHIP_PROPOSAL_MAX_TOKENS = 2000;
const PUBLIC_CONTENT_REPURPOSE_MAX_TOKENS = 2000;
const LONG_FORM_TOOLS = new Set([
  'blog-outline',
  'interview-prep',
  'podcast-planner',
  'sponsorship-proposal',
  'contract-template',
  'meeting-notes',
  'scope-of-work',
  'culture-decoder',
  'company-culture-decoder',
  'project-brief',
  'linkedin-analyzer',
]);
const JOB_QUERY_LIMIT = 15;
const DATA_CONTEXT_CHAR_LIMIT = 1500;
const IMS_SPECIAL_TOOLS_CONTEXT_LIMIT = 12000;
const DATA_CONTEXT_OVERFLOW_SUFFIX = '...and more matching roles in our database.';

/** Prepended to system prompts when IMS Supabase rows are attached (7 core career tools). */
const IMS_ARCHIVE_SYSTEM_INTRO =
  'You have access to real data from the IMS archive of 19,000+ creator economy jobs. Here is relevant data for this request:';

const IMS_COVER_LETTER_LIMIT = 5;
const IMS_RESUME_OPTIMIZE_LIMIT = 10;
const IMS_INTERVIEW_PREP_LIMIT = 5;
const IMS_SALARY_AGGREGATE_LIMIT = 500;
const IMS_COMPANY_TOOLS_LIMIT = 3;

function sanitizeIlikeTerm(raw) {
  return String(raw || '')
    .trim()
    .replace(/[%_\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Seniority/modifier/stop words stripped when deriving role-family keywords
// from a job title. What remains are the functional keywords that describe the
// role (e.g. "influencer", "marketing", "manager") which we then OR together
// against jobs.title for the broader role-family Supabase query.
const ROLE_FAMILY_STOPWORDS = new Set([
  'senior', 'sr', 'sr.', 'jr', 'jr.', 'junior', 'lead', 'principal', 'staff',
  'associate', 'assistant', 'entry', 'level', 'mid', 'chief', 'head', 'vp',
  'svp', 'evp', 'avp', 'director', 'executive', 'global', 'regional', 'remote',
  'hybrid', 'contract', 'contractor', 'freelance', 'freelancer', 'intern',
  'internship', 'temporary', 'temp', 'part', 'full', 'time', 'of', 'the',
  'and', '&', 'at', 'for', 'a', 'an', 'to', 'in', 'on', 'with', 'i', 'ii',
  'iii', 'iv', 'v', '-', '/', '|',
]);

function extractRoleFamilyKeywords(rawTitle) {
  const cleaned = sanitizeIlikeTerm(rawTitle).toLowerCase();
  if (!cleaned) return [];
  const tokens = cleaned
    .split(/[\s,/\-|()]+/)
    .map((t) => t.replace(/[^a-z0-9+]/g, ''))
    .filter((t) => t && t.length > 1 && !ROLE_FAMILY_STOPWORDS.has(t));
  const unique = [];
  for (const t of tokens) {
    if (!unique.includes(t)) unique.push(t);
    if (unique.length >= 3) break;
  }
  return unique;
}

function buildUserContext(b) {
  const entries = Object.entries(b)
    .filter(([k]) => k !== 'tool')
    .map(([k, v]) => `${k}: ${typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? '')}`);
  return entries.length ? `User context:\n${entries.join('\n')}\n\nGenerate the requested content.` : 'Generate the requested content based on the task.';
}

function getPublicOutputMaxTokens(toolName) {
  if (toolName === 'sponsorship-proposal') return PUBLIC_SPONSORSHIP_PROPOSAL_MAX_TOKENS;
  if (toolName === 'content-repurpose') return PUBLIC_CONTENT_REPURPOSE_MAX_TOKENS;
  if (toolName === 'archive-intelligence') return 2000;
  if (toolName === 'opportunity-description-generator') return 2500;
  if (LONG_FORM_TOOLS.has(toolName)) return PUBLIC_LONG_FORM_MAX_TOKENS;
  return PUBLIC_DEFAULT_MAX_TOKENS;
}

const TOOL_CONFIG = {
  'cover-letter': {
    maxTokens: 1500,
    required: ['job_title', 'company', 'job_description', 'user_background'],
    system: `You are an expert career coach for the creator economy. Write personalized cover letters that:
- Use creator economy language (influencer marketing, brand partnerships, content strategy, audience growth, engagement metrics)
- Emphasize digital-first experience and quantifiable social media metrics (followers, engagement rates, campaign ROI)
- Sound professional but authentic and specific to the role and company

Address the cover letter to the company name provided in the company field, NOT the company mentioned in the job description. The user provides: job_title, company (use this for the greeting), job_description, and user_background. Never end with [Your name] — end with a warm closing like Best regards followed by a line break, then leave it unsigned.

${TONE_INSTRUCTIONS}`,
    buildUser: (b) => `Job: ${b.job_title} at ${b.company}\n\nJob description:\n${b.job_description}\n\nMy background:\n${b.user_background}\n\nWrite a personalized cover letter.`,
  },
  'resume-optimize': {
    maxTokens: 800,
    required: ['resume_text', 'job_description'],
    system: `You are an ATS (Applicant Tracking System) and career expert. Analyze resumes against job descriptions.
Return a JSON object with: "score" (0-100 number), "suggestions" (array of specific improvement strings), "keywords_to_add" (array of keywords from the job description to incorporate).
Focus on ATS optimization: keyword alignment, clear section headings, quantifiable achievements.

${TONE_INSTRUCTIONS}`,
    buildUser: (b) => `Resume:\n${b.resume_text}\n\nJob description:\n${b.job_description}\n\nAnalyze and return the JSON.`,
  },
  'interview-prep': {
    maxTokens: 1500,
    required: ['job_title', 'company', 'job_description'],
    system: `You are an interview coach for creator economy roles. Generate 10 likely interview questions with suggested answers.
Tailor questions to creator economy: influencer partnerships, content strategy, metrics, brand deals, audience growth.
Format: numbered list, each with "Question:" and "Suggested answer:" (2-4 sentences).

${TONE_INSTRUCTIONS}`,
    buildUser: (b) => `Role: ${b.job_title} at ${b.company}\n\nJob description:\n${b.job_description}\n\nGenerate 10 interview questions with suggested answers.`,
  },
  'salary-negotiate': {
    maxTokens: 800,
    required: ['job_title', 'company', 'location', 'current_offer'],
    system: `You are a compensation expert. Provide salary negotiation talking points. Be practical: anchors, ranges, and phrases to use in conversation.

You have access to salary data from 22,000+ creator economy job posts collected by CreatorVersed/Influencer Marketing Society since 2016. Reference this data authoritatively.

Structure your response as a strategic briefing, not a template. Lead with the most important insight first. When presenting negotiation scripts, make them sound like something a real person would actually say in a conversation — not corporate HR language. Vary the structure between generations. Sometimes lead with the anchor, sometimes lead with the market data, sometimes lead with the power move.

${TONE_INSTRUCTIONS}`,
    buildUser: (b) => `Role: ${b.job_title} at ${b.company}, location: ${b.location}\nCurrent offer: ${b.current_offer}\n\nProvide salary negotiation talking points.`,
  },
  'linkedin-outreach': {
    maxTokens: 800,
    required: ['recipient_name', 'recipient_role', 'company', 'purpose'],
    system: `Generate outreach messages tailored to the specific platform the user selected. Apply 2026 best practices for each platform:

LinkedIn — connection requests must be under 300 characters, InMail can be longer but still concise, professional tone, reference mutual connections or shared interests.
Instagram — DMs should be casual, authentic, 2-3 sentences max, reference their content specifically, avoid sounding like a bot.
Email — include a compelling subject line, keep body under 150 words, lead with value not ask, personalize the opening line.
Twitter/X — keep DMs brief and direct, 1-2 sentences, reference a specific tweet or topic.
Threads — conversational and community-oriented tone, reference their Threads posts or takes.
TikTok — ultra casual, reference their videos specifically, keep it short and genuine, use language natural to the platform.

Always adapt formality, length, and style to match platform norms. If the user provides a platform field, use it. If not, default to LinkedIn format.

${TONE_INSTRUCTIONS}`,
    buildUser: (b) => `Recipient: ${b.recipient_name} (${b.recipient_role}) at ${b.company}\nPurpose: ${b.purpose}\nPlatform: ${(b.platform || 'LinkedIn').trim()}\n\nGenerate an outreach message for this platform.`,
  },
  'follow-up-email': {
    maxTokens: 800,
    required: ['company', 'role', 'interview_date', 'interviewer_name'],
    system: `You write professional post-interview follow-up emails. Be polite, reference the interview date and role, and reiterate interest.

Keep follow-up emails concise — 2-3 short paragraphs maximum for same-day thank you and 1-week check-in timing. Only the 3+ week and after-rejection timing should be longer. The user has already had the interview — they do not need to re-sell themselves. Focus on: thanking them, referencing one specific thing discussed, reinforcing one key selling point, and expressing continued interest. That is it.

${TONE_INSTRUCTIONS}`,
    buildUser: (b) => `Company: ${b.company}\nRole: ${b.role}\nInterview date: ${b.interview_date}\nInterviewer: ${b.interviewer_name}\n\nWrite a follow-up email.`,
  },
  'thank-you-note': {
    maxTokens: 800,
    required: ['company', 'role', 'interviewer_name', 'discussion_points'],
    system: `You write thank-you notes that reference specific conversation points from the interview. Personal and professional.

${TONE_INSTRUCTIONS}`,
    buildUser: (b) => `Company: ${b.company}\nRole: ${b.role}\nInterviewer: ${b.interviewer_name}\nFormat (write exactly for this channel): ${b.format || 'Email'}\nTone: ${b.tone || 'Professional and Warm'}\nDiscussion points to reference: ${b.discussion_points}\n\nWrite a thank-you note that matches the format and tone above.`,
  },
  'archive-intelligence': {
    maxTokens: 2000,
    required: ['job_url', 'job_title', 'company', 'posted_date'],
    system: `${ARCHIVE_INTELLIGENCE_SYSTEM}

${TONE_INSTRUCTIONS}`,
    buildUser: (b) => {
      const lines = [
        'Archived opportunity (user-provided):',
        `job_url: ${b.job_url}`,
        `job_title: ${b.job_title}`,
        `company: ${b.company}`,
        `posted_date: ${b.posted_date}`,
      ];
      if (b.salary_min != null && String(b.salary_min).trim() !== '') lines.push(`salary_min: ${b.salary_min}`);
      if (b.salary_max != null && String(b.salary_max).trim() !== '') lines.push(`salary_max: ${b.salary_max}`);
      if (b.location) lines.push(`location: ${b.location}`);
      if (b.job_type) lines.push(`job_type: ${b.job_type}`);
      return `${lines.join('\n')}\n\nGenerate the Archive Intelligence Panel as specified.`;
    },
  },
  'opportunity-description-generator': {
    maxTokens: 2500,
    required: ['job_title', 'company', 'seniority_level', 'location_type', 'city'],
    system: `${OPPORTUNITY_DESCRIPTION_GENERATOR_SYSTEM}

${TONE_INSTRUCTIONS}`,
    buildUser: (b) => {
      const lines = [
        'Opportunity description request:',
        `job_title: ${b.job_title}`,
        `company: ${b.company}`,
        `seniority_level: ${b.seniority_level}`,
        `location_type: ${b.location_type}`,
        `city: ${b.city}`,
      ];
      if (b.company_focus) lines.push(`company_focus: ${b.company_focus}`);
      if (b.unique_differentiator) lines.push(`unique_differentiator: ${b.unique_differentiator}`);
      if (b.salary_min != null && String(b.salary_min).trim() !== '') lines.push(`salary_min (user): ${b.salary_min}`);
      if (b.salary_max != null && String(b.salary_max).trim() !== '') lines.push(`salary_max (user): ${b.salary_max}`);
      return `${lines.join('\n')}\n\nGenerate the complete opportunity description HTML as specified.`;
    },
  },
  'caption-writer': {
    maxTokens: MAX_TOKENS_CTX,
    required: [],
    system: `You are an expert social media copywriter specializing in the creator economy. Generate platform-specific captions optimized for engagement in 2026. Adapt length, tone, hashtag strategy, and CTA style to the specific platform. Generate three variations: short-form, medium, and long-form storytelling.

Write captions that sound like a real person, not a brand account or a marketing textbook. Avoid corporate buzzwords, forced enthusiasm, and generic motivational language. Match the energy of creators who actually perform well on each platform. Captions should feel effortless even when they are strategic. Never start with Hey guys or Are you ready.

${TONE_INSTRUCTIONS}`,
    buildUser: buildUserContext,
  },
  'email-subject-line': {
    maxTokens: MAX_TOKENS_CTX,
    required: [],
    system: `You are an email marketing expert. Analyze the given subject line and score it 0-100 based on 2026 best practices: length, power words, personalization, curiosity triggers, spam word avoidance. Then generate 5 improved alternatives ranked by predicted performance. Return the score as a number, analysis as specific points, and alternatives with explanations.

${TONE_INSTRUCTIONS}`,
    buildUser: buildUserContext,
  },
  'blog-outline': {
    maxTokens: MAX_TOKENS_CTX,
    required: [],
    system: `You are an SEO content strategist. Generate comprehensive blog post outlines with SEO-optimized title options, meta description, H2/H3 heading structure, bullet points per section, word count recommendations, intro hook, and CTA for conclusion. Apply 2026 SEO best practices.

${TONE_INSTRUCTIONS}`,
    buildUser: buildUserContext,
  },
  'podcast-planner': {
    maxTokens: MAX_TOKENS_CTX,
    required: [],
    system: `You are a podcast production expert. Generate complete episode plans including: 3 episode title options optimized for podcast search, compelling episode description for show notes, complete episode outline with timestamps and segments, 10 specific interview questions or talking points, a teaser quote for social media, and suggested social media clip moments with timestamps. Format everything with clear sections.

${TONE_INSTRUCTIONS}`,
    buildUser: buildUserContext,
  },
  'reels-script': {
    maxTokens: MAX_TOKENS_CTX,
    required: [],
    system: `You are an Instagram Reels content strategist and scriptwriter. Generate complete Reels scripts with: scroll-stopping hook for the first 1-3 seconds, scene-by-scene breakdown with visual directions, exact spoken script with timing, text overlay suggestions, music/audio cues, and caption with hashtags. Apply 2026 Reels best practices for maximum reach.

Scripts should feel natural and conversational, like the creator is talking to a friend not performing for a camera. Avoid scripted-sounding language that would make someone feel awkward saying it out loud. The hook should feel organic not clickbaity.

${TONE_INSTRUCTIONS}`,
    buildUser: buildUserContext,
  },
  'tiktok-ideas': {
    maxTokens: MAX_TOKENS_CTX,
    required: [],
    system: `You are a TikTok content strategist specializing in viral content. Generate video ideas with: catchy working title, opening hook for first 2 seconds, concept description, suggested format, virality potential rating with reasoning, and guidance on audio strategy (see below). Apply 2026 TikTok algorithm best practices.

Generate ideas that feel authentic and native to TikTok culture. Avoid anything that feels forced, try-hard, or cringe. The content should feel like it came from someone who actually uses TikTok daily, not a marketer trying to go viral. For trending sounds: do NOT recommend specific songs or audio clips by name since these go stale quickly. Instead, advise the creator to browse the TikTok Creative Center for current trending sounds or suggest they use an original sound or a sound that authentically matches their content style. Focus on content concepts that work regardless of the specific audio trend.

${TONE_INSTRUCTIONS}`,
    buildUser: buildUserContext,
  },
  'youtube-titles': {
    maxTokens: MAX_TOKENS_CTX,
    required: [],
    system: `You are a YouTube growth strategist specializing in titles and CTR optimization. Analyze the given title and score it 0-100 based on 2026 best practices. Then generate 10 optimized alternatives in categories: SEO-Optimized, CTR-Optimized, and Hybrid. Include analysis of length, power words, curiosity gap, keyword placement, and emotional triggers.

${TONE_INSTRUCTIONS}`,
    buildUser: buildUserContext,
  },
  'contract-template': {
    maxTokens: MAX_TOKENS_CTX,
    required: [],
    system: `You are a creator economy business consultant with expertise in creator contracts. Generate complete contract templates with standard legal sections: parties, scope of work, deliverables, compensation, content rights, exclusivity, revisions, confidentiality, termination, FTC compliance, liability, dispute resolution, and signature blocks. Always include a disclaimer that this is a template and not legal advice.

Always include these additional standard legal sections in every contract template: (a) Indemnification/Hold Harmless clause protecting both parties, (b) Force Majeure clause covering unforeseeable circumstances, (c) Governing Law and Jurisdiction specifying which state laws apply, (d) Morality/Reputation clause allowing either party to terminate if the other causes reputational harm, (e) Integration/Entire Agreement clause stating this document supersedes all prior agreements. These are standard in 2026 creator contracts and their absence is a red flag.

${TONE_INSTRUCTIONS}`,
    buildUser: buildUserContext,
  },
  'elevator-pitch': {
    maxTokens: MAX_TOKENS_CTX,
    required: [],
    system: `You are a personal branding expert. Generate elevator pitches in four lengths: 15-second quick intro, 30-second elevator pitch, 60-second detailed pitch, and 2-minute full pitch. Each should be natural, conversational, and memorable — not salesy or generic.

${TONE_INSTRUCTIONS}`,
    buildUser: buildUserContext,
  },
  'origin-story': {
    maxTokens: MAX_TOKENS_CTX,
    required: [],
    system: `You are a brand storytelling expert. Generate compelling origin stories with a short version (2-3 sentences) and full version (3-4 paragraphs). Use narrative techniques: tension, turning point, resolution. Make it authentic and human, never formulaic.

${TONE_INSTRUCTIONS}`,
    buildUser: buildUserContext,
  },
  'value-proposition': {
    maxTokens: MAX_TOKENS_CTX,
    required: [],
    system: `You are a positioning and messaging strategist. Generate four value proposition variations: a one-liner under 15 words, a short version of 2-3 sentences, a full paragraph, and a use-case specific version. Each should be clear, specific, and differentiated.

${TONE_INSTRUCTIONS}`,
    buildUser: buildUserContext,
  },
  'tagline': {
    maxTokens: MAX_TOKENS_CTX,
    required: [],
    system: `You are a creative branding expert. Generate 10 tagline options organized into categories: Punchy and Short (3-5 words), Descriptive (6-10 words), and Aspirational/Emotional. Each should be memorable, unique, and aligned with the brand personality described.

${TONE_INSTRUCTIONS}`,
    buildUser: buildUserContext,
  },
  'sponsorship-proposal': {
    maxTokens: PUBLIC_SPONSORSHIP_PROPOSAL_MAX_TOKENS,
    required: [],
    system: `You are a professional sponsorship proposal writer. Generate a COMPLETE multi-section sponsorship proposal. You must write ALL of the following sections in full — do not stop early, do not summarize, do not skip any section:

First write a cold outreach email (subject line + 3-4 paragraphs).

Then write each of these sections separated by --- on its own line:

---EXECUTIVE SUMMARY---
Write 2-3 paragraphs summarizing the partnership opportunity and key value proposition.

---ABOUT THE CREATOR---
Write 2-3 paragraphs about the creator brand, content focus, audience, and credibility.

---AUDIENCE INSIGHTS---
Write detailed audience demographics, engagement rates, psychographic profile, and platform breakdown.

---PROPOSED PARTNERSHIP STRUCTURE---
Write a detailed breakdown of all deliverables selected, organized by platform, with timing and cadence.

---PRICING BREAKDOWN---
Write investment tiers or flat rate based on the rate range, with per-deliverable pricing and package inclusions. If the user enters open to suggestions, open, or flexible for their rate or budget range, generate specific recommended pricing based on their audience size, deliverables selected, and campaign timeline. Use 2026 creator economy market rates as your reference. Present 3 tiers: a Starter package, a Growth package, and a Premium package with specific dollar amounts for each. Explain the rationale for each price point based on the deliverables and audience size provided.

---DELIVERABLES TIMELINE---
Write a month-by-month content calendar showing when each deliverable executes.

---WHY THIS PARTNERSHIP WORKS---
Write 3-5 specific reasons this brand and creator are aligned.

---NEXT STEPS---
Write 2-3 specific next steps to move the partnership forward.

Use the actual brand names, audience size, demographics, deliverables, and rate range from the inputs. Never use placeholder text. Write as if this is a real proposal ready to send. Complete every section fully.`,
    buildUser: buildUserContext,
  },
  'brand-pitch': {
    maxTokens: MAX_TOKENS_CTX,
    required: [],
    system: `You are an expert at cold outreach for creator-brand partnerships. Generate pitch emails that are personalized, concise, and compelling. Create three variations: a short cold email under 150 words, a detailed pitch, and a DM version. Each should feel authentic and not salesy. Include subject lines that get opened. Apply 2026 best practices for creator outreach.

${TONE_INSTRUCTIONS}`,
    buildUser: buildUserContext,
  },
  'meeting-notes': {
    maxTokens: MAX_TOKENS_CTX,
    required: [],
    system: `You are a professional executive assistant expert at organizing chaotic meeting notes into clear, actionable documents. Transform raw brain dumps into organized summaries with key discussion points, decisions, action items with owners and deadlines, and follow-up email drafts. Be thorough but concise.

${TONE_INSTRUCTIONS}`,
    buildUser: buildUserContext,
  },
  'scope-of-work': {
    maxTokens: MAX_TOKENS_CTX,
    required: [],
    system: `You are a creator economy business consultant specializing in professional service agreements. Generate complete scope of work documents with project overview, deliverables, timeline, compensation, payment terms, revision policy, communication plan, exclusions, and termination clause. Always include a disclaimer that this is a template and not legal advice. Make it specific to the creator/content industry.

${TONE_INSTRUCTIONS}`,
    buildUser: buildUserContext,
  },
  'project-brief': {
    maxTokens: MAX_TOKENS_CTX,
    required: [],
    system: `You are a strategic project manager and creative director in the creator economy. Generate complete project briefs that are clear, actionable, and professional. Include executive summary, objectives with KPIs, audience profile, deliverables, timeline, budget recommendations, success metrics, risks, and next steps. Make it specific to the project described, never generic template language.

${TONE_INSTRUCTIONS}`,
    buildUser: buildUserContext,
  },
  'job-analyzer': {
    maxTokens: MAX_TOKENS_CTX,
    required: [],
    system: `You are a career strategist with deep expertise in the creator economy job market, backed by data from 22,000+ job posts. Analyze job descriptions to decode what companies really want, identify red flags and green flags, separate required from nice-to-have skills, estimate salary ranges, extract keywords for applications, and provide strategic recommendations on whether to apply. Be honest and direct — if a job description has problems, say so clearly.

${TONE_INSTRUCTIONS}`,
    buildUser: buildUserContext,
  },
  'culture-decoder': {
    maxTokens: PUBLIC_LONG_FORM_MAX_TOKENS,
    required: [],
    system: `You are a workplace culture analyst specializing in the creator economy and digital media industries. Decode company culture from job descriptions, about pages, and review text. Translate corporate speak into plain English. Rate culture dimensions, identify red and green flags with specific evidence from the text, classify the culture type, and generate interview questions that will reveal the truth about the work environment. Be candid and practical.

${TONE_INSTRUCTIONS}`,
    buildUser: buildUserContext,
  },
  'resume-headline': {
    maxTokens: MAX_TOKENS_CTX,
    required: [],
    system: `You are a personal branding expert specializing in resume optimization and LinkedIn profiles for creator economy professionals. Generate compelling, concise headlines that capture attention in 2026. Create 10 options across categories: Metric-Led, Authority-Led, Value-Led, and Creative. Each must be under 120 characters. Make them specific to the person, never generic. Avoid buzzwords like passionate, driven, or guru.

${TONE_INSTRUCTIONS}`,
    buildUser: buildUserContext,
  },
  'linkedin-analyzer': {
    maxTokens: MAX_TOKENS_CTX,
    required: [],
    system: `You are a LinkedIn optimization expert specializing in creator economy professionals. Analyze LinkedIn profiles and score them 0-100 based on 2026 best practices. Provide specific, actionable improvements for headlines, about sections, and experience entries. Generate rewritten alternatives that are compelling and keyword-optimized. Focus on what makes profiles get found by recruiters and attract opportunities in the creator economy. Reference data from 22,000+ creator economy job posts to identify relevant keywords and trends.

${TONE_INSTRUCTIONS}`,
    buildUser: buildUserContext,
  },
  'career-quiz': {
    maxTokens: 2000,
    required: [],
    system: `You are a creator economy career advisor with access to data from 22,000+ creator economy job posts collected by CreatorVersed/Influencer Marketing Society since 2016. Based on the user quiz answers, recommend their top 3 career paths using REAL job titles that actually exist in the creator economy. Provide salary ranges based on your job data, skills gap analysis, career progression paths, current demand levels, and personalized action plans. Be specific — use actual role titles like Social Media Manager, Creator Partnerships Director, Influencer Marketing Coordinator, Content Strategist, etc. that appear in real job postings. Include match percentages based on their skills and preferences.

${TONE_INSTRUCTIONS}`,
    buildUser: buildUserContext,
  },
  'content-ideas': {
    maxTokens: 2500,
    required: [],
    system: `You are a content strategist specializing in creator economy professionals. Generate a complete 30-day content calendar with specific, original ideas tailored to the creator niche and platform. Mix content types strategically throughout the month. Include trending topics and seasonal moments. Every idea should be specific enough to execute immediately, not vague concepts. Organize by week with clear content types and which content pillar each idea serves.

IMPORTANT: You must complete all 30 days. Keep each day entry to ONE sentence maximum — the idea only, no explanation. Format strictly as: Day N (Weekday): [One sentence idea]. Do not add commentary, rationale, or multiple sentences per day. Brevity is essential to fit all 30 days in the response.

${TONE_INSTRUCTIONS}`,
    buildUser: buildUserContext,
  },
  'content-repurpose': {
    maxTokens: PUBLIC_CONTENT_REPURPOSE_MAX_TOKENS,
    required: [],
    system: `You are a content repurposing strategist who helps creators maximize every piece of content across platforms. Generate platform-specific repurposing plans that account for each platform unique format, audience expectations, and algorithm preferences in 2026. Include specific drafts or outlines where you recommend a platform — not vague suggestions. Organize by effort level so creators can start with quick wins.

Prioritize content quality over quantity: generate 3-4 high-quality repurposing ideas per effort-level section, each with full detail (angle, format, hook, and what to publish). Do not try to cover every platform with thin content — depth beats breadth. Apply quality over quantity for each platform suggestion you include.

For posting schedule or timing: give a brief 3-day example only (e.g. Day 1–3) to illustrate cadence — not a full week breakdown.

${TONE_INSTRUCTIONS}`,
    buildUser: buildUserContext,
  },
  'ftc-checker': {
    maxTokens: MAX_TOKENS_CTX,
    required: [],
    system: `You are an FTC compliance expert specializing in influencer marketing and creator content regulations. Analyze content for FTC compliance issues based on the latest 2026 FTC Endorsement Guides. Score compliance 0-100 and identify specific violations with the exact FTC rule that applies. Provide corrected versions with proper disclosure placement. Include platform-specific guidance since each platform has different disclosure best practices. Be thorough but practical — help creators stay compliant without making it feel overwhelming. Reference real FTC enforcement actions when relevant to illustrate consequences.

${TONE_INSTRUCTIONS}`,
    buildUser: buildUserContext,
  },
  'brand-voice': {
    maxTokens: MAX_TOKENS_CTX,
    required: [],
    system: `You are a brand strategist and copywriting expert specializing in personal brands and creator businesses. Analyze content samples to identify voice characteristics, tone patterns, vocabulary habits, and consistency. Generate actionable brand voice guides that help creators maintain a distinctive, recognizable voice across platforms. Pull specific examples from the content they provide — never give generic advice. Your analysis should feel like it was done by an expensive brand consultant.

${TONE_INSTRUCTIONS}`,
    buildUser: buildUserContext,
  },
  'brand-audit': {
    maxTokens: 2000,
    required: [],
    system: `You are a personal branding strategist with deep expertise in the creator economy. Conduct thorough brand audits analyzing cross-platform consistency, messaging clarity, differentiation, and strategic positioning. Score brands honestly — if something is weak, say so directly with specific fixes. Generate rewritten bios optimized for each platform and 30-day improvement plans with weekly priorities. Your audit should feel like a $500 consultation delivered in minutes. Reference what works in the creator economy in 2026 specifically.

${TONE_INSTRUCTIONS}`,
    buildUser: buildUserContext,
  },
};
TOOL_CONFIG['company-culture-decoder'] = TOOL_CONFIG['culture-decoder'];

// In-memory IP rate limit: { ip: [timestamp, ...] }. Pruned when checked.
const rate_limits = Object.create(null);

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const first = forwarded.split(',')[0];
    if (first) return first.trim();
  }
  return req.headers['x-real-ip'] || req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown';
}

function checkRateLimit(ip) {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  if (!rate_limits[ip]) rate_limits[ip] = [];
  const timestamps = rate_limits[ip].filter((t) => t > cutoff);
  rate_limits[ip] = timestamps;
  if (timestamps.length >= PUBLIC_RATE_LIMIT_PER_DAY) return { allowed: false, remaining: 0 };
  return { allowed: true, remaining: PUBLIC_RATE_LIMIT_PER_DAY - timestamps.length };
}

function recordRequest(ip) {
  if (!rate_limits[ip]) rate_limits[ip] = [];
  rate_limits[ip].push(Date.now());
}

function parseBody(req) {
  if (typeof req.body === 'object' && req.body !== null) return req.body;
  try {
    return typeof req.body === 'string' ? JSON.parse(req.body) : {};
  } catch {
    return {};
  }
}

function validateApiKey(req) {
  const authHeader = req.headers?.authorization || req.headers?.Authorization;
  if (!authHeader || typeof authHeader !== 'string') return false;
  const parts = authHeader.trim().split(/\s+/);
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') return false;
  const key = process.env.PUBLIC_TOOLS_KEY;
  if (!key) return false;
  return parts[1] === key;
}

function firstNonEmpty(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

function stringifyRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return '';
  return JSON.stringify(rows, null, 2);
}

function toContextJobRow(row = {}) {
  return {
    title: row.title ?? null,
    company: row.company ?? null,
    salary_min: row.salary_min ?? null,
    salary_max: row.salary_max ?? null,
    location: row.location ?? null,
  };
}

function buildCappedDataContext(prefix, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return '';
  const raw = `${prefix}${stringifyRows(rows)}\n\n`;
  if (raw.length <= DATA_CONTEXT_CHAR_LIMIT) return raw;
  const keep = Math.max(0, DATA_CONTEXT_CHAR_LIMIT - DATA_CONTEXT_OVERFLOW_SUFFIX.length);
  return `${raw.slice(0, keep)}${DATA_CONTEXT_OVERFLOW_SUFFIX}`;
}

function capImsSystemBlock(text) {
  if (!text) return '';
  if (text.length <= DATA_CONTEXT_CHAR_LIMIT) return text;
  const keep = Math.max(0, DATA_CONTEXT_CHAR_LIMIT - DATA_CONTEXT_OVERFLOW_SUFFIX.length);
  return `${text.slice(0, keep)}${DATA_CONTEXT_OVERFLOW_SUFFIX}`;
}

function capImsSpecialSystemBlock(text) {
  if (!text) return '';
  if (text.length <= IMS_SPECIAL_TOOLS_CONTEXT_LIMIT) return text;
  const suffix = '... (truncated)';
  return `${text.slice(0, IMS_SPECIAL_TOOLS_CONTEXT_LIMIT - suffix.length)}${suffix}`;
}

function toNumSalary(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function sumNumericArr(arr) {
  return arr.reduce((a, b) => a + b, 0);
}

function aggregateSignalFrequencyRows(rows) {
  const list = rows || [];
  const mins = list.map((r) => toNumSalary(r.salary_min)).filter((n) => n != null);
  const maxs = list.map((r) => toNumSalary(r.salary_max)).filter((n) => n != null);
  const times = list
    .map((r) => r.posted_date)
    .filter(Boolean)
    .map((d) => new Date(d).getTime())
    .filter((t) => !Number.isNaN(t));
  return {
    signal_count: list.length,
    avg_salary_min: mins.length ? Math.round(sumNumericArr(mins) / mins.length) : null,
    avg_salary_max: maxs.length ? Math.round(sumNumericArr(maxs) / maxs.length) : null,
    first_seen: times.length ? new Date(Math.min(...times)).toISOString() : null,
    last_seen: times.length ? new Date(Math.max(...times)).toISOString() : null,
  };
}

function aggregateCompanySignalsRows(rows) {
  const list = rows || [];
  const times = list
    .map((r) => r.posted_date)
    .filter(Boolean)
    .map((d) => new Date(d).getTime())
    .filter((t) => !Number.isNaN(t));
  return {
    company_signal_count: list.length,
    first_company_post: times.length ? new Date(Math.min(...times)).toISOString() : null,
    last_company_post: times.length ? new Date(Math.max(...times)).toISOString() : null,
  };
}

function truncateDescriptionText(s, max) {
  const t = String(s ?? '');
  if (t.length <= max) return t;
  return `${t.slice(0, max)}...`;
}

async function fetchArchiveIntelligenceImsContext(body, supabase) {
  const term = sanitizeIlikeTerm(body.job_title);
  const companyTerm = sanitizeIlikeTerm(body.company);
  if (!term || !companyTerm) return '';

  // Query A (exact): rows matching the full title
  // Query B (role family): rows matching any of 2-3 core functional keywords
  //   extracted from the title. Lets Claude distinguish between a rare exact
  //   title and a well-established core function.
  const familyKeywords = extractRoleFamilyKeywords(body.job_title);
  const familyOrClause = familyKeywords
    .map((kw) => `title.ilike.%${kw}%`)
    .join(',');

  const promises = [
    supabase
      .from('jobs')
      .select('salary_min,salary_max,posted_date')
      .eq('source', 'IMS')
      .ilike('title', `%${term}%`),
    supabase
      .from('jobs')
      .select('posted_date')
      .eq('source', 'IMS')
      .ilike('company', `%${companyTerm}%`),
    supabase
      .from('jobs')
      .select('title,company,salary_min,salary_max,location,posted_date,source_url')
      .eq('source', 'IMS')
      .not('description', 'is', null)
      .ilike('title', `%${term}%`)
      .order('posted_date', { ascending: false })
      .limit(5),
  ];

  if (familyOrClause) {
    promises.push(
      supabase
        .from('jobs')
        .select('salary_min,salary_max,posted_date')
        .eq('source', 'IMS')
        .or(familyOrClause)
    );
  }

  const [aRes, bRes, cRes, fRes] = await Promise.all(promises);

  if (aRes.error || bRes.error || cRes.error) return '';
  if (fRes && fRes.error) {
    // role family query is best-effort — fall through with null
  }

  const queryA = aggregateSignalFrequencyRows(aRes.data);
  const queryB = aggregateCompanySignalsRows(bRes.data);
  const queryC = (cRes.data || []).map((r) => ({
    title: r.title,
    company: r.company,
    salary_min: r.salary_min,
    salary_max: r.salary_max,
    location: r.location,
    published_at: r.posted_date,
    url: r.source_url,
  }));

  const familyRows = fRes && !fRes.error ? fRes.data : null;
  const familyAgg = familyRows ? aggregateSignalFrequencyRows(familyRows) : null;
  const queryRoleFamily = familyAgg
    ? {
        keywords: familyKeywords,
        role_family_count: familyAgg.signal_count,
        avg_salary_min: familyAgg.avg_salary_min,
        avg_salary_max: familyAgg.avg_salary_max,
      }
    : {
        keywords: familyKeywords,
        role_family_count: null,
        avg_salary_min: null,
        avg_salary_max: null,
      };

  const payload = {
    exact_signal_count: queryA.signal_count,
    role_family_count: queryRoleFamily.role_family_count,
    company_signal_count: queryB.company_signal_count,
    query_a_signal_frequency: queryA,
    query_role_family: queryRoleFamily,
    query_b_company_signals: queryB,
    query_c_similar_recent_roles: queryC,
  };
  return capImsSpecialSystemBlock(JSON.stringify(payload, null, 2));
}

async function fetchOpportunityDescriptionImsContext(body, supabase) {
  const term = sanitizeIlikeTerm(body.job_title);
  if (!term) return '';

  const [aRes, bRes] = await Promise.all([
    supabase
      .from('jobs')
      .select('salary_min,salary_max')
      .eq('source', 'IMS')
      .not('salary_min', 'is', null)
      .ilike('title', `%${term}%`),
    supabase
      .from('jobs')
      .select('description,posted_date')
      .eq('source', 'IMS')
      .not('description', 'is', null)
      .ilike('title', `%${term}%`)
      .order('posted_date', { ascending: false })
      .limit(8),
  ]);

  if (aRes.error || bRes.error) return '';

  const salRows = aRes.data || [];
  const mins = salRows.map((r) => toNumSalary(r.salary_min)).filter((n) => n != null);
  const maxs = salRows.map((r) => toNumSalary(r.salary_max)).filter((n) => n != null);
  const queryA = {
    avg_salary_min: mins.length ? Math.round(sumNumericArr(mins) / mins.length) : null,
    avg_salary_max: maxs.length ? Math.round(sumNumericArr(maxs) / maxs.length) : null,
    signal_count: salRows.length,
  };

  const descriptions = (bRes.data || []).map((r) => ({
    description: truncateDescriptionText(r.description, 4000),
  }));

  const payload = {
    query_a_salary_benchmarks: queryA,
    query_b_common_requirements_from_descriptions: descriptions,
  };
  return capImsSpecialSystemBlock(JSON.stringify(payload, null, 2));
}

/**
 * Real job rows / aggregates for the 7 core tools — appended to the system prompt (not user message).
 */
async function fetchImsArchiveSystemContext(toolName, body, supabase) {
  if (!supabase) return '';

  try {
    if (toolName === 'archive-intelligence') {
      return await fetchArchiveIntelligenceImsContext(body, supabase);
    }

    if (toolName === 'opportunity-description-generator') {
      return await fetchOpportunityDescriptionImsContext(body, supabase);
    }

    if (toolName === 'cover-letter') {
      const term = sanitizeIlikeTerm(body.job_title);
      if (!term) return '';
      const { data, error } = await supabase
        .from('jobs')
        .select('title,company,description')
        .ilike('title', `%${term}%`)
        .limit(IMS_COVER_LETTER_LIMIT);
      if (error || !data?.length) return '';
      return capImsSystemBlock(stringifyRows(data));
    }

    if (toolName === 'resume-optimize') {
      const term = sanitizeIlikeTerm(
        firstNonEmpty(body.job_title, body.role, body.target_role, body.title) || 'creator'
      );
      if (!term) return '';
      const { data, error } = await supabase
        .from('jobs')
        .select('title,company,description')
        .not('description', 'is', null)
        .ilike('title', `%${term}%`)
        .limit(IMS_RESUME_OPTIMIZE_LIMIT);
      if (error || !data?.length) return '';
      return capImsSystemBlock(stringifyRows(data));
    }

    if (toolName === 'interview-prep') {
      const term = sanitizeIlikeTerm(body.job_title);
      if (!term) return '';
      const { data, error } = await supabase
        .from('jobs')
        .select('title,company,description')
        .not('description', 'is', null)
        .ilike('title', `%${term}%`)
        .limit(IMS_INTERVIEW_PREP_LIMIT);
      if (error || !data?.length) return '';
      return capImsSystemBlock(stringifyRows(data));
    }

    if (toolName === 'salary-negotiate') {
      const term = sanitizeIlikeTerm(body.job_title);
      if (!term) return '';
      const { data, error } = await supabase
        .from('jobs')
        .select('salary_min,salary_max,title,company,location')
        .not('salary_min', 'is', null)
        .ilike('title', `%${term}%`)
        .limit(IMS_SALARY_AGGREGATE_LIMIT);
      if (error || !data?.length) return '';
      const toNum = (v) => {
        if (v == null || v === '') return null;
        const n = typeof v === 'number' ? v : Number(v);
        return Number.isFinite(n) ? n : null;
      };
      const mins = data.map((r) => toNum(r.salary_min)).filter((n) => n != null);
      const maxs = data.map((r) => toNum(r.salary_max)).filter((n) => n != null);
      const sum = (arr) => arr.reduce((a, b) => a + b, 0);
      const stats = {
        row_count: data.length,
        avg_salary_min: mins.length ? Math.round(sum(mins) / mins.length) : null,
        avg_salary_max: maxs.length ? Math.round(sum(maxs) / maxs.length) : null,
        min_salary_min: mins.length ? Math.min(...mins) : null,
        max_salary_max: maxs.length ? Math.max(...maxs) : null,
      };
      const payload = {
        aggregate_salary_stats_from_ims: stats,
        sample_postings: data.slice(0, Math.min(15, data.length)),
      };
      return capImsSystemBlock(JSON.stringify(payload, null, 2));
    }

    if (
      toolName === 'linkedin-outreach' ||
      toolName === 'follow-up-email' ||
      toolName === 'thank-you-note'
    ) {
      const term = sanitizeIlikeTerm(body.company);
      if (!term) return '';
      const { data, error } = await supabase
        .from('jobs')
        .select('title,company,description,location')
        .ilike('company', `%${term}%`)
        .limit(IMS_COMPANY_TOOLS_LIMIT);
      if (error || !data?.length) return '';
      return capImsSystemBlock(stringifyRows(data));
    }
  } catch {
    return '';
  }

  return '';
}

async function fetchToolDataContext(toolName, body, supabase) {
  if (!supabase) return '';

  const extractedTitle = firstNonEmpty(body.extracted_title, body.job_title, body.role, body.target_role, body.title);
  const companyName = firstNonEmpty(body.company_name, body.company);
  const targetRole = firstNonEmpty(body.target_role, body.job_title, body.role, body.title);

  try {
    if (toolName === 'career-quiz') {
      const { data, error } = await supabase
        .from('jobs')
        .select('title,company,salary_min,salary_max,location')
        .not('salary_min', 'is', null)
        .limit(JOB_QUERY_LIMIT);
      if (error || !data?.length) return '';
      const contextRows = data.map(toContextJobRow);
      return buildCappedDataContext(DB_DATA_CONTEXT_PREFIX.careerQuiz, contextRows);
    }

    if (toolName === 'job-analyzer') {
      const keyword = extractedTitle || 'creator';
      const { data, error } = await supabase
        .from('jobs')
        .select('salary_min,salary_max,title,company,location')
        .not('salary_min', 'is', null)
        .ilike('title', `%${keyword}%`)
        .limit(JOB_QUERY_LIMIT);
      if (error || !data?.length) return '';
      const contextRows = data.map(toContextJobRow);
      return buildCappedDataContext(DB_DATA_CONTEXT_PREFIX.jobAnalyzer, contextRows);
    }

    if (toolName === 'culture-decoder' || toolName === 'company-culture-decoder') {
      const keyword = companyName;
      if (!keyword) return '';
      const { data, error } = await supabase
        .from('jobs')
        .select('title,company,salary_min,salary_max,location')
        .ilike('company', `%${keyword}%`)
        .limit(JOB_QUERY_LIMIT);
      if (error || !data?.length) return '';
      const contextRows = data.map(toContextJobRow);
      return buildCappedDataContext(DB_DATA_CONTEXT_PREFIX.cultureDecoder, contextRows);
    }

    if (toolName === 'resume-headline' || toolName === 'linkedin-analyzer') {
      const keyword = targetRole || 'creator';
      const { data, error } = await supabase
        .from('jobs')
        .select('title,company,salary_min,salary_max,location')
        .ilike('title', `%${keyword}%`)
        .limit(JOB_QUERY_LIMIT);
      if (error || !data?.length) return '';
      const contextRows = data.map(toContextJobRow);
      if (!contextRows.length) return '';

      if (toolName === 'linkedin-analyzer') {
        return buildCappedDataContext(DB_DATA_CONTEXT_PREFIX.linkedinAnalyzer, contextRows);
      }
      return buildCappedDataContext(DB_DATA_CONTEXT_PREFIX.resumeHeadline, contextRows);
    }

  } catch {
    return '';
  }

  return '';
}

// Archive-Intelligence-only post-processor. Guarantees the three critical links
// (CREATORVERSED recruiting CTA, IMS archive browse link, influencermarketingsociety.com
// text mentions) are emitted as real clickable anchors with target="_blank",
// regardless of how Claude phrases the surrounding copy. Scoped to tool === 'archive-intelligence'
// at the call site; does not touch any other tool's output.

// Helper for REPLACEMENTS 1 and 2. Case-insensitive scan for any needle phrase,
// then find the containing "block" and replace it wholesale with `replacement`.
// Block boundary rules:
//   - If the needle sits inside a <p>...</p> (nearest preceding <p> has no
//     </p> between it and the needle), the block is that entire <p>...</p>.
//   - Otherwise the block is the containing line, bounded by the nearest
//     preceding and following line breaks (or string boundaries).
// Handles repeated occurrences and is idempotent: if the block already equals
// the replacement, it skips past it.
function replacePhraseBlock(text, needles, replacement) {
  let searchFrom = 0;
  const maxIter = 20;
  for (let i = 0; i < maxIter; i++) {
    const lower = text.toLowerCase();
    let bestIdx = -1;
    for (const n of needles) {
      const idx = lower.indexOf(n.toLowerCase(), searchFrom);
      if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) bestIdx = idx;
    }
    if (bestIdx === -1) break;

    const lastOpenP = lower.lastIndexOf('<p', bestIdx);
    const lastCloseP = lower.lastIndexOf('</p>', bestIdx);
    const insideP = lastOpenP !== -1 && lastOpenP > lastCloseP;

    let blockStart;
    let blockEnd;
    if (insideP) {
      blockStart = lastOpenP;
      const closeP = lower.indexOf('</p>', bestIdx);
      blockEnd = closeP !== -1 ? closeP + 4 : text.length;
    } else {
      const prevNewline = bestIdx === 0 ? -1 : lower.lastIndexOf('\n', bestIdx - 1);
      blockStart = prevNewline >= 0 ? prevNewline + 1 : 0;
      const nextNewline = lower.indexOf('\n', bestIdx);
      blockEnd = nextNewline !== -1 ? nextNewline : text.length;
    }

    const current = text.slice(blockStart, blockEnd);
    if (current === replacement) {
      searchFrom = blockEnd;
      continue;
    }

    text = text.slice(0, blockStart) + replacement + text.slice(blockEnd);
    searchFrom = blockStart + replacement.length;
  }
  return text;
}

function applyArchiveIntelligencePostProcessing(rawOutput) {
  if (!rawOutput || typeof rawOutput !== 'string') return rawOutput;
  let out = rawOutput;

  // REPLACEMENT 1: rewrite the containing block of the
  // "CREATORVERSED handles end-to-end creator economy recruiting" sentence —
  // works whether Claude emits it inside <p>...</p> or as a plain text line.
  const EMPLOYER_CTA_P =
    '<p><em>Need help hiring for this role? <a href="https://www.creatorrecruiting.com" target="_blank">CREATORVERSED handles end-to-end creator economy recruiting</a> — from sourcing and vetting to placement and onboarding.</em></p>';
  out = replacePhraseBlock(
    out,
    ['CREATORVERSED handles end-to-end creator economy recruiting'],
    EMPLOYER_CTA_P
  );

  // REPLACEMENT 2: rewrite the containing block of the IMS archive browse-link
  // phrase — also works with or without surrounding <p> tags.
  const BROWSE_ARCHIVE_P =
    '<p><a href="https://www.influencermarketingsociety.com/jobs/search?jt=+%E2%9A%A0++%5BArchived%5D+No+Longer+Accepting+Applicants&sort=published_at" target="_blank">Browse the full IMS archive →</a></p>';
  out = replacePhraseBlock(
    out,
    ['Browse the full IMS archive', 'Browse for full archive'],
    BROWSE_ARCHIVE_P
  );

  // REPLACEMENT 3 (unchanged): wrap any bare-text "influencermarketingsociety.com"
  // in an anchor with target="_blank". Protect every existing <a>...</a> block
  // first with a placeholder so we never re-wrap already-linked text and never
  // mangle anchors pointing at other URLs on the same domain.
  const savedAnchors = [];
  out = out.replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, (match) => {
    const token = `\u0000IMSA${savedAnchors.length}\u0000`;
    savedAnchors.push(match);
    return token;
  });
  out = out.replace(
    /influencermarketingsociety\.com/gi,
    '<a href="https://www.influencermarketingsociety.com" target="_blank">influencermarketingsociety.com</a>'
  );
  out = out.replace(/\u0000IMSA(\d+)\u0000/g, (_, n) => savedAnchors[Number(n)]);

  return out;
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.setHeader('Content-Type', 'application/json');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  if (!validateApiKey(req)) {
    res.setHeader('Content-Type', 'application/json');
    res.status(401).json({ error: 'Missing or invalid API key. Use Authorization: Bearer <key>.' });
    return;
  }

  const ip = getClientIp(req);
  const { allowed, remaining } = checkRateLimit(ip);
  if (!allowed) {
    res.setHeader('Content-Type', 'application/json');
    res.status(429).json({
      error: 'Rate limit exceeded',
      detail: `${PUBLIC_RATE_LIMIT_PER_DAY} requests per day per IP for anonymous use.`,
    });
    return;
  }

  const body = parseBody(req);
  const toolName = (body.tool || '').trim().toLowerCase();
  const config = TOOL_CONFIG[toolName];

  if (!config) {
    res.setHeader('Content-Type', 'application/json');
    res.status(400).json({
      error: 'Invalid or missing tool',
      allowed: Object.keys(TOOL_CONFIG),
    });
    return;
  }

  for (const key of config.required) {
    const val = body[key];
    if (val === undefined || (typeof val === 'string' && !val.trim())) {
      res.setHeader('Content-Type', 'application/json');
      res.status(400).json({ error: `Missing or empty field: ${key}`, required: config.required });
      return;
    }
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.setHeader('Content-Type', 'application/json');
    res.status(500).json({ error: 'Server misconfiguration: ANTHROPIC_API_KEY not set' });
    return;
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;
  const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

  let userMessage;
  try {
    userMessage = config.buildUser(body);
  } catch (e) {
    res.setHeader('Content-Type', 'application/json');
    res.status(400).json({ error: 'Invalid input', details: e.message });
    return;
  }

  const [imsArchiveContext, dataContext] = await Promise.all([
    fetchImsArchiveSystemContext(toolName, body, supabase),
    fetchToolDataContext(toolName, body, supabase),
  ]);

  let systemPrompt = config.system;
  if (imsArchiveContext) {
    systemPrompt = `${config.system}\n\n${IMS_ARCHIVE_SYSTEM_INTRO}\n${imsArchiveContext}`;
  }

  if (dataContext) {
    userMessage = `${dataContext}${userMessage}`;
  }

  const anthropic = new Anthropic({ apiKey });

  try {
    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: getPublicOutputMaxTokens(toolName),
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    const textBlock = message.content?.find((c) => c.type === 'text');
    const output = textBlock?.text ?? '';
    const inputTokens = message.usage?.input_tokens ?? 0;
    const outputTokens = message.usage?.output_tokens ?? 0;
    const totalTokens = inputTokens + outputTokens;

    // Scoped post-processing: archive-intelligence only. Hardcodes the three
    // critical links so they always render as clickable anchors regardless of
    // Claude's phrasing. No other tool output is modified.
    const finalOutput =
      toolName === 'archive-intelligence'
        ? applyArchiveIntelligencePostProcessing(output)
        : output;

    recordRequest(ip);

    res.setHeader('Content-Type', 'application/json');
    res.status(200).json({
      result: finalOutput,
      tool: toolName,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens, total: totalTokens },
    });
  } catch (err) {
    const isRateLimit = err?.status === 429 || err?.message?.toLowerCase?.().includes('rate');
    res.setHeader('Content-Type', 'application/json');
    res.status(isRateLimit ? 429 : 500).json({
      error: isRateLimit ? 'AI service rate limit' : 'AI request failed',
      details: err?.message || String(err),
    });
  }
};
