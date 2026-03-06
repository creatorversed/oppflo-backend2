/**
 * Shared auth utilities for OppFlo API.
 * Use verifyToken(req) in protected routes to get the current user.
 */

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

/**
 * Extracts and verifies the JWT from the Authorization header (Bearer token).
 * @param {object} req - The request object (must have req.headers or req.headers.authorization)
 * @returns {{ id: string, email: string, tier: string }} Decoded user payload
 * @throws {Error} If no token, invalid token, or verification fails
 */
function verifyToken(req) {
  if (!JWT_SECRET) {
    const err = new Error('Server misconfiguration: JWT_SECRET not set');
    err.statusCode = 500;
    throw err;
  }
  const authHeader = req.headers?.authorization || req.headers?.Authorization;
  if (!authHeader || typeof authHeader !== 'string') {
    const err = new Error('Missing or invalid Authorization header');
    err.statusCode = 401;
    throw err;
  }
  const parts = authHeader.trim().split(/\s+/);
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
    const err = new Error('Authorization must be Bearer <token>');
    err.statusCode = 401;
    throw err;
  }
  const token = parts[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (!decoded.id || !decoded.email) {
      const err = new Error('Invalid token payload');
      err.statusCode = 401;
      throw err;
    }
    return {
      id: decoded.id,
      email: decoded.email,
      tier: decoded.tier || 'free',
    };
  } catch (e) {
    if (e.statusCode) throw e;
    const err = new Error('Invalid or expired token');
    err.statusCode = 401;
    throw err;
  }
}

module.exports = { verifyToken };
