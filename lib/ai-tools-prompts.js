/**
 * Shared prompt constants for api/ai-tools.js and api/ai-tools-public.js.
 * Keep TONE_INSTRUCTIONS in sync for both endpoints.
 */

const TONE_INSTRUCTIONS = `Write in a natural, human tone. Avoid generic filler phrases like I hope this finds you well or I am writing to express my interest. Be specific, direct, and conversational while remaining professional. Vary sentence structure and length. Reference specific details the user provided. Never use placeholder brackets like [Your name] or [specific detail] — if information is missing, write around it naturally.

Apply 2026 best practices for this content type. For cover letters: lead with impact, show company research, quantify achievements, keep to 4-5 paragraphs max. For salary negotiation: use anchoring psychology, reference market data confidently, provide specific scripts. For outreach messages: personalize the first line, adapt tone and length to the specific platform. For interview prep: include behavioral and situational questions, use STAR framework for answers. For resumes: prioritize ATS optimization with keyword matching. Never sign off with placeholder brackets like [Your name] — either omit the signature entirely or use a natural unsigned closing.`;

module.exports = { TONE_INSTRUCTIONS };
