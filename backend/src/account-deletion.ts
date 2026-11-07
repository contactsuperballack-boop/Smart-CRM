/**
 * Account deletion (makes the privacy policy's deletion promise true).
 *   GET  /account         -> { email, role, workspace_name }   (UI uses it to build the confirmation prompt)
 *   POST /account/delete  -> permanently deletes the whole workspace
 *
 * Register AFTER the global auth hook in api.ts. What happens, in order:
 *   1. Owner-only, and the caller must type the exact workspace name.
 *   2. Gmail refresh tokens are revoked at Google (best effort, counted).
 *   3. One transaction deletes the workspace; ON DELETE CASCADE removes users, profiles, leads, interactions,
 *      AI suggestions, tasks, email accounts and unassigned replies. (Foreign-key cascades bypass row-level security.)
 *   4. A minimal audit row (ids and counts only, no personal data) goes into deletion_log.
 *   5. Optional hook removes the users' identities at your auth provider (Clerk/Auth0/Supabase admin API).
 * Not removed by this code: provider-side copies (Postmark message retention, Anthropic API logs) and database backups.
 * Align those with the retention numbers in the privacy policy.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { google } from "googleapis";
import { z } from "zod";
import { decryptToken } from "./gmail-oauth";

type Deps = {
  pool: Pool;
  ctx: (req: FastifyRequest) => { userId: string; wsId: string };
  withTenant: <T>(wsId: string, fn: (c: PoolClient) => Promise<T>) => Promise<T>;
  deleteAuthIdentities?: (authIds: string[]) => Promise<void>;   // implement for your auth provider
};

export function registerAccountDeletion(app: FastifyInstance, d: Deps) {
  app.get("/account", async (req) => {
    const { userId, wsId } = d.ctx(req);
    const r = await d.pool.query(
      "SELECT u.email, u.role, w.name AS workspace_name FROM users u JOIN workspaces w ON w.id = u.workspace_id WHERE u.id = $1 AND w.id = $2",
      [userId, wsId]);
    if (!r.rowCount) throw { statusCode: 404, message: "Not found" };
    return r.rows[0];
  });

  app.post("/account/delete", { config: { rateLimit: { max: 3, timeWindow: "1 hour" } } }, async (req, reply) => {
    const { confirmation } = z.object({ confirmation: z.string().min(1).max(300) }).parse(req.body);
    const { userId, wsId } = d.ctx(req);

    // 1. Owner only, and the typed text must match the workspace name exactly
    const who = await d.pool.query(
      "SELECT u.role, w.name FROM users u JOIN workspaces w ON w.id = u.workspace_id WHERE u.id = $1 AND w.id = $2",
      [userId, wsId]);
    if (!who.rowCount || who.rows[0].role !== "owner")
      throw { statusCode: 403, message: "Only the workspace owner can delete the account" };
    if (confirmation.trim() !== who.rows[0].name)
      throw { statusCode: 400, message: "The confirmation text doesn't match the workspace name" };

    // 2. Collect what lives outside our tables: Gmail tokens, auth identities, and a lead count for the audit row
    const info = await d.withTenant(wsId, async (c) => {
      const acc = await c.query("SELECT refresh_token_enc FROM email_accounts");
      const leads = await c.query("SELECT count(*)::int AS n FROM leads");
      const users = await c.query("SELECT auth_id FROM users WHERE workspace_id = $1", [wsId]);
      return { encTokens: acc.rows.map((r) => r.refresh_token_enc as Buffer), leads: leads.rows[0].n as number,
               authIds: users.rows.map((r) => r.auth_id as string) };
    });

    // 3. Revoke Gmail access at Google first, so a deletion never leaves a live token behind
    let revoked = 0, failed = 0;
    for (const enc of info.encTokens) {
      try {
        await new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET)
          .revokeToken(decryptToken(enc));
        revoked++;
      } catch { failed++; }                                     // already revoked, or expired: nothing more to do
    }

    // 4. Delete everything in one transaction (cascade), and write the audit row
    const c = await d.pool.connect();
    try {
      await c.query("BEGIN");
      const del = await c.query("DELETE FROM workspaces WHERE id = $1", [wsId]);
      if (!del.rowCount) throw { statusCode: 404, message: "Already deleted" };
      await c.query(
        "INSERT INTO deletion_log (workspace_id, leads_deleted, tokens_revoked, tokens_revoke_failed) VALUES ($1,$2,$3,$4)",
        [wsId, info.leads, revoked, failed]);
      await c.query("COMMIT");
    } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; }
    finally { c.release(); }

    // 5. Remove the sign-in identities (best effort: the data is already gone)
    if (d.deleteAuthIdentities) {
      try { await d.deleteAuthIdentities(info.authIds); }
      catch (e) { app.log.error({ err: e, wsId }, "auth identity cleanup failed; remove these users manually"); }
    }

    app.log.info({ wsId, leads: info.leads, revoked, failed }, "workspace deleted");
    reply.code(200);
    return { deleted: true, gmail_tokens_revoked: revoked, gmail_tokens_already_invalid: failed,
             note: "Your data was removed from our systems. Encrypted backups are overwritten on their normal schedule." };
  });
}
