import { verifyBootstrap } from "./bootstrap.ts";
import type { RouteSpec, Handler, HandlerDeps } from "./routes.ts";
import type { AccountStore } from "./account-store.ts";
import type { CoreRpc } from "./core-rpc.ts";
import { ApiError, errors } from "./errors.ts";
import { normalizeUsername } from "./memory-stores.ts";
import { hashPassword, MAX_PASSWORD_BYTES } from "./password.ts";
const requestBody = { type: "object", additionalProperties: false, required: ["code", "username", "password"], properties: { code: { type: "string", maxLength: 256 }, username: { type: "string", maxLength: 128 }, password: { type: "string", maxLength: MAX_PASSWORD_BYTES } } };
export const ACCOUNT_ROUTES: readonly RouteSpec[] = [
  { id: "invitation.redeem", method: "POST", path: "/api/v1/invitations/redeem", summary: "Redeem an invitation into a password account", tag: "accounts", auth: "none", authz: "public", csrf: false, rate: "auth", stability: "experimental", since: "1.0.0", requestBody, successStatus: 201, success: { description: "Account created; sign in separately", schema: { type: "object", properties: { schema: { const: "invitation.redeem/1" }, created: { const: true } } } } },
  { id: "account.bootstrap", method: "POST", path: "/api/v1/accounts/bootstrap", summary: "Link one password account to the bootstrap Owner", tag: "accounts", auth: "none", authz: "public", csrf: false, rate: "auth", stability: "experimental", since: "1.0.0", requestBody: { ...requestBody, required: ["proof", "username", "password"], properties: { proof: { type: "string" }, username: { type: "string" }, password: { type: "string" } } }, extra: { 404: { description: "Bootstrap is permanently consumed or unavailable", schema: { $ref: "#/components/schemas/Error" } }, 409: { description: "Username already exists", schema: { $ref: "#/components/schemas/Error" } } }, successStatus: 201, success: { description: "Owner account created", schema: { type: "object", properties: { created: { const: true } } } } },
];
export function accountCredentials(b: Record<string, unknown>): { username: string; password: string } {
  const username = typeof b.username === "string" ? normalizeUsername(b.username) : "";
  if (!/^[a-z0-9._-]{3,64}$/.test(username) || ["owner", "admin", "root", "system"].includes(username)) throw errors.badRequest("username", "invalid username");
  if (typeof b.password !== "string" || [...b.password].length < 12 || Buffer.byteLength(b.password) > MAX_PASSWORD_BYTES || normalizeUsername(b.password) === username) throw errors.badRequest("password", "invalid password");
  return { username, password: b.password };
}
export function buildAccountHandlers(d: HandlerDeps, accounts: AccountStore | undefined, core: CoreRpc, consumed?: () => void, allowBootstrap = true, auditBootstrap?: () => void): Record<string, Handler> {
  const pending = new Set<string>();
  const body = (input: unknown, allowed: string[]) => {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !allowed.includes(k))) throw errors.badRequest("body", "invalid account request");
    return input as Record<string, unknown>;
  };
  return {
    "invitation.redeem": async i => {
      const b = body(i.body, ["code", "username", "password"]);
      const invalid = () => new ApiError(400, "E_INVITE_INVALID", "invitation is not valid");
      if (typeof b.code !== "string" || b.code.length !== 43) throw invalid();
      if (!accounts || !core.serviceCall) throw new ApiError(503, "E_NOT_AVAILABLE", "account registration unavailable");
      let invitation: { userId: string; role: string };
      try { if (typeof b.code !== "string" || b.code.length > 256) throw invalid(); invitation = await core.serviceCall("admin.api.invite.validate", { token: b.code }); } catch { throw invalid(); }
      const credentials = accountCredentials(b);
      // Reserve after validation; never report whether a username exists to an invalid invitation holder.
      if (pending.has(invitation.userId)) throw new ApiError(409, "E_CONFLICT", "account registration in progress");
      pending.add(invitation.userId);
      let inserted = false, consumed = false;
      try {
        await accounts.createPending(invitation.userId, credentials.username, await hashPassword(credentials.password)); inserted = true;
        try { const r = await core.serviceCall<{ userId: string }>("user.invite.redeem", { token: b.code }); if (r.userId !== invitation.userId) throw invalid(); consumed = true; } catch { throw invalid(); }
        await accounts.activate(invitation.userId);
        d.audit.emit("invitation.redeemed", invitation.userId, "invitation", { role: invitation.role });
        return { status: 201, body: { schema: "invitation.redeem/1", created: true } };
      } catch (e) {
        if (consumed) d.audit.emit("invitation.account.failed", invitation.userId, "invitation", { reason: "activation-failed" });
        if (inserted) { try { await accounts.removePending(invitation.userId); } catch { d.audit.emit("invitation.account.failed", invitation.userId, "invitation", { reason: "pending-cleanup-failed" }); } }
        throw e;
      } finally { pending.delete(invitation.userId); }
    },
    "account.bootstrap": async i => {
      const b = body(i.body, ["proof", "username", "password"]);
      if (!allowBootstrap || !accounts || accounts.bootstrapState()?.consumed) throw new ApiError(404, "E_NOT_FOUND", "bootstrap unavailable");
      if (!verifyBootstrap(accounts, b.proof)) throw errors.forbidden("bootstrap-proof");
      if (!accounts) throw new ApiError(503, "E_NOT_AVAILABLE", "account registration unavailable");
      const credentials = accountCredentials(b);
      await accounts.bootstrapOwner(credentials.username, await hashPassword(credentials.password), auditBootstrap);
      try { consumed?.(); } catch { d.log.warn("bootstrap proof cleanup deferred"); }
      d.audit.emit("account.bootstrap.consumed", "local-owner", "account", {});
      return { status: 201, body: { schema: "account.bootstrap/1", created: true } };
    },
  };
}
