import type { RouteSpec } from "./routes.ts";
const str = { type: "string", minLength: 1, maxLength: 4096 };
const credential = { type: "string", minLength: 43, maxLength: 43 };
const time = { type: "integer", minimum: 0 };
const object = (properties: Record<string, unknown>) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const base = { tag: "desktop", auth: "none", authz: "public", csrf: false, rate: "auth", stability: "experimental", since: "1.0.0", successStatus: 200 } as const;
const success = (description: string, schema: Record<string, unknown>) => ({ description, schema });
export const DESKTOP_ATTACH_ROUTES: readonly RouteSpec[] = [
  { ...base, id: "desktop.meta", method: "GET", path: "/api/v1/meta", rate: "read", summary: "Public minimal desktop attach capabilities", success: success("No person, home path, credential or account metadata", object({ version: str, capabilities: { type: "array", items: { type: "string" } }, pairingRequired: { type: "boolean" } })) },
  { ...base, id: "desktop.pair", method: "POST", path: "/api/v1/desktop/pair", summary: "Spend a CLI-issued person-bound desktop pairing code", requestBody: object({ code: credential, kind: { const: "desktop" }, name: str, publicKey: str }), success: success("Device record and a fixed-scope 30-day bearer token, shown once", object({ schema: { const: "desktop.pair/1" }, device: { type: "object", additionalProperties: true }, token: credential, expiresAt: time })) },
  { ...base, id: "desktop.redeem", method: "POST", path: "/api/v1/desktop/redeem", summary: "Exchange device token for an origin/device-bound 30-second SPA ticket", requestBody: object({ token: credential, origin: str }), success: success("One-use SPA ticket; never put credentials in a URL", object({ schema: { const: "desktop.redeem/1" }, ticket: credential, deviceId: str, expiresAt: time })) },
  { ...base, id: "desktop.ticket", method: "POST", path: "/api/v1/desktop/ticket", summary: "Spend a desktop ticket into a restricted session cookie", requestBody: object({ ticket: credential, deviceId: str }), success: success("HttpOnly session cookie bound to the live device and person", object({ schema: { const: "desktop.ticket/1" }, principal: object({ kind: { const: "user" }, id: str, role: { enum: ["owner", "admin", "operator", "member", "viewer"] } }) })) },
];
