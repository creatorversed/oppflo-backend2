# OppFlo API structure (Vercel)

Vercel serves each file under `api/` as a serverless function at the matching URL path.

## Current layout

Hobby plan limit: **12** serverless functions. Auth routes are merged into one dynamic function.

```
api/
├── health.js              → GET  /api/health
├── check-tier.js          → GET  /api/check-tier
├── benchmark.js           → GET  /api/benchmark
├── talent.js              → GET/POST /api/talent?action=...
├── jobs.js                → GET  /api/jobs
├── applications.js        → GET/POST/PATCH/DELETE  /api/applications
├── user.js                → GET/PATCH /api/user, GET /api/user/streak
├── ai-tools.js            → POST /api/ai-tools
├── ai-tools-public.js     → POST /api/ai-tools-public
├── cron-enrich.js         → GET/POST /api/cron-enrich
├── auth/
│   └── [[...slug]].js     → POST /api/auth/verify, POST /api/auth/send-magic-link
└── webhooks/
    └── beehiiv.js         → POST /api/webhooks/beehiiv
```

Shared auth logic lives in `lib/api-auth-handlers.js` (not a serverless entry).

## Fix applied

- **Removed** custom `builds` and `routes` from `vercel.json`.
- Vercel now uses **default detection**: any `api/**/*.js` is automatically deployed as a serverless function at `/api/...`.
- **Kept** only the `headers` section in `vercel.json` for CORS on `/api/*`.

After redeploying, `/api/health` should respond correctly.
