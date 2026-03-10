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

const MODEL = 'claude-sonnet-4-20250514';
const LIMITS = { free: 5, pro: 50, mogul: Infinity };
const MAX_TOKENS_LONG = 1500;  // cover-letter, interview-prep
const MAX_TOKENS_SHORT = 800;

const TONE_INSTRUCTIONS = `Write in a natural, human tone. Avoid generic filler phrases like I hope this finds you well or I am writing to express my interest. Be specific, direct, and conversational while remaining professional. Vary sentence structure and length. Reference specific details the user provided. Never use placeholder brackets like [Your name] or [specific detail] — if information is missing, write around it naturally.`;

const TOOL_CONFIG = {
  'cover-letter': {
    maxTokens: MAX_TOKENS_LONG,
    required: ['job_title', 'company', 'job_description', 'user_background'],
    system: `You are an expert career coach for the creator economy. Write personalized cover letters that:
- Use creator economy language (influencer marketing, brand partnerships, content strategy, audience growth, engagement metrics)
- Emphasize digital-first experience and quantifiable social media metrics (followers, engagement rates, campaign ROI)
- Sound professional but authentic and specific to the role and company

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
    system: `You write LinkedIn outreach messages. For connection requests keep the message under 300 characters.
For InMail you can write longer. Specify which format you're writing. Be personalized, concise, and professional.

${TONE_INSTRUCTIONS}`,
    buildUser: (b) => `Recipient: ${b.recipient_name} (${b.recipient_role}) at ${b.company}\nPurpose: ${b.purpose}\n\nWrite a connection request (under 300 characters) and optionally a longer InMail version.`,
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
