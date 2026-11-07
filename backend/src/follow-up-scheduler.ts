/**
 * Follow-up scheduler: hourly job that finds quiet leads, creates a follow-up task due in
 * business hours, and attaches an AI-drafted follow-up for the human to approve (never auto-sends).
 *
 * Schema additions:
 *   ALTER TABLE workspaces ADD COLUMN timezone text NOT NULL DEFAULT 'UTC';
 *   ALTER TABLE tasks ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
 *                     ADD COLUMN sequence_no int,
 *                     ADD COLUMN suggestion_id uuid REFERENCES ai_suggestions;
 *   -- at most one open auto task per lead (makes the job idempotent):
 *   CREATE UNIQUE INDEX one_open_auto_task ON tasks (lead_id) WHERE auto_generated AND done_at IS NULL;
 *
 * (sendApproved() already closes the open auto-task when an email goes out.)
 * Needs bullmq >= 5.16 for upsertJobScheduler.
 */
import { Pool } from "pg";
import { Queue, Worker } from "bullmq";
import Anthropic from "@anthropic-ai/sdk";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const anthropic = new Anthropic();
const MODEL = process.env.FOLLOWUP_MODEL ?? "claude-sonnet-5-5";
const connection = { url: process.env.REDIS_URL! };

// Quiet-days before the first follow-up, by stage. Gap grows with each unanswered nudge.
const BASE_DAYS: Record<string, number> = { contacted: 3, interested: 2, proposal_sent: 5 };
const MAX_AUTO_FOLLOWUPS = 3;          // stop nudging after this many unanswered follow-ups
const MAX_DRAFTS_PER_RUN = 25;         // caps AI spend per hourly run
const DAY_MS = 86_400_000;

// ---------- Business-hours slot (Mon-Fri 09:00-17:00 in the workspace timezone) ----------
function nextBusinessSlot(tz: string, from = new Date()): Date {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "numeric", hour12: false });
  const ok = (d: Date) => {
    const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
    const hour = Number(p.hour) % 24;
    return !["Sat", "Sun"].includes(p.weekday) && hour >= 9 && hour < 17;
  };
  let d = new Date(from);
  for (let i = 0; i < 24 * 4 * 2 && !ok(d); i++) d = new Date(d.getTime() + 30 * 60_000);
  return d;
}

type Created = { taskId: string; leadId: string; seq: number };

// ---------- 1. Find quiet leads and create tasks (one transaction per workspace) ----------
async function scheduleForWorkspace(wsId: string, tz: string): Promise<Created[]> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.workspace_id', $1, true)", [wsId]);
    // Skip if another instance is already processing this workspace
    const lock = await c.query("SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok", [wsId]);
    if (!lock.rows[0].ok) { await c.query("ROLLBACK"); return []; }

    const { rows } = await c.query(
      `SELECT l.id, l.stage, l.full_name, lo.occurred_at AS last_out_at,
              (SELECT count(*) FROM tasks t
                WHERE t.lead_id = l.id AND t.auto_generated
                  AND t.created_at > COALESCE(li.occurred_at, 'epoch')) AS n_auto
       FROM leads l
       JOIN LATERAL (SELECT occurred_at FROM interactions
                     WHERE lead_id = l.id AND kind = 'email_out'
                     ORDER BY occurred_at DESC LIMIT 1) lo ON true
       LEFT JOIN LATERAL (SELECT occurred_at FROM interactions
                          WHERE lead_id = l.id AND kind = 'email_in'
                            AND classification IS DISTINCT FROM 'ooo'
                          ORDER BY occurred_at DESC LIMIT 1) li ON true
       WHERE l.stage = ANY($1) AND NOT l.unsubscribed AND NOT l.bounced
         AND EXISTS (SELECT 1 FROM email_accounts ea WHERE ea.business_profile_id = l.business_profile_id AND ea.status = 'active')
         AND (li.occurred_at IS NULL OR li.occurred_at < lo.occurred_at)   -- they haven't replied since our last email
         AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.lead_id = l.id AND t.auto_generated AND t.done_at IS NULL)
       LIMIT 500`, [Object.keys(BASE_DAYS)]);

    const created: Created[] = [];
    const now = Date.now();
    for (const r of rows) {
      const n = Number(r.n_auto);
      if (n >= MAX_AUTO_FOLLOWUPS) continue;
      const quietMs = now - new Date(r.last_out_at).getTime();
      if (quietMs < BASE_DAYS[r.stage] * (n + 1) * DAY_MS) continue;       // 3d, 6d, 9d for "contacted"
      const ins = await c.query(
        `INSERT INTO tasks (workspace_id, lead_id, title, due_at, auto_generated, sequence_no)
         VALUES ($1,$2,$3,$4,true,$5) ON CONFLICT DO NOTHING RETURNING id`,
        [wsId, r.id, `Follow up with ${r.full_name} (#${n + 1})`, nextBusinessSlot(tz), n + 1]);
      if (ins.rowCount) created.push({ taskId: ins.rows[0].id, leadId: r.id, seq: n + 1 });
    }
    await c.query("COMMIT");
    return created;
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; }
  finally { c.release(); }
}

// ---------- 2. Draft the follow-up (outside the transaction; failures never lose the task) ----------
async function draftFollowUp(wsId: string, t: Created) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");                      // transaction-local tenant context, so it never leaks via the pool
    await c.query("SELECT set_config('app.workspace_id', $1, true)", [wsId]);
    const q = await c.query(
      `SELECT l.full_name, l.company, l.notes, l.stage, bp.name AS biz, bp.description, bp.services,
              bp.website_url, bp.tone_notes,
              (SELECT subject || chr(10) || chr(10) || body FROM interactions
                WHERE lead_id = l.id AND kind = 'email_out' ORDER BY occurred_at DESC LIMIT 1) AS last_email
       FROM leads l JOIN business_profiles bp ON bp.id = l.business_profile_id WHERE l.id = $1`, [t.leadId]);
    const d = q.rows[0];
    await c.query("COMMIT");                     // end the read transaction before the slow AI call
    if (!d) return;
    const msg = await anthropic.messages.create({
      model: MODEL, max_tokens: 500,
      system: "You write short, human follow-up emails for a small business. Under 90 words, no pressure, no fake urgency, " +
        "add one new useful angle or a simple question, and never invent facts. Begin with 'Subject: ...', then a blank line, then the body.",
      messages: [{ role: "user", content:
        `Business: ${d.biz}. ${d.description}\nServices: ${d.services}\nLink: ${d.website_url ?? ""}\nTone: ${d.tone_notes ?? "friendly, professional"}\n` +
        `Lead: ${d.full_name}${d.company ? " at " + d.company : ""}; notes: ${d.notes ?? ""}; stage: ${d.stage}\n` +
        `This is unanswered follow-up #${t.seq}${t.seq >= 3 ? " (last one: be gracious and leave the door open)" : ""}.\n\n` +
        `<previous_email>\n${d.last_email ?? ""}\n</previous_email>` }],
    });
    const text = msg.content.map((b: any) => (b.type === "text" ? b.text : "")).join("").trim();
    if (!text) return;
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.workspace_id', $1, true)", [wsId]);
    const s = await c.query(
      `INSERT INTO ai_suggestions (workspace_id, lead_id, kind, content, model)
       VALUES ($1,$2,'draft_email',$3,$4) RETURNING id`, [wsId, t.leadId, text, MODEL]);
    await c.query("UPDATE tasks SET suggestion_id = $1 WHERE id = $2", [s.rows[0].id, t.taskId]);
    await c.query("COMMIT");
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; }
  finally { c.release(); }
}

// ---------- 3. Hourly tick ----------
export async function runTick() {
  const ws = await pool.query("SELECT id, timezone FROM workspaces");
  let drafts = 0;
  for (const w of ws.rows) {
    try {
      const created = await scheduleForWorkspace(w.id, w.timezone || "UTC");
      for (const t of created) {
        if (drafts >= MAX_DRAFTS_PER_RUN) break;          // remaining tasks still exist; drafted on a later tick or on demand
        try { await draftFollowUp(w.id, t); drafts++; }
        catch (e) { console.error("draft failed", t.taskId, e); }
      }
    } catch (e) { console.error("workspace failed", w.id, e); }   // one bad tenant never blocks the rest
  }
}

export async function startScheduler() {
  const queue = new Queue("followups", { connection });
  await queue.upsertJobScheduler("hourly-followups", { pattern: "0 * * * *" }, { name: "tick" });
  return new Worker("followups", runTick, { connection, concurrency: 1 });
}
