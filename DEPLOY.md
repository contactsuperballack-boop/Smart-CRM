# Smart CRM: Deployment Checklist (pilot-ready)

## What runs where
| Process | Entry | Port | Notes |
|---|---|---|---|
| API | `api.ts` | 3000 | REST + Gmail OAuth routes |
| Inbound webhook | `inbound-webhook.ts` | 3001 | Postmark posts replies here |
| Worker | `worker.ts` | none | reply classifier + hourly follow-up scheduler; run exactly 1 copy |
| Postgres 15+, Redis | managed | | Redis backs BullMQ |

Build as ESM (`"type": "module"`, TS target ES2022, NodeNext) because `api.ts` and `worker.ts` use top-level `await`.
Dependencies: `fastify @fastify/cors @fastify/rate-limit pg zod bullmq googleapis @anthropic-ai/sdk` plus your auth provider's SDK.

## 1. Hosting layout
- [ ] **Vercel** hosts the UI (`web/`) at `app.yourdomain.com`; `web/vercel.json` rewrites `/api/*` to the backend, so the browser sees one origin
- [ ] **Railway/Render/Fly** hosts the API, inbound webhook and worker (they need long-running processes, which Vercel's serverless model doesn't give you), at `api.yourdomain.com`
- [ ] `reply.yourdomain.com` carries inbound mail only (MX record, no web hosting)
- [ ] Postmark posts straight to the backend (`https://USER:PASS@api.yourdomain.com/webhooks/inbound-email`), not through Vercel
- [ ] Google redirect URI = `https://app.yourdomain.com/api/oauth/google/callback`

## 2. Database
- [ ] Create the DB and the restricted role: `CREATE ROLE crm_app LOGIN PASSWORD '...' NOSUPERUSER NOBYPASSRLS;`
- [ ] As the owner role: run `schema.sql`, then `migrations-002.sql`, then `migrations-003.sql`.
- [ ] Confirm the app connects as `crm_app` (not the owner). Row-level security does nothing for the table owner.
- [ ] Turn on automated backups and point-in-time recovery, and do one test restore.
- [ ] **Seed the first user** (there is no signup flow yet):
  ```sql
  WITH w AS (INSERT INTO workspaces (name, timezone) VALUES ('Pilot Agency', 'America/New_York') RETURNING id)
  INSERT INTO users (workspace_id, auth_id, email, role)
  SELECT id, '<auth provider user id>', 'you@example.com', 'owner' FROM w;
  ```

## 3. Secrets (`.env.example` lists all of them)
- [ ] `openssl rand -hex 32` for `STATE_SECRET`; `openssl rand -base64 32` for `TOKEN_KEY`; `openssl rand -hex 24` for `INBOUND_PASS`
- [ ] Store them in your host's secret manager. Back up `TOKEN_KEY` separately: lose it and every connected Gmail must reconnect.

## 4. Google Cloud
- [ ] New project, OAuth consent screen (External), scope `gmail.send` plus `openid` and `email`
- [ ] Authorized redirect URI = `GOOGLE_REDIRECT_URI`, exactly
- [ ] While in Testing, add each pilot user as a test user (refresh tokens expire after 7 days in Testing)
- [ ] Start verification now using `verification/google-submission.md` (homepage `/welcome`, `/privacy`, `/terms` are in `web/`; fill every [PLACEHOLDER] first)

## 5. Postmark
- [ ] Server with an inbound stream; Inbound Domain = `reply.yourdomain.com`
- [ ] DNS: `MX reply -> inbound.postmarkapp.com` priority 10 (never on the root domain)
- [ ] Inbound webhook = `https://INBOUND_USER:INBOUND_PASS@api.yourdomain.com/webhooks/inbound-email`

## 6. Deploy
- [ ] Deploy API, inbound webhook and one worker. Add a `GET /health` route to each, registered before the auth hook in `api.ts`.
- [ ] Run the worker as a single instance (the scheduler also has a per-workspace lock as a safety net)
- [ ] Set up error tracking (Sentry or similar). Make sure logs never contain email bodies or tokens.

## 7. Go-live test (do all of it before any pilot)
1. Sign in; the profile screen loads
2. Create a profile; note its `reply_token` from the DB
3. Connect Gmail with a test account; the card shows the address
4. Email `b_<token>@reply.yourdomain.com` from another account; the row appears in `unassigned_replies`
5. Add a lead (your second email address); Generate Email; Approve & Send; it arrives with the right From and Reply-To, and the lead becomes Contacted
6. Reply to it; within a minute the reply shows on the lead's timeline with a classification and a suggested response
7. Reply "unsubscribe" to a second test lead; it flags unsubscribed and sending is blocked
8. Revoke the app at myaccount.google.com/permissions, then try sending; the profile shows "needs to be reconnected"
9. Backdate a sent email by 4 days in the DB, then trigger the scheduler; a task and a draft appear
10. With a second workspace, confirm you cannot read the first one's leads through the API
11. Account deletion: on a throwaway workspace, use Delete account with the exact workspace name. Confirm every table has zero rows for it (the cascade must work under row-level security), `deletion_log` has one row, Google's permissions page no longer lists the app, and the old login is signed out
12. Provider copies: check Postmark's message retention and align it with the privacy policy's retention line

## 8. Before real pilots
- [ ] Terms, privacy policy, and a consent line for leads' emails (CAN-SPAM/GDPR)
- [ ] A daily per-inbox send cap (Gmail limits, and deliverability)
- [ ] Tell pilots about the "unverified app" screen until Google verification completes

## Known gaps
No signup or invite flow, no health routes yet, no Outlook, no per-user send caps, no pause control on follow-ups, no import endpoint, and cold-lead status after the third unanswered follow-up.
