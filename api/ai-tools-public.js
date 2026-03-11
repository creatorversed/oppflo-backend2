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

const MODEL = 'claude-sonnet-4-20250514';
const PUBLIC_RATE_LIMIT_PER_DAY = 3;
const RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

const TONE_INSTRUCTIONS = `Write in a natural, human tone. Avoid generic filler phrases like I hope this finds you well or I am writing to express my interest. Be specific, direct, and conversational while remaining professional. Vary sentence structure and length. Reference specific details the user provided. Never use placeholder brackets like [Your name] or [specific detail] — if information is missing, write around it naturally.`;

const TOOL_CONFIG = {
  'cover-letter': {
    maxTokens: 1500,
    required: ['job_title', 'company', 'job_description', 'user_background'],
    system: `You are an expert career coach for the creator economy. Write personalized cover letters that:
- Use creator economy language (influencer marketing, brand partnerships, content strategy, audience growth, engagement metrics)
- Emphasize digital-first experience and quantifiable social media metrics (followers, engagement rates, campaign ROI)
- Sound professional but authentic and specific to the role and company

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
    system: `You write LinkedIn outreach messages. For connection requests keep the message under 300 characters.
For InMail you can write longer. Specify which format you're writing. Be personalized, concise, and professional.

${TONE_INSTRUCTIONS}`,
    buildUser: (b) => `Recipient: ${b.recipient_name} (${b.recipient_role}) at ${b.company}\nPurpose: ${b.purpose}\n\nWrite a connection request (under 300 characters) and optionally a longer InMail version.`,
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
