/** Public-only browser half. Native credentials, private challenges and proofs have no interface here. */
import { sessionWrite, type WriteResult } from "../session.ts";
export interface DesktopApproval {
  userCode: string; deviceId: string; purpose: "session" | "extensions" | "imports";
  state: "pending" | "approved" | "declined"; expiresAt: number;
}
interface Options {
  now?(): number;
  fetch?(path: string, init?: RequestInit): Promise<Response>;
  write?(method: "POST", path: string, body: unknown): Promise<WriteResult>;
}
function code(input: string): string {
  if (input.length > 32) throw new Error("invalid-code");
  const compact = input.trim().toUpperCase().replace(/[ -]/g, "");
  if (!/^[A-Z2-9]{8}$/.test(compact)) throw new Error("invalid-code");
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}
function details(raw: unknown, expected: string, schema: string, now: number): DesktopApproval {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("unavailable");
  const value = raw as Record<string, unknown>;
  const fields = ["schema", "userCode", "deviceId", "purpose", "state", "expiresAt"];
  if (Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key))
    || value.schema !== schema || value.userCode !== expected || typeof value.deviceId !== "string"
    || !value.deviceId || value.deviceId.length > 512 || /[\x00-\x1f\x7f]/.test(value.deviceId)
    || !["session", "extensions", "imports"].includes(String(value.purpose))
    || !["pending", "approved", "declined"].includes(String(value.state)) || !Number.isSafeInteger(value.expiresAt)) throw new Error("unavailable");
  if ((value.expiresAt as number) <= now) throw new Error("expired");
  return { userCode: expected, deviceId: value.deviceId, purpose: value.purpose as DesktopApproval["purpose"],
    state: value.state as DesktopApproval["state"], expiresAt: value.expiresAt as number };
}
export class DesktopApprovalClient {
  readonly #options: Options;
  constructor(options: Options = {}) { this.#options = options; }
  async lookup(input: string): Promise<DesktopApproval> {
    const userCode = code(input);
    let response: Response;
    try { response = await (this.#options.fetch ?? fetch)(`/api/v1/desktop/step-up/approval/${userCode}`,
      { credentials: "same-origin", headers: { accept: "application/json" } }); }
    catch { throw new Error("network"); }
    if (!response.ok) {
      let reason: unknown;
      try { reason = (await response.json() as { reason?: unknown }).reason; } catch { /* Fixed refusal below, never a server body. */ }
      throw new Error(reason === "second-factor-required" ? "fresh-mfa" : response.status === 403 ? "denied" : "unavailable");
    }
    let raw: unknown;
    try { raw = await response.json(); } catch { throw new Error("unavailable"); }
    return details(raw, userCode, "desktop.step-up.approval/1", this.#options.now?.() ?? Date.now());
  }
  async decide(input: string, decision: "approve" | "decline"): Promise<DesktopApproval> {
    const userCode = code(input);
    const result = await (this.#options.write ?? sessionWrite)("POST", "/api/v1/desktop/step-up/decision", { userCode, decision });
    if (!result.ok) throw new Error(result.failure.kind === "network" ? "network"
      : result.failure.kind === "server" && result.failure.status === 403 ? "fresh-mfa" : "unavailable");
    return details(result.body, userCode, "desktop.step-up.decision/1", this.#options.now?.() ?? Date.now());
  }
}
