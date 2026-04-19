/**
 * POST /api/auth/verify
 * POST /api/auth/send-magic-link
 *
 * Single serverless function (dynamic route) — replaces separate verify.js + send-magic-link.js
 * for Vercel Hobby function count limits. Paths are unchanged.
 */

const { handleVerify, handleSendMagicLink } = require('../../lib/api-auth-handlers');

function authSubpath(req) {
  const raw = req.url || '/';
  const path = raw.split('?')[0];
  const m = path.match(/^\/api\/auth\/(.+)$/);
  return m ? m[1].replace(/\/$/, '') : '';
}

module.exports = async (req, res) => {
  const sub = authSubpath(req);

  if (sub === 'verify') {
    return handleVerify(req, res);
  }
  if (sub === 'send-magic-link') {
    return handleSendMagicLink(req, res);
  }

  res.setHeader('Content-Type', 'application/json');
  res.status(404).json({ error: 'Not found' });
};
