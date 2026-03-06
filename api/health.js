/**
 * Health check endpoint for OppFlo backend.
 * GET /api/health
 */

module.exports = (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.status(200).json({
    status: 'ok',
    version: '1.0.0',
  });
};
