# Smart CRM

AI-assisted CRM for small agencies: drafts follow-ups, sends from the user's Gmail, detects replies, suggests next steps.

```
backend/   API, inbound-email webhook, background worker (Node + TypeScript, Postgres, Redis)
  src/     api.ts · inbound-webhook.ts · worker.ts · send-and-classify.ts · follow-up-scheduler.ts · gmail-oauth.ts
  db/      schema.sql, then migrations-002.sql
web/       index.html (the UI) + vercel.json (proxies /api to the backend)
DEPLOY.md  full deployment and go-live checklist
```

Setup: see DEPLOY.md. Never commit real secrets; copy `backend/.env.example` to `.env` locally.
