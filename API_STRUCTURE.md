# OppFlo API structure (Vercel)

Vercel serves each file under `api/` as a serverless function at the matching URL path.

## Current layout

```
api/
├── health.js          → GET  /api/health
├── jobs.js            → GET  /api/jobs
├── applications.js    → GET/POST/PATCH/DELETE  /api/applications
├── ai-tools.js        → POST /api/ai-tools
├── check-tier.js      → GET  /api/check-tier
├── user.js            → GET/PATCH /api/user
├── auth/
│   ├── send-magic-link.js  → POST /api/auth/send-magic-link
│   └── verify.js           → POST /api/auth/verify
├── user/
│   └── streak.js      → GET  /api/user/streak
└── webhooks/
    └── beehiiv.js     → POST /api/webhooks/beehiiv
```

## Fix applied

- **Removed** custom `builds` and `routes` from `vercel.json`.
- Vercel now uses **default detection**: any `api/**/*.js` is automatically deployed as a serverless function at `/api/...`.
- **Kept** only the `headers` section in `vercel.json` for CORS on `/api/*`.

After redeploying, `/api/health` should respond correctly.
