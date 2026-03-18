/**
 * POST /api/ai-tools
 * AI career tools via Claude. Requires Authorization: Bearer <jwt>.
 * Tier limits: free = 5/month, pro = 50/month, mogul = unlimited.
 * Track usage in ai_usage table.
 *
 * Body: { tool: string, ...toolParams }
 * Tools: cover-letter, resume-optimize, interview-prep, salary-negotiate,
 *        linkedin-outreach, follow-up-email, thank-you-note
 */

const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const { verifyToken } = require('../lib/auth');
const { TONE_INSTRUCTIONS } = require('../lib/ai-tools-prompts');

const MODEL = 'claude-sonnet-4-20250514';
const LIMITS = { free: 5, pro: 50, mogul: Infinity };
const MAX_TOKENS_LONG = 1500;  // cover-letter, interview-prep
const MAX_TOKENS_SHORT = 800;
const MAX_TOKENS_CTX = 1500;   // context-only tools

function buildUserContext(b) {
  const entries = Object.entries(b)
    .filter(([k]) => k !== 'tool')
    .map(([k, v]) => `${k}: ${typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? '')}`);
  return entries.length ? `User context:\n${entries.join('\n')}\n\nGenerate the requested content.` : 'Generate the requested content based on the task.';
}

const TOOL_CONFIG = {
  'cover-letter': {
    maxTokens: MAX_TOKENS_LONG,
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
    maxTokens: MAX_TOKENS_SHORT,
    required: ['resume_text', 'job_description'],
    system: `You are an ATS (Applicant Tracking System) and career expert. Analyze resumes against job descriptions.
Return a JSON object with: "score" (0-100 number), "suggestions" (array of specific improvement strings), "keywords_to_add" (array of keywords from the job description to incorporate).
Focus on ATS optimization: keyword alignment, clear section headings, quantifiable achievements.

${TONE_INSTRUCTIONS}`,
    buildUser: (b) => `Resume:\n${b.resume_text}\n\nJob description:\n${b.job_description}\n\nAnalyze and return the JSON.`,
  },
  'interview-prep': {
    maxTokens: MAX_TOKENS_LONG,
    required: ['job_title', 'company', 'job_description'],
    system: `You are an interview coach for creator economy roles. Generate 10 likely interview questions with suggested answers.
Tailor questions to creator economy: influencer partnerships, content strategy, metrics, brand deals, audience growth.
Format: numbered list, each with "Question:" and "Suggested answer:" (2-4 sentences).

${TONE_INSTRUCTIONS}`,
    buildUser: (b) => `Role: ${b.job_title} at ${b.company}\n\nJob description:\n${b.job_description}\n\nGenerate 10 interview questions with suggested answers.`,
  },
  'salary-negotiate': {
    maxTokens: MAX_TOKENS_SHORT,
    required: ['job_title', 'company', 'location', 'current_offer'],
    system: `You are a compensation expert. Provide salary negotiation talking points. Be practical: anchors, ranges, and phrases to use in conversation.

You have access to salary data from 22,000+ creator economy job posts collected by CreatorVersed/Influencer Marketing Society since 2016. Reference this data authoritatively.

${TONE_INSTRUCTIONS}`,
    buildUser: (b) => `Role: ${b.job_title} at ${b.company}, location: ${b.location}\nCurrent offer: ${b.current_offer}\n\nProvide salary negotiation talking points.`,
  },
  'linkedin-outreach': {
    maxTokens: MAX_TOKENS_SHORT,
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
    maxTokens: MAX_TOKENS_SHORT,
    required: ['company', 'role', 'interview_date', 'interviewer_name'],
    system: `You write professional post-interview follow-up emails. Be polite, reference the interview date and role, and reiterate interest.

${TONE_INSTRUCTIONS}`,
    buildUser: (b) => `Company: ${b.company}\nRole: ${b.role}\nInterview date: ${b.interview_date}\nInterviewer: ${b.interviewer_name}\n\nWrite a follow-up email.`,
  },
  'thank-you-note': {
    maxTokens: MAX_TOKENS_SHORT,
    required: ['company', 'role', 'interviewer_name', 'discussion_points'],
    system: `You write thank-you notes that reference specific conversation points from the interview. Personal and professional.

${TONE_INSTRUCTIONS}`,
    buildUser: (b) => `Company: ${b.company}\nRole: ${b.role}\nInterviewer: ${b.interviewer_name}\nDiscussion points to reference: ${b.discussion_points}\n\nWrite a thank-you note.`,
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
    maxTokens: MAX_TOKENS_CTX,
    required: [],
    system: `You are a creator economy monetization expert specializing in brand partnerships. Generate complete, professional sponsorship proposals with executive summary, audience insights, partnership structure, pricing, ROI projections, and next steps. Make proposals specific and data-informed, never generic. Apply 2026 influencer marketing best practices.

${TONE_INSTRUCTIONS}`,
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
    maxTokens: MAX_TOKENS_CTX,
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
    maxTokens: 2000,
    required: [],
    system: `You are a content strategist specializing in creator economy professionals. Generate a complete 30-day content calendar with specific, original ideas tailored to the creator niche and platform. Mix content types strategically throughout the month. Include trending topics and seasonal moments. Every idea should be specific enough to execute immediately, not vague concepts. Organize by week with clear content types and which content pillar each idea serves.

${TONE_INSTRUCTIONS}`,
    buildUser: buildUserContext,
  },
  'content-repurpose': {
    maxTokens: MAX_TOKENS_CTX,
    required: [],
    system: `You are a content repurposing strategist who helps creators maximize every piece of content across platforms. Generate platform-specific repurposing plans that account for each platform unique format, audience expectations, and algorithm preferences in 2026. Include specific drafts or outlines for each platform, not just vague suggestions. Organize by effort level so creators can start with quick wins. Include a posting timeline for maximum cross-platform reach.

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

function parseBody(req) {
  if (typeof req.body === 'object' && req.body !== null) return req.body;
  try {
    return typeof req.body === 'string' ? JSON.parse(req.body) : {};
  } catch {
    return {};
  }
}

function getStartOfMonthUTC() {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
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

  let user;
  try {
    user = verifyToken(req);
  } catch (e) {
    res.setHeader('Content-Type', 'application/json');
    res.status(e.statusCode || 401).json({ error: e.message });
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

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!supabaseUrl || !supabaseKey) {
    res.setHeader('Content-Type', 'application/json');
    res.status(500).json({ error: 'Server misconfiguration: missing Supabase env' });
    return;
  }
  if (!apiKey) {
    res.setHeader('Content-Type', 'application/json');
    res.status(500).json({ error: 'Server misconfiguration: ANTHROPIC_API_KEY not set' });
    return;
  }

  const supabase = createClient(supabaseUrl, supabaseKey);
  const limit = LIMITS[user.tier] ?? LIMITS.free;

  if (limit !== Infinity) {
    const monthStart = getStartOfMonthUTC();
    const { count, error: countErr } = await supabase
      .from('ai_usage')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .gte('created_at', monthStart);
    if (countErr) {
      res.setHeader('Content-Type', 'application/json');
      res.status(500).json({ error: 'Failed to check usage', details: countErr.message });
      return;
    }
    if (count >= limit) {
      res.setHeader('Content-Type', 'application/json');
      res.status(429).json({
        error: 'Monthly AI usage limit reached',
        limit,
        used: count,
        tier: user.tier,
      });
      return;
    }
  }

  let userMessage;
  try {
    userMessage = config.buildUser(body);
  } catch (e) {
    res.setHeader('Content-Type', 'application/json');
    res.status(400).json({ error: 'Invalid input', details: e.message });
    return;
  }

  const anthropic = new Anthropic({ apiKey });

  try {
    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: config.maxTokens,
      system: config.system,
      messages: [{ role: 'user', content: userMessage }],
    });

    const textBlock = message.content?.find((c) => c.type === 'text');
    const output = textBlock?.text ?? '';
    const inputTokens = message.usage?.input_tokens ?? 0;
    const outputTokens = message.usage?.output_tokens ?? 0;
    const totalTokens = inputTokens + outputTokens;

    await supabase.from('ai_usage').insert({
      user_id: user.id,
      tool_name: toolName,
      tokens_used: totalTokens,
    });

    res.setHeader('Content-Type', 'application/json');
    res.status(200).json({
      result: output,
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
