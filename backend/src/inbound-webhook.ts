/**
 * Inbound reply webhook (Fastify + pg + BullMQ). Payload shape follows Postmark inbound;
 * for SendGrid/Mailgun/SES, adapt only parseInbound().
 *
 * Schema additions needed:
 *   ALTER TABLE business_profiles ADD COLUMN reply_token text UNIQUE;   -- e.g. 'b7f3k'
 *   CREATE TABLE unassigned_replies (
 *     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 *     workspace_id uuid NOT NULL, business_profile_id uuid NOT NULL,
 *     from_email text, subject text, body text,
 *     provider_message_id text UNIQUE, received_at timestamptz DEFAULT now());
 *   ALTER TABLE leads ADD COLUMN bounced boolean NOT NULL DEFAULT false;
 */
import Fastify from "fastify";
import { Pool } from "pg";
import { Queue } from "bullmq";
import { timingSafeEqual } from "node:crypto";

const REPLY_DOMAIN = process.env.REPLY_DOMAIN!;            // e.g. reply.yourdomain.com
const WEBHOOK_USER = process.env.INBOUND_USER!;
const WEBHOOK_PASS = process.env.INBOUND_PASS!;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const classifyQueue = new Queue("classify-reply", { connection: { url: process.env.REDIS_URL! } });

type Inbound = {
  messageId: string; fromEmail: string; toAddresses: string[];
  subject: string; body: string; inReplyTo?: string; references: string[];
  autoSubmitted: boolean; isBounce: boolean;
};

// ---- 1. Provider-specific parsing (only part to change per provider) ----
function parseInbound(p: any): Inbound {
  const h = (n: string) =>
    (p.Headers ?? []).find((x: any) => x.Name.toLowerCase() === n.toLowerCase())?.Value as string | undefined;
  const refs = (h("References") ?? "").split(/\s+/).filter(Boolean);
  const from = String(p.FromFull?.Email ?? p.From ?? "").toLowerCase();
  const autoSub = (h("Auto-Submitted") ?? "no").toLowerCase() !== "no" ||
                  /auto|bulk|junk/i.test(h("Precedence") ?? "");
  const isBounce = /mailer-daemon|postmaster/i.test(from) || /delivery status|undeliver/i.test(p.Subject ?? "");
  return {
    messageId: (h("Message-ID") ?? p.MessageID ?? "").replace(/[<>]/g, ""),
    fromEmail: from,
    toAddresses: (p.ToFull ?? []).map((t: any) => String(t.Email).toLowerCase())
      .concat(p.OriginalRecipient ? [String(p.OriginalRecipient).toLowerCase()] : []),
    subject: p.Subject ?? "",
    body: cleanBody(p.StrippedTextReply || p.TextBody || ""),
    inReplyTo: h("In-Reply-To")?.replace(/[<>\s]/g, ""),
    references: refs.map((r) => r.replace(/[<>]/g, "")),
    autoSubmitted: autoSub, isBounce,
  };
}

// ---- 2. Body cleanup: keep only the new text, cap size ----
function cleanBody(t: string): string {
  const cut = t.split(/\r?\n(?:On .{10,120} wrote:|-{2,}\s*Original Message|From:\s.+\r?\nSent:)/i)[0];
  return cut.replace(/\r/g, "").replace(/\n--\s*\n[\s\S]*$/, "").trim().slice(0, 20000);
}

// ---- 3. Address parsing: b_<token>[+<leadId>]@REPLY_DOMAIN ----
function parseTrackingAddress(addrs: string[]) {
  for (const a of addrs) {
    const m = a.match(new RegExp(`^b_([a-z0-9]+)(?:\\+([0-9a-f-]{36}))?@${REPLY_DOMAIN.replace(/\./g, "\\.")}$`));
    if (m) return { token: m[1], leadId: m[2] as string | undefined };
  }
  return null;
}

function authorized(header?: string): boolean {
  if (!header?.startsWith("Basic ")) return false;
  const got = Buffer.from(header.slice(6), "base64");
  const want = Buffer.from(`${WEBHOOK_USER}:${WEBHOOK_PASS}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

const app = Fastify({ logger: true, bodyLimit: 25 * 1024 * 1024 });

app.post("/webhooks/inbound-email", async (req, reply) => {
  if (!authorized(req.headers.authorization)) return reply.code(401).send();

  const mail = parseInbound(req.body);
  const addr = parseTrackingAddress(mail.toAddresses);
  if (!addr || !mail.messageId) return reply.code(200).send({ ignored: "no tracking address" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Resolve tenant from the address
    const bp = await client.query(
      "SELECT id, workspace_id FROM business_profiles WHERE reply_token = $1", [addr.token]);
    if (!bp.rowCount) { await client.query("ROLLBACK"); return reply.code(200).send({ ignored: "unknown token" }); }
    const { id: profileId, workspace_id: wsId } = bp.rows[0];
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [wsId]);   // enables RLS

    // Idempotency: providers retry, so dedupe on Message-ID
    const dup = await client.query(
      "SELECT 1 FROM interactions WHERE provider_message_id = $1 UNION ALL SELECT 1 FROM unassigned_replies WHERE provider_message_id = $1",
      [mail.messageId]);
    if (dup.rowCount) { await client.query("ROLLBACK"); return reply.code(200).send({ duplicate: true }); }

    // Match the lead, most reliable first
    let lead: { id: string; thread_id: string | null } | undefined;
    const refIds = [mail.inReplyTo, ...mail.references].filter(Boolean) as string[];
    if (refIds.length) {
      const r = await client.query(
        `SELECT l.id, i.thread_id FROM interactions i JOIN leads l ON l.id = i.lead_id
         WHERE i.provider_message_id = ANY($1) AND l.business_profile_id = $2 LIMIT 1`, [refIds, profileId]);
      lead = r.rows[0];
    }
    if (!lead && addr.leadId) {
      const r = await client.query(
        "SELECT id, NULL AS thread_id FROM leads WHERE id = $1 AND business_profile_id = $2", [addr.leadId, profileId]);
      lead = r.rows[0];
    }
    if (!lead) {
      const r = await client.query(
        "SELECT id, NULL AS thread_id FROM leads WHERE business_profile_id = $1 AND lower(email) = $2",
        [profileId, mail.fromEmail]);
      lead = r.rows[0];
    }

    // Bounces: flag the lead, log it, skip AI
    if (mail.isBounce && lead) {
      await client.query("UPDATE leads SET bounced = true WHERE id = $1", [lead.id]);
      await client.query(
        `INSERT INTO interactions (workspace_id, lead_id, kind, provider_message_id, subject, body)
         VALUES ($1,$2,'note',$3,'Email bounced',$4)`, [wsId, lead.id, mail.messageId, mail.body.slice(0, 2000)]);
      await client.query("COMMIT");
      return reply.code(200).send({ bounced: true });
    }

    // No match: keep it in the unassigned inbox instead of dropping it
    if (!lead) {
      await client.query(
        `INSERT INTO unassigned_replies (workspace_id, business_profile_id, from_email, subject, body, provider_message_id)
         VALUES ($1,$2,$3,$4,$5,$6)`, [wsId, profileId, mail.fromEmail, mail.subject, mail.body, mail.messageId]);
      await client.query("COMMIT");
      return reply.code(200).send({ unassigned: true });
    }

    // Store the reply
    const ins = await client.query(
      `INSERT INTO interactions (workspace_id, lead_id, kind, thread_id, provider_message_id, subject, body)
       VALUES ($1,$2,'email_in',$3,$4,$5,$6) RETURNING id`,
      [wsId, lead.id, lead.thread_id, mail.messageId, mail.subject, mail.body]);
    await client.query("UPDATE leads SET last_activity_at = now() WHERE id = $1", [lead.id]);
    // A real reply cancels pending auto-generated follow-up tasks
    if (!mail.autoSubmitted) {
      await client.query(
        "UPDATE tasks SET done_at = now() WHERE lead_id = $1 AND auto_generated AND done_at IS NULL", [lead.id]);
    }
    await client.query("COMMIT");

    // Classify outside the transaction (auto-replies are labeled without an AI call)
    await classifyQueue.add("classify", {
      interactionId: ins.rows[0].id, workspaceId: wsId, leadId: lead.id, autoReply: mail.autoSubmitted,
    }, { attempts: 3, backoff: { type: "exponential", delay: 5000 } });

    return reply.code(200).send({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    req.log.error(err);
    return reply.code(500).send();                 // non-2xx makes the provider retry
  } finally {
    client.release();
  }
});

app.listen({ port: Number(process.env.INBOUND_PORT ?? 3001), host: "0.0.0.0" });
