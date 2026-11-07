/**
 * Gmail connect flow (send-only). Routes:
 *   POST   /profiles/:id/gmail/connect   -> { url }  (frontend redirects the browser to it)
 *   GET    /oauth/google/callback        -> Google redirects here; stores the token, redirects to the app
 *   GET    /profiles/:id/gmail           -> { connected, address, status }
 *   DELETE /profiles/:id/gmail           -> revokes the token at Google and removes the account
 *
 * Env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI (https://<api-host>/oauth/google/callback),
 *      APP_URL (where the UI lives), STATE_SECRET (random 32+ chars), TOKEN_KEY (base64 of 32 random bytes).
 * Register BEFORE the global auth hook in api.ts, because the callback comes from Google with no bearer token:
 * it is protected by a signed, expiring state plus a browser-bound cookie instead.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { PoolClient } from "pg";
import { google } from "googleapis";
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const SCOPES = [SEND_SCOPE, "openid", "email"];          // send-only: no access to read the inbox
const APP_URL = (process.env.APP_URL ?? "").replace(/\/$/, "");
const SECURE = process.env.NODE_ENV === "production" ? " Secure;" : "";

// ---------- Token encryption (AES-256-GCM; swap for KMS envelope encryption when you can) ----------
const KEY = Buffer.from(process.env.TOKEN_KEY ?? "", "base64");
if (KEY.length !== 32) throw new Error("TOKEN_KEY must be base64 of exactly 32 bytes");
export function encryptToken(plain: string): Buffer {
  const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", KEY, iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]);          // iv(12) | tag(16) | ciphertext
}
export function decryptToken(buf: Buffer): string {
  const d = createDecipheriv("aes-256-gcm", KEY, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
}
/** True when Google rejected the stored refresh token (revoked, expired, password change). sendApproved() uses it to flag the account. */
export const isInvalidGrant = (e: any) =>
  /invalid_grant/.test([e?.message, e?.response?.data?.error, e?.response?.data?.error_description].join(" "));

// ---------- Signed state ----------
type State = { w: string; p: string; u: string; n: string; e: number };
const sig = (b: string) => createHmac("sha256", process.env.STATE_SECRET!).update(b).digest("base64url");
const signState = (s: State) => { const b = Buffer.from(JSON.stringify(s)).toString("base64url"); return `${b}.${sig(b)}`; };
function readState(raw: string): State | null {
  const [b, s] = raw.split(".");
  if (!b || !s) return null;
  const want = Buffer.from(sig(b)), got = Buffer.from(s);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  const st = JSON.parse(Buffer.from(b, "base64url").toString()) as State;
  return st.e > Date.now() ? st : null;
}
const cookie = (req: FastifyRequest, name: string) =>
  (req.headers.cookie ?? "").split(/;\s*/).find((c) => c.startsWith(name + "="))?.slice(name.length + 1);
const oauthClient = () => new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);

type Deps = {
  auth: (req: FastifyRequest) => Promise<void>;
  ctx: (req: FastifyRequest) => { userId: string; wsId: string };
  withTenant: <T>(wsId: string, fn: (c: PoolClient) => Promise<T>) => Promise<T>;
};
const Id = z.object({ id: z.string().uuid() });
const notFound = () => ({ statusCode: 404, message: "Not found" });

export function registerGmailOAuth(app: FastifyInstance, d: Deps) {
  // 1. Start: returns the Google consent URL and binds the flow to this browser with a cookie
  app.post("/profiles/:id/gmail/connect", { preHandler: d.auth }, async (req, reply) => {
    const { id } = Id.parse(req.params), { wsId, userId } = d.ctx(req);
    const ok = await d.withTenant(wsId, (c) => c.query("SELECT 1 FROM business_profiles WHERE id = $1", [id]));
    if (!ok.rowCount) throw notFound();
    const nonce = randomBytes(16).toString("base64url");
    const state = signState({ w: wsId, p: id, u: userId, n: nonce, e: Date.now() + 10 * 60_000 });
    reply.header("Set-Cookie", `oauth_nonce=${nonce}; HttpOnly;${SECURE} SameSite=Lax; Path=/; Max-Age=600`);
    return { url: oauthClient().generateAuthUrl({
      access_type: "offline", prompt: "consent",          // consent forces a refresh token every time
      scope: SCOPES, state, include_granted_scopes: false }) };
  });

  // 2. Callback from Google
  app.get("/oauth/google/callback", async (req: FastifyRequest, reply: FastifyReply) => {
    const go = (qs: string) => reply.code(302).header("Location", `${APP_URL}/?${qs}`)
      .header("Set-Cookie", `oauth_nonce=; HttpOnly;${SECURE} SameSite=Lax; Path=/; Max-Age=0`).send();
    const q = z.object({ code: z.string().optional(), state: z.string(), error: z.string().optional() }).safeParse(req.query);
    if (!q.success) return go("gmail=error&reason=bad_request");
    if (q.data.error || !q.data.code) return go("gmail=error&reason=" + encodeURIComponent(q.data.error ?? "access_denied"));

    const st = readState(q.data.state);
    const nonce = cookie(req, "oauth_nonce");
    // The cookie check stops someone from tricking a victim into linking the victim's Gmail to the attacker's workspace
    if (!st || !nonce || nonce.length !== st.n.length || !timingSafeEqual(Buffer.from(nonce), Buffer.from(st.n)))
      return go("gmail=error&reason=invalid_state");
    try {
      const cl = oauthClient();
      const { tokens } = await cl.getToken(q.data.code);
      if (!tokens.refresh_token) return go("gmail=error&reason=no_refresh_token");
      if (!(tokens.scope ?? "").split(" ").includes(SEND_SCOPE)) return go("gmail=error&reason=missing_scope");  // user unticked it
      const payload = (await cl.verifyIdToken({ idToken: tokens.id_token!, audience: process.env.GOOGLE_CLIENT_ID })).getPayload();
      if (!payload?.email || !payload.email_verified) return go("gmail=error&reason=unverified_email");
      const addr = payload.email.toLowerCase();

      await d.withTenant(st.w, async (c) => {
        if (!(await c.query("SELECT 1 FROM business_profiles WHERE id = $1", [st.p])).rowCount) throw notFound();
        await c.query("UPDATE email_accounts SET status = 'replaced' WHERE business_profile_id = $1 AND address <> $2", [st.p, addr]);
        await c.query(
          `INSERT INTO email_accounts (workspace_id, business_profile_id, provider, address, refresh_token_enc, status)
           VALUES ($1,$2,'gmail',$3,$4,'active')
           ON CONFLICT (business_profile_id, address)
           DO UPDATE SET refresh_token_enc = EXCLUDED.refresh_token_enc, status = 'active'`,
          [st.w, st.p, addr, encryptToken(tokens.refresh_token!)]);
      });
      return go("gmail=connected");
    } catch (e) {
      app.log.error(e);
      return go("gmail=error&reason=exchange_failed");
    }
  });

  // 3. Status
  app.get("/profiles/:id/gmail", { preHandler: d.auth }, async (req) => {
    const { id } = Id.parse(req.params);
    return d.withTenant(d.ctx(req).wsId, async (c) => {
      const r = await c.query(
        "SELECT address, status FROM email_accounts WHERE business_profile_id = $1 AND status IN ('active','reconnect_needed') LIMIT 1", [id]);
      return r.rowCount ? { connected: true, address: r.rows[0].address, status: r.rows[0].status } : { connected: false };
    });
  });

  // 4. Disconnect: revoke at Google (best effort), then delete our copy
  app.delete("/profiles/:id/gmail", { preHandler: d.auth }, async (req, reply) => {
    const { id } = Id.parse(req.params);
    await d.withTenant(d.ctx(req).wsId, async (c) => {
      const rows = await c.query("SELECT refresh_token_enc FROM email_accounts WHERE business_profile_id = $1", [id]);
      for (const r of rows.rows) {
        try { await oauthClient().revokeToken(decryptToken(r.refresh_token_enc)); } catch { /* already revoked or expired */ }
      }
      await c.query("DELETE FROM email_accounts WHERE business_profile_id = $1", [id]);
    });
    reply.code(204).send();
  });
}
