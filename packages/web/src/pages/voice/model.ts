// Pure parts of the Voice pages (no DOM): licence classification, profile preselection, download progress, the realtime profile
// draft and what it sends. Shared by Settings > Voice, the per-agent override and the setup step.
import type {
  VoiceDownloadProgress, VoiceErrorCode, VoiceFeatureMode, VoiceFeatureName, VoiceFeatureSetting, VoiceLanguage, VoiceModel,
  VoiceProfileName, VoiceProfileSetParams, VoiceRealtimeProfile, VoiceRealtimeProfileInput,
} from "../../api/voice.types.ts";
import { VOICE_ERROR_CODES, VOICE_FEATURES } from "../../api/voice.types.ts";

// ---- Errors -------------------------------------------------------------------------------------------------------

/** The E_VOICE_* code of a rejected call, or null. The client maps only the closed ErrorCode list, so the raw `error.data.error` is read here. */
export function voiceErrorOf(e: unknown): VoiceErrorCode | null {
  const d = typeof e === "object" && e !== null ? (e as { data?: unknown }).data : undefined;
  const c = typeof d === "object" && d !== null ? (d as { error?: unknown }).error : undefined;
  if ((VOICE_ERROR_CODES as readonly unknown[]).includes(c)) return c as VoiceErrorCode;
  const ec = typeof e === "object" && e !== null ? (e as { errorCode?: unknown }).errorCode : undefined;
  if ((VOICE_ERROR_CODES as readonly unknown[]).includes(ec)) return ec as VoiceErrorCode;
  const msg = typeof e === "object" && e !== null ? (e as { message?: unknown }).message : undefined;
  if ((VOICE_ERROR_CODES as readonly unknown[]).includes(msg)) return msg as VoiceErrorCode;
  return null;
}


// ---- Models and licences ------------------------------------------------------------------------------------------

/** Licences the harness knows to be research-only / non-commercial. Matching is on the licence id as the server sends it, never on a link. */
const RESEARCH_IDS = new Set(["blizzard-2013", "blizzard", "lessac-research", "research-only", "research"]);
export function isResearchOnly(licenceId: string): boolean {
  const id = licenceId.trim().toLowerCase();
  if (RESEARCH_IDS.has(id)) return true;
  return /(^|[-_. ])(nc|non-?commercial|research(-only)?)([-_. ]|$)/.test(id);
}
export const modelNeedsResearchWarning = (m: VoiceModel): boolean => isResearchOnly(m.licenceId);

/** The key a licence confirmation travels under: `"modelId@licenceId"`. */
export const licenceKey = (m: Pick<VoiceModel, "modelId" | "licenceId">): string => `${m.modelId}@${m.licenceId}`;

/** Models of a profile that would be downloaded and need a confirmation first. Installed models were accepted when they were fetched. */
export const confirmationsNeeded = (models: readonly VoiceModel[]): VoiceModel[] => models.filter((m) => m.needsConfirmation && !m.installed);
export const missingModels = (models: readonly VoiceModel[]): VoiceModel[] => models.filter((m) => !m.installed);

/** Whether every needed confirmation is ticked (the Apply button stays disabled until it is). */
export function allConfirmed(models: readonly VoiceModel[], ticked: ReadonlySet<string>): boolean {
  return confirmationsNeeded(models).every((m) => ticked.has(licenceKey(m)));
}
export function acceptList(models: readonly VoiceModel[], ticked: ReadonlySet<string>): string[] {
  return confirmationsNeeded(models).map(licenceKey).filter((k) => ticked.has(k));
}

export const modelsOf = (lang: VoiceLanguage | undefined, profile: VoiceProfileName): VoiceModel[] => lang?.profiles[profile]?.models ?? [];
export const totalBytes = (models: readonly VoiceModel[]): number => models.reduce((n, m) => n + (Number.isFinite(m.sizeBytes) ? m.sizeBytes : 0), 0);
export const hasResearchModel = (models: readonly VoiceModel[]): boolean => models.some(modelNeedsResearchWarning);

// ---- Preselection (setup) -----------------------------------------------------------------------------------------

/** The profile the setup step offers for a language. English prefers quality (Kokoro) over fast; every other language prefers fast.
 *  A profile with a research-only model is never preselected (a person has to pick it, and confirm it, themselves): null when
 *  nothing else is left. */
export function preselectProfile(lang: VoiceLanguage | undefined): VoiceProfileName | null {
  if (!lang) return null;
  const order: VoiceProfileName[] = lang.language.toLowerCase().startsWith("en") ? ["quality", "fast"] : ["fast", "quality"];
  return order.find((p) => lang.profiles[p] && !hasResearchModel(modelsOf(lang, p))) ?? null;
}

/** The offered language matching the browser / system locale (`de-DE` -> `de`). An unmatched locale returns "": nothing is preselected silently. */
export function systemLanguage(locale: string | undefined, languages: readonly VoiceLanguage[]): string {
  const want = (locale ?? "").toLowerCase();
  if (want === "") return "";
  const exact = languages.find((l) => l.language.toLowerCase() === want);
  if (exact) return exact.language;
  const base = want.split(/[-_]/)[0]!;
  return languages.find((l) => l.language.toLowerCase() === base || l.language.toLowerCase().split(/[-_]/)[0] === base)?.language ?? "";
}

// ---- Sizes --------------------------------------------------------------------------------------------------------

/** 1536 -> "1.5 KiB"; the unit is never localised, the decimal separator follows `locale`. */
export function formatBytes(n: number, locale?: string): string {
  if (!Number.isFinite(n) || n < 0) return "–";
  const units = ["B", "KiB", "MiB", "GiB"];
  let v = n; let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  const s = i === 0 ? String(Math.round(v)) : new Intl.NumberFormat(locale, { maximumFractionDigits: v >= 100 ? 0 : 1 }).format(v);
  return `${s} ${units[i]}`;
}

// ---- Download progress --------------------------------------------------------------------------------------------

export type DownloadState = { receivedBytes: number; totalBytes: number; done: boolean; error?: string };
export type Downloads = Readonly<Record<string, DownloadState>>;

/** Parses the data of a `voice.download.progress` event; null for anything that is not one. */
export function parseProgress(data: string): VoiceDownloadProgress | null {
  try {
    const o = JSON.parse(data) as Record<string, unknown>;
    if (typeof o.modelId !== "string" || typeof o.receivedBytes !== "number" || typeof o.totalBytes !== "number" || typeof o.done !== "boolean") return null;
    return { modelId: o.modelId, receivedBytes: o.receivedBytes, totalBytes: o.totalBytes, done: o.done, ...(typeof o.error === "string" ? { error: o.error } : {}) };
  } catch { return null; }
}
export function applyProgress(d: Downloads, p: VoiceDownloadProgress): Downloads {
  return { ...d, [p.modelId]: { receivedBytes: p.receivedBytes, totalBytes: p.totalBytes, done: p.done, ...(p.error !== undefined ? { error: p.error } : {}) } };
}
export const percentOf = (s: DownloadState | undefined): number => (!s ? 0 : s.done && !s.error ? 100 : s.totalBytes > 0 ? Math.min(100, Math.floor((s.receivedBytes / s.totalBytes) * 100)) : 0);

export type DownloadSummary = { status: "idle" | "running" | "done" | "failed"; percent: number; failed: string[] };
/** Overall state of the downloads of `ids` (the models the Apply call has to fetch). */
export function summarize(ids: readonly string[], d: Downloads): DownloadSummary {
  if (ids.length === 0) return { status: "idle", percent: 0, failed: [] };
  const failed = ids.filter((id) => d[id]?.error !== undefined);
  const all = ids.every((id) => d[id]?.done === true && d[id]?.error === undefined);
  const percent = Math.floor(ids.reduce((n, id) => n + percentOf(d[id]), 0) / ids.length);
  return { status: failed.length > 0 ? "failed" : all ? "done" : "running", percent, failed };
}

// ---- Realtime profile ---------------------------------------------------------------------------------------------

export const ENDPOINTING = { min: 200, max: 2000, step: 50 } as const;
export const BUDGET_MS = { min: 0, max: 60_000 } as const;
export const MODES: readonly VoiceFeatureMode[] = ["on", "deferred", "off"];
export const modesOf = (f: VoiceFeatureName): readonly VoiceFeatureMode[] => (f === "toolSchemas" ? ["on", "deferred", "reduced", "off"] : MODES);

export type Draft = VoiceRealtimeProfileInput;

/** The editable part of a profile: `effective` is read-only and never goes back. */
export function draftOf(p: VoiceRealtimeProfile): Draft {
  const features = {} as Record<VoiceFeatureName, VoiceFeatureSetting>;
  for (const f of VOICE_FEATURES) {
    const s = p.features[f];
    features[f] = { mode: s?.mode ?? "on", ...(s?.maxMs !== undefined ? { maxMs: s.maxMs } : {}) };
  }
  return { enabled: p.enabled, endpointingMs: p.endpointingMs, speculative: p.speculative, ackSound: p.ackSound, features };
}

/** The exact params of `voice.realtime.profile.set`. */
export function setParams(d: Draft, agentId?: string): VoiceProfileSetParams {
  const features = {} as Record<VoiceFeatureName, VoiceFeatureSetting>;
  for (const f of VOICE_FEATURES) {
    const s = d.features[f];
    features[f] = { mode: s.mode, ...(s.maxMs !== undefined ? { maxMs: s.maxMs } : {}) };
  }
  return { enabled: d.enabled, endpointingMs: d.endpointingMs, speculative: d.speculative, ackSound: d.ackSound, features, ...(agentId !== undefined ? { agentId } : {}) };
}

export const sameDraft = (a: Draft, b: Draft): boolean => JSON.stringify(setParams(a)) === JSON.stringify(setParams(b));

/** Which top-level fields of `agent` differ from `base` (the global profile): those are the overridden ones; the rest is inherited. */
export type FieldId = "enabled" | "endpointingMs" | "speculative" | "ackSound" | `feature.${VoiceFeatureName}`;
export function overriddenFields(agent: Draft, base: Draft): Set<FieldId> {
  const out = new Set<FieldId>();
  for (const k of ["enabled", "endpointingMs", "speculative", "ackSound"] as const) if (agent[k] !== base[k]) out.add(k);
  for (const f of VOICE_FEATURES) if (JSON.stringify(agent.features[f]) !== JSON.stringify(base.features[f])) out.add(`feature.${f}`);
  return out;
}

export const clampInt = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, Math.round(v)));
/** The value of a number input, or `undefined` for an empty or invalid one. */
export function parseBudget(raw: string): number | undefined {
  if (raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? clampInt(n, BUDGET_MS.min, BUDGET_MS.max) : undefined;
}

/** `Math.round`ed ms with the locale's number format. */
export const msText = (n: number, locale?: string): string => `${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(n)} ms`;
