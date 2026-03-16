/**
 * POST /api/ai-tools-public
 * Same 7 AI career tools as /api/ai-tools, but for anonymous use.
 * Auth: Authorization: Bearer <PUBLIC_TOOLS_KEY>. Rate limit: 3 requests per day per IP (in-memory).
 *
 * Body: { tool: string, ...toolParams }
 * Tools: cover-letter, resume-optimize, interview-prep, salary-negotiate,
 *        linkedin-outreach, follow-up-email, thank-you-note
 */

const Anthropic = require('@anthropic-ai/sdk');
const { TONE_INSTRUCTIONS } = require('../lib/ai-tools-prompts');

const MODEL = 'claude-sonnet-4-20250514';
const PUBLIC_RATE_LIMIT_PER_DAY = 3;
const RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_TOKENS_CTX = 1500;

function buildUserContext(b) {
  const entries = Object.entries(b)
    .filter(([k]) => k !== 'tool')
    .map(([k, v]) => `${k}: ${typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? '')}`);
  return entries.length ? `User context:\n${entries.join('\n')}\n\nGenerate the requested content.` : 'Generate the requested content based on the task.';
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

${TONE_INSTRUCTIONS}`,
    buildUser: (b) => `Company: ${b.company}\nRole: ${b.role}\nInterview date: ${b.interview_date}\nInterviewer: ${b.interviewer_name}\n\nWrite a follow-up email.`,
  },
  'thank-you-note': {
    maxTokens: 800,
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
};

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

    recordRequest(ip);

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
