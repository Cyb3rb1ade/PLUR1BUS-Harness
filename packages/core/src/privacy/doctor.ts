// Doctor finding for privacy.localOnly: while the switch is on (installation or any agent), every configured cloud model
// provider is reported as a failure, so the person sees what will be refused before a turn, a voice call or the engine
// start runs into it. Read-only: nothing is changed and no provider is contacted.
import { engineModelEndpoints } from "../composition/embedding-policy.ts";
import { isLocalEndpoint, localEndpoints, localOnlyInstallation, localOnlyShared, localOnlyAgents } from "./local-only.ts";

export type PrivacyCheck = { id: string; status: "ok" | "fail"; summary: string; repair?: { kind: string; label: string } };

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? v as Obj : {});
const MEDIA_LOCAL = new Set(["local", "local-transformers", "egemma2", "off"]);
const MEDIA_DEFAULTS: Record<string, string> = { "coreml-local": "", "draw-things": "http://127.0.0.1:7860" };

/** The cloud model configuration that privacy.localOnly would refuse, as short human-readable items (no secrets, origins only). */
export function localOnlyFindings(cfg: unknown, sharedOnly = false): string[] {
  const c = obj(cfg), listed = localEndpoints(cfg), out: string[] = [];
  const local = (url: unknown) => typeof url === "string" && isLocalEndpoint(url, listed);
  if (!sharedOnly) {
  for (const [id, raw] of Object.entries(obj(c.providers))) {
    const def = obj(raw);
    if (!("wireFormat" in def)) continue;
    const base = obj(def.profile).base_url;
    if (!local(base)) out.push(`chat provider ${id}`);
  }
  for (const a of Array.isArray(obj(obj(c.providers).media).adapters) ? obj(obj(c.providers).media).adapters as unknown[] : []) {
    const d = obj(a), id = String(d.id ?? "unknown");
    if (id === "coreml-local") continue;
    if (!local(d.baseUrl ?? MEDIA_DEFAULTS[id])) out.push(`media adapter ${id}`);
  }
  for (const [id, raw] of Object.entries(obj(obj(c.voice).providers))) {
    const p = obj(raw);
    if (p.enabled === true && !local(p.baseUrl)) out.push(`voice provider ${id}`);
  }
  }
  const media = obj(obj(c.memory).mediaEmbedding);
  if (media.enabled !== false && typeof media.provider === "string" && !MEDIA_LOCAL.has(media.provider)) out.push(`media index provider ${media.provider}`);
  const caption = obj(media.caption);
  if (typeof caption.provider === "string" && !MEDIA_LOCAL.has(caption.provider) && caption.source !== "off") out.push(`caption provider ${caption.provider}`);
  for (const e of engineModelEndpoints(obj(c.engine))) if (!local(e.endpoint)) out.push(`engine ${e.role}`);
  return out;
}

export function localOnlyCheck(cfg: unknown): PrivacyCheck {
  const on = localOnlyShared(cfg);
  if (!on) return { id: "privacy.local-only", status: "ok", summary: "privacy.localOnly is off: cloud models may be used where they are configured and acknowledged." };
  const scope = localOnlyInstallation(cfg) ? "installation-wide" : `for at least one agent (${localOnlyAgents(cfg).join(", ")})`;
  const findings = localOnlyFindings(cfg, !localOnlyInstallation(cfg));
  if (!findings.length) return { id: "privacy.local-only", status: "ok", summary: `privacy.localOnly is on ${scope}; no cloud model is configured.` };
  const shown = findings.slice(0, 8).join(", ") + (findings.length > 8 ? `, and ${findings.length - 8} more` : "");
  return { id: "privacy.local-only", status: "fail", summary: `privacy.localOnly is on ${scope}, but cloud models are configured and will be refused: ${shown}.`,
    repair: { kind: "hint", label: "Switch these to a local model, list your own model server in privacy.localEndpoints, or turn privacy.localOnly off (Settings > Privacy)." } };
}
