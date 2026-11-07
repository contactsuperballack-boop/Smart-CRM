/**
 * Sprint 2 REST API (Fastify + pg + zod): profiles, leads, tasks, AI suggestions, export.
 * npm i fastify @fastify/cors @fastify/rate-limit pg zod @anthropic-ai/sdk
 *
 * Tenant isolation: every query runs inside withTenant(), which sets app.workspace_id for RLS.
 * RLS only protects you if the app connects as a role that is NOT the table owner and NOT a superuser.
 * Enable RLS on every tenant table, e.g.:
 *   DO $$ DECLARE t text; BEGIN
 *     FOREACH t IN ARRAY ARRAY['business_profiles','email_accounts','leads','interactions','ai_suggestions','tasks']
 *     LOOP EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
 *          EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (workspace_id = current_setting(''app.workspace_id'')::uuid)', t);
 *     END LOOP; END $$;
 * (Drop the earlier single-table policy on leads first if it exists.)
 */
import Fastify, { FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { Pool, PoolClient } from "pg";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { sendApproved } from "./send-and-classify";   // tip: move the Worker in that file to its own entrypoint
import { registerGmailOAuth } from "./gmail-oauth";
import { registerAccountDeletion } from "./account-deletion";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const anthropic = new Anthropic();
const MODEL = process.env.DRAFT_MODEL ?? "claude-sonnet-5-5";
const STAGES = ["new", "contacted", "interested", "proposal_sent", "closed"] as const;

// ---------- Auth (stub): verify the JWT from your provider and map it to a user row ----------
declare function verifyToken(token: string): Promise<{ authId: string }>;
async function auth(req: FastifyRequest) {
  const token = req.headers.authorization?.replace(/^Bearer /, "");
  if (!token) throw { statusCode: 401, message: "Missing token" };
  const { authId } = await verifyToken(token);
  const u = await pool.query("SELECT id, workspace_id FROM users WHERE auth_id = $1", [authId]);
  if (!u.rowCount) throw { statusCode: 403, message: "Unknown user" };
  (req as any).ctx = { userId: u.rows[0].id as string, wsId: u.rows[0].workspace_id as string };
}
const ctx = (req: FastifyRequest) => (req as any).ctx as { userId: string; wsId: string };

async function withTenant<T>(wsId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.workspace_id', $1, true)", [wsId]);
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; }
  finally { c.release(); }
}
const notFound = () => ({ statusCode: 404, message: "Not found" });

// ---------- Schemas ----------
const Stage = z.enum(STAGES);
const ProfileIn = z.object({
  name: z.string().min(1).max(200), description: z.string().max(2000).optional(),
  services: z.string().max(2000).optional(), website_url: z.string().url().max(500).optional().or(z.literal("")),
  tone_notes: z.string().max(500).optional(),
});
const LeadIn = z.object({
  business_profile_id: z.string().uuid(), full_name: z.string().min(1).max(200), email: z.string().email().max(320),
  phone: z.string().max(50).optional(), company: z.string().max(200).optional(),
  notes: z.string().max(5000).optional(), stage: Stage.default("new"), source: z.string().max(100).optional(),
});
const LeadPatch = LeadIn.omit({ business_profile_id: true }).partial();

const app = Fastify({ logger: true });
await app.register(cors, { origin: process.env.APP_ORIGIN ?? false });
await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
registerGmailOAuth(app, { auth, ctx, withTenant });   // must come BEFORE the global hook: the callback has no bearer token
app.addHook("preHandler", auth);
app.setErrorHandler((err: any, _req, reply) => {
  if (err instanceof z.ZodError) return reply.code(400).send({ error: "Invalid input", issues: err.issues });
  if (err.code === "23505") return reply.code(409).send({ error: "Already exists" });   // unique violation
  const code = err.statusCode ?? 500;
  if (code >= 500) app.log.error(err);
  reply.code(code).send({ error: code >= 500 ? "Server error" : err.message });
});

// ---------- Profiles ----------
app.get("/profiles", async (req) => withTenant(ctx(req).wsId, async (c) =>
  (await c.query("SELECT * FROM business_profiles ORDER BY created_at")).rows));

app.post("/profiles", async (req) => {
  const b = ProfileIn.parse(req.body), { wsId } = ctx(req);
  const token = randomBytes(6).toString("hex");                 // tracking-address token, e.g. b_<token>@reply.yourdomain.com
  return withTenant(wsId, async (c) => (await c.query(
    `INSERT INTO business_profiles (workspace_id, name, description, services, website_url, tone_notes, reply_token)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [wsId, b.name, b.description, b.services, b.website_url || null, b.tone_notes, token])).rows[0]);
});

app.patch("/profiles/:id", async (req) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(req.params), b = ProfileIn.partial().parse(req.body);
  return withTenant(ctx(req).wsId, async (c) => {
    const r = await c.query(
      `UPDATE business_profiles SET name = COALESCE($2,name), description = COALESCE($3,description),
         services = COALESCE($4,services), website_url = COALESCE($5,website_url), tone_notes = COALESCE($6,tone_notes)
       WHERE id = $1 RETURNING *`, [id, b.name, b.description, b.services, b.website_url, b.tone_notes]);
    if (!r.rowCount) throw notFound();
    return r.rows[0];
  });
});

// ---------- Leads ----------
app.get("/leads", async (req) => {
  const q = z.object({
    profile_id: z.string().uuid(), stage: Stage.optional(), q: z.string().max(100).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0),
  }).parse(req.query);
  return withTenant(ctx(req).wsId, async (c) => {
    const rows = await c.query(
      `SELECT id, full_name, email, phone, company, stage, created_at, last_activity_at, unsubscribed, bounced,
              count(*) OVER() AS total
       FROM leads WHERE business_profile_id = $1
         AND ($2::text IS NULL OR stage = $2)
         AND ($3::text IS NULL OR full_name ILIKE '%'||$3||'%' OR email ILIKE '%'||$3||'%' OR company ILIKE '%'||$3||'%')
       ORDER BY created_at DESC LIMIT $4 OFFSET $5`,
      [q.profile_id, q.stage ?? null, q.q ?? null, q.limit, q.offset]);
    return { total: Number(rows.rows[0]?.total ?? 0), items: rows.rows.map(({ total, ...r }) => r) };
  });
});

app.post("/leads", async (req, reply) => {
  const b = LeadIn.parse(req.body), { wsId, userId } = ctx(req);
  const lead = await withTenant(wsId, async (c) => (await c.query(
    `INSERT INTO leads (workspace_id, business_profile_id, owner_id, full_name, email, phone, company, notes, stage, source)
     VALUES ($1,$2,$3,$4,lower($5),$6,$7,$8,$9,$10) RETURNING *`,
    [wsId, b.business_profile_id, userId, b.full_name, b.email, b.phone, b.company, b.notes, b.stage, b.source])).rows[0]);
  reply.code(201); return lead;
});

app.get("/leads/:id", async (req) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
  return withTenant(ctx(req).wsId, async (c) => {
    const l = await c.query("SELECT * FROM leads WHERE id = $1", [id]);
    if (!l.rowCount) throw notFound();
    const [timeline, sugg, tasks] = await Promise.all([
      c.query("SELECT id, kind, subject, body, classification, occurred_at FROM interactions WHERE lead_id = $1 ORDER BY occurred_at DESC LIMIT 100", [id]),
      c.query("SELECT id, kind, content, confidence, created_at FROM ai_suggestions WHERE lead_id = $1 AND outcome = 'pending' ORDER BY created_at DESC", [id]),
      c.query("SELECT id, title, due_at, done_at, suggestion_id FROM tasks WHERE lead_id = $1 AND done_at IS NULL ORDER BY due_at", [id]),
    ]);
    return { ...l.rows[0], timeline: timeline.rows, suggestions: sugg.rows, open_tasks: tasks.rows };
  });
});

app.patch("/leads/:id", async (req) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(req.params), b = LeadPatch.parse(req.body);
  return withTenant(ctx(req).wsId, async (c) => {
    const old = await c.query("SELECT stage FROM leads WHERE id = $1 FOR UPDATE", [id]);
    if (!old.rowCount) throw notFound();
    const r = await c.query(
      `UPDATE leads SET full_name = COALESCE($2,full_name), email = COALESCE(lower($3),email), phone = COALESCE($4,phone),
         company = COALESCE($5,company), notes = COALESCE($6,notes), stage = COALESCE($7,stage), source = COALESCE($8,source)
       WHERE id = $1 RETURNING *`, [id, b.full_name, b.email, b.phone, b.company, b.notes, b.stage, b.source]);
    if (b.stage && b.stage !== old.rows[0].stage) {          // keep the timeline honest
      await c.query(`INSERT INTO interactions (workspace_id, lead_id, kind, body)
                     SELECT workspace_id, id, 'stage_change', $2 FROM leads WHERE id = $1`,
        [id, `${old.rows[0].stage} → ${b.stage}`]);
    }
    return r.rows[0];
  });
});

app.delete("/leads/:id", async (req, reply) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
  await withTenant(ctx(req).wsId, async (c) => {
    if (!(await c.query("DELETE FROM leads WHERE id = $1", [id])).rowCount) throw notFound();
  });
  reply.code(204).send();
});

// ---------- AI draft + send (human approval is the send step) ----------
app.post("/leads/:id/draft", async (req) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(req.params), { wsId } = ctx(req);
  const d = await withTenant(wsId, async (c) => (await c.query(
    `SELECT l.full_name, l.company, l.notes, l.stage, bp.name AS biz, bp.description, bp.services, bp.website_url, bp.tone_notes
     FROM leads l JOIN business_profiles bp ON bp.id = l.business_profile_id WHERE l.id = $1`, [id])).rows[0]);
  if (!d) throw notFound();
  const msg = await anthropic.messages.create({
    model: MODEL, max_tokens: 600,
    system: "Write a concise, natural sales email (under 150 words). Begin with 'Subject: ...', a blank line, then the body, signed with the business name. " +
      "Tailor to the stage: new=intro, contacted=follow-up, interested=propose a call, proposal_sent=check in, closed=thank you. Never invent facts.",
    messages: [{ role: "user", content:
      `Business: ${d.biz}. ${d.description}\nServices: ${d.services}\nLink: ${d.website_url ?? ""}\nTone: ${d.tone_notes ?? "friendly, professional"}\n` +
      `Lead: ${d.full_name}${d.company ? " at " + d.company : ""}\nNotes: ${d.notes ?? ""}\nStage: ${d.stage}` }],
  });
  const content = msg.content.map((b: any) => (b.type === "text" ? b.text : "")).join("").trim();
  return withTenant(wsId, async (c) => (await c.query(
    `INSERT INTO ai_suggestions (workspace_id, lead_id, kind, content, model) VALUES ($1,$2,'draft_email',$3,$4)
     RETURNING id, content`, [wsId, id, content, MODEL])).rows[0]);
});

app.post("/leads/:id/send", async (req) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
  const b = z.object({ suggestion_id: z.string().uuid(), subject: z.string().min(1).max(300), body: z.string().min(1).max(20000) }).parse(req.body);
  const { wsId, userId } = ctx(req);
  return sendApproved({ workspaceId: wsId, leadId: id, suggestionId: b.suggestion_id, finalText: b.body, subject: b.subject, userId });
});

// ---------- Suggestions ----------
app.post("/suggestions/:id/accept", async (req) => {          // applies stage_change suggestions; drafts are accepted by sending
  const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
  return withTenant(ctx(req).wsId, async (c) => {
    const s = await c.query("SELECT lead_id, kind, content FROM ai_suggestions WHERE id = $1 AND outcome = 'pending'", [id]);
    if (!s.rowCount || s.rows[0].kind !== "stage_change" || !STAGES.includes(s.rows[0].content)) throw notFound();
    await c.query("UPDATE leads SET stage = $2 WHERE id = $1", [s.rows[0].lead_id, s.rows[0].content]);
    await c.query("UPDATE ai_suggestions SET outcome = 'accepted' WHERE id = $1", [id]);
    return { ok: true };
  });
});
app.post("/suggestions/:id/reject", async (req) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
  return withTenant(ctx(req).wsId, async (c) => {
    if (!(await c.query("UPDATE ai_suggestions SET outcome = 'rejected' WHERE id = $1 AND outcome = 'pending'", [id])).rowCount) throw notFound();
    return { ok: true };
  });
});

// ---------- Tasks ----------
app.get("/tasks", async (req) => {
  const q = z.object({ done: z.enum(["true", "false"]).default("false"), due_before: z.string().datetime().optional() }).parse(req.query);
  return withTenant(ctx(req).wsId, async (c) => (await c.query(
    `SELECT t.id, t.title, t.due_at, t.done_at, t.suggestion_id, t.lead_id, l.full_name
     FROM tasks t JOIN leads l ON l.id = t.lead_id
     WHERE (($1 = 'true') = (t.done_at IS NOT NULL)) AND ($2::timestamptz IS NULL OR t.due_at <= $2)
     ORDER BY t.due_at LIMIT 200`, [q.done, q.due_before ?? null])).rows);
});
app.patch("/tasks/:id", async (req) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(req.params), b = z.object({ done: z.boolean() }).parse(req.body);
  return withTenant(ctx(req).wsId, async (c) => {
    const r = await c.query("UPDATE tasks SET done_at = CASE WHEN $2 THEN now() ELSE NULL END WHERE id = $1 RETURNING *", [id, b.done]);
    if (!r.rowCount) throw notFound();
    return r.rows[0];
  });
});

// ---------- Export backup (replaces the prototype's Export Backup button) ----------
app.get("/export", async (req, reply) => {
  const data = await withTenant(ctx(req).wsId, async (c) => ({
    exported_at: new Date().toISOString(),
    business_profiles: (await c.query("SELECT id, name, description, services, website_url, tone_notes FROM business_profiles")).rows,
    leads: (await c.query("SELECT * FROM leads")).rows,
    interactions: (await c.query("SELECT * FROM interactions")).rows,
    tasks: (await c.query("SELECT * FROM tasks")).rows,
  }));
  reply.header("Content-Disposition", `attachment; filename="crm-backup-${new Date().toISOString().slice(0, 10)}.json"`);
  return data;
});

// Account deletion (after the auth hook). Pass deleteAuthIdentities to also remove users at your auth provider.
registerAccountDeletion(app, { pool, ctx, withTenant });

app.listen({ port: Number(process.env.PORT ?? 3000), host: "0.0.0.0" });
