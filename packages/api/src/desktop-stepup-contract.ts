import type { RouteSpec } from "./routes.ts";
const object = (properties: Record<string, unknown>) => ({ type: "object", additionalProperties: false,
  required: Object.keys(properties), properties });
const secret = { type: "string", minLength: 43, maxLength: 43 };
const code = { type: "string", pattern: "^[A-Z2-9]{4}-[A-Z2-9]{4}$" };
const purpose = { enum: ["session", "extensions", "imports"] };
const time = { type: "integer", minimum: 0 };
const schema = (id: string) => ({ const: `desktop.step-up.${id}/1` });
const base = { tag: "desktop", auth: "none", authz: "public", csrf: false, rate: "auth",
  stability: "experimental", since: "1.8.0", successStatus: 200 } as const;
const publicInfo = { userCode: code, deviceId: { type: "string" }, purpose,
  state: { enum: ["pending", "approved", "declined"] }, expiresAt: time };
export const DESKTOP_STEPUP_ROUTES: readonly RouteSpec[] = [
  { ...base, id: "desktop.step-up.start", method: "POST", path: "/api/v1/desktop/step-up/start",
    summary: "Enrolled native device starts a fixed five-minute same-person browser approval",
    requestBody: object({ purpose }), success: { description: "Native-private challenge and public verification code; no permission is added",
      schema: object({ schema: schema("start"), challengeId: secret, userCode: code, purpose, expiresAt: time, intervalMs: { type: "integer" } }) } },
  { ...base, id: "desktop.step-up.poll", method: "POST", path: "/api/v1/desktop/step-up/poll",
    summary: "Same device polls privately for a one-use operation proof",
    requestBody: object({ challengeId: secret }), success: { description: "Only the native bearer receives proofToken; never expose this response to a renderer",
      schema: { oneOf: [object({ schema: schema("poll"), state: { enum: ["pending", "declined", "expired"] }, expiresAt: time }),
        object({ schema: schema("poll"), state: { const: "approved" }, purpose, proofToken: secret, expiresAt: time })] } } },
  { ...base, id: "desktop.step-up.cancel", method: "POST", path: "/api/v1/desktop/step-up/cancel",
    summary: "Same enrolled device cancels its pending or approved grant",
    requestBody: object({ challengeId: secret }), success: { description: "Outstanding operation proofs are revoked",
      schema: object({ schema: schema("cancel"), ok: { const: true } }) } },
  { ...base, id: "desktop.step-up.approval", method: "GET", path: "/api/v1/desktop/step-up/approval/{userCode}",
    auth: "session", authz: "authenticated", rate: "read", summary: "Same-person ordinary browser sees public device approval details",
    success: { description: "No native credential, private challenge or proof is returned", schema: object({ schema: schema("approval"), ...publicInfo }) } },
  { ...base, id: "desktop.step-up.decision", method: "POST", path: "/api/v1/desktop/step-up/decision",
    auth: "session", authz: "authenticated", csrf: true, rate: "write",
    summary: "Same-person ordinary browser approves with an existing fresh MFA session, or declines",
    requestBody: object({ userCode: code, decision: { enum: ["approve", "decline"] } }),
    success: { description: "Public metadata only; approval cannot widen the device's enrolled purpose or extend MFA freshness",
      schema: object({ schema: schema("decision"), ...publicInfo }) } },
];
