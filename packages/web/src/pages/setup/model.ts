import { missingPrivacy, type SetupPrivacy } from "./privacy.ts";
// Wizard state, step list, validation and request parameters (pure; no DOM). The saved state holds non-secret answers only:
// the owner token is never put in it (steps.ts keeps the token in a local field until it has been sent).
import { getPref, setPref } from "../../prefs.ts";
import { activeChoice, choiceById, engineBlock, memoryChoice, type MemoryModels, type ModelKind } from "./licences.ts";
import { CAPTION_CHOICES, CAPTION_SOURCES, mediaSetupChanges, mediaSetupDefaults, validateMedia, type CaptionChoice, type MediaSetup } from "../media-search/model.ts";
import { ALL_MODALITIES } from "../media-search/model.ts";
import type { VoiceProfileName } from "../../api/voice.types.ts";
import type { CaptionSourceSetting, MediaBackfillSetting, MediaModality } from "../media-search/contract.ts";

export type StepId = "account" | "persona" | "model" | "decision" | "switchboard" | "memory" | "voice" | "backup" | "import";
export type Status = "done" | "skipped";
export type UseClass = "general" | "research" | "commercial";
export const USE_CLASSES: readonly UseClass[] = ["general", "research", "commercial"];

export type VoiceChoice = { language: string; profile: VoiceProfileName };
export type StepDef = { id: StepId; skippable: boolean; unavailable: boolean };
/**
 * The nine steps; `?mode=bundled` leaves out the account step (a bundled app signs in by itself). Memory comes before the
 * persona: creating the first agent creates its memory table in the active embedding model, and a store with a table keeps that
 * model (another one needs `plur1bus memory reembed`).
 */
export const STEPS: readonly StepDef[] = [
  { id: "account", skippable: false, unavailable: false },
  { id: "memory", skippable: true, unavailable: false },
  { id: "persona", skippable: false, unavailable: false },
  { id: "model", skippable: true, unavailable: false },
  { id: "decision", skippable: true, unavailable: false },
  { id: "switchboard", skippable: true, unavailable: true },
  { id: "voice", skippable: true, unavailable: false },
  { id: "backup", skippable: true, unavailable: false },
  { id: "import", skippable: true, unavailable: true },
];
export const stepsFor = (bundled: boolean): readonly StepDef[] => (bundled ? STEPS.filter((s) => s.id !== "account") : STEPS);

export type Nc = { at: string; who: string };
export type Answers = {
  agentId: string; displayName: string; createdAt: string; chatModel: string; decisionModel?: string;
  /** The person's picks in the Memory step (ids of licences.ts); "" = not picked, see `memoryChoice`. */
  useClass: UseClass; embedding: string; rerank: string;
  /** What the engine runs, loaded by the Memory step (`model.memory.status`); never restored from browser storage. */
  memoryModels?: MemoryModels | undefined;
  /** The confirmed NC-licence acceptance (who = principal id, at = ISO time); null = declined / never asked. */
  nc: Nc | null;
  /** The acceptance flag is in config.json already (so unselecting an NC model writes `false` again). */
  ncWritten: boolean;
  backupId: string;
  /** The media index part of the Memory step (media-search/model.ts). */
  media: MediaSetup;
  /** The voice language the person downloaded in the Voice step; null = not done (the step is then skipped). */
  voice: VoiceChoice | null;
  /** Ephemeral function-specific confirmations; never restored from browser storage. */
  privacy?: SetupPrivacy;
};
export type Saved = { v: 1; step: StepId | "summary"; status: Partial<Record<StepId, Status>>; answers: Answers };

export const initial = (): Saved => ({
  v: 1, step: "account", status: {},
  answers: { agentId: "main", displayName: "", createdAt: "", chatModel: "", decisionModel: "", useClass: "general", embedding: "", rerank: "", nc: null, ncWritten: false, backupId: "", media: mediaSetupDefaults(), voice: null },
});

/** The embedding or reranker choice of the Memory step (licences.ts `memoryChoice`). */
export const chosen = (kind: ModelKind, a: Answers): string => memoryChoice(kind, kind === "embedding" ? a.embedding : a.rerank, a.memoryModels);

const KEY = "setup";
const str = (v: unknown, d: string): string => (typeof v === "string" ? v : d);

/** Reads the saved state; anything unexpected (corrupt JSON, wrong types, an NC model without a recorded confirmation) falls back to the defaults. */
export function load(): Saved {
  const base = initial();
  try {
    const raw = getPref(KEY);
    if (!raw) return base;
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (o.v !== 1 || typeof o.answers !== "object" || o.answers === null) return base;
    const a = o.answers as Record<string, unknown>;
    const nc = typeof a.nc === "object" && a.nc !== null && typeof (a.nc as Nc).at === "string" && typeof (a.nc as Nc).who === "string" ? { at: (a.nc as Nc).at, who: (a.nc as Nc).who } : null;
    const answers: Answers = {
      agentId: str(a.agentId, base.answers.agentId), displayName: str(a.displayName, ""), createdAt: str(a.createdAt, ""), chatModel: str(a.chatModel, ""), decisionModel: str(a.decisionModel, ""),
      useClass: USE_CLASSES.includes(a.useClass as UseClass) ? (a.useClass as UseClass) : "general",
      embedding: str(a.embedding, ""), rerank: str(a.rerank, ""), nc, ncWritten: a.ncWritten === true, backupId: str(a.backupId, ""),
      media: loadMedia(a.media), voice: loadVoice(a.voice),
    };
    // A non-commercial model is only ever kept together with its confirmation (and never for the commercial use class); an
    // unknown or withdrawn id is "not picked".
    const bad = (id: string, kind: ModelKind): boolean => { const c = choiceById(id); return !c || c.kind !== kind || (c.nc && (nc === null || answers.useClass === "commercial")); };
    if (bad(answers.embedding, "embedding")) answers.embedding = "";
    if (bad(answers.rerank, "rerank")) answers.rerank = "";
    const status: Saved["status"] = {};
    for (const s of STEPS) { const v = (typeof o.status === "object" && o.status !== null ? (o.status as Record<string, unknown>)[s.id] : undefined); if (v === "done" || v === "skipped") status[s.id] = v; }
    const step = o.step === "summary" || STEPS.some((s) => s.id === o.step) ? (o.step as Saved["step"]) : "account";
    return { v: 1, step, status, answers };
  } catch { return base; }
}
export function save(s: Saved): void { try { const { privacy: _privacy, memoryModels: _models, ...answers } = s.answers; setPref(KEY, JSON.stringify({ ...s, answers })); } catch { /* the wizard works without storage */ } }

export const AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export type Errors = Partial<Record<"agentId" | "displayName" | "chatModel" | "backup" | "account", "required" | "format" | "tooLong" | "signin">> & { media?: string };

/** Per-step validation; an empty object lets the person go on. */
export function validate(step: StepId, a: Answers, signedIn: boolean): Errors {
  const e: Errors = {};
  if (step === "account" && !signedIn) e.account = "signin";
  if (step === "persona") {
    if (a.agentId === "") e.agentId = "required"; else if (!AGENT_ID.test(a.agentId)) e.agentId = "format";
    const n = a.displayName.trim();
    if (n === "") e.displayName = "required"; else if (n.length > 128) e.displayName = "tooLong";
  }
  if (step === "model" && a.chatModel === "") e.chatModel = "required";
  if (step === "backup" && a.backupId === "") e.backup = "required";
  if (step === "memory") {
    const first = validateMedia({ textProvider: chosen("embedding", a), media: a.media, privacyPin: false, ncConfirmed: a.nc !== null })[0];
    if (first) e.media = first.code;
    else if (missingPrivacy(a)) e.media = "E_MEDIA_PRIVACY";
  }
  return e;
}

export type Change = { key: string; value: unknown };
/** The `config.set` changes a step writes (the exact params the tests pin). */
export function changesFor(step: StepId, a: Answers): Change[] {
  if (step === "persona") return [{ key: `agents.${a.agentId}`, value: { displayName: a.displayName.trim(), createdAt: a.createdAt } }];
  if (step === "model") return [{ key: "modelRoles.chat", value: a.chatModel }];
  if (step === "decision") return a.decisionModel ? [{ key: "modelRoles.decision", value: a.decisionModel }] : [];
  if (step !== "memory") return [];
  const picks = (["embedding", "rerank"] as const).map((kind) => choiceById(chosen(kind, a)));
  const wantsNc = picks.some((c) => c?.nc === true);
  const out: Change[] = [{ key: "embedding.useClass", value: a.useClass }];
  if (wantsNc && a.nc) out.push({ key: "embedding.acceptedNcLicence", value: true }, { key: "embedding.acceptedNcLicenceAt", value: a.nc.at });
  else if (a.ncWritten) out.push({ key: "embedding.acceptedNcLicence", value: false });
  // The engine reads its models from engine.embedding and engine.reranker (buildEngineConfig); a model is written only when it
  // differs from what runs, and only with the engine's answer at hand (memoryChoice keeps a store with data on its embedding).
  const m = a.memoryModels;
  if (m) for (const c of picks) if (c && c.id !== activeChoice(c.kind, m)) out.push(engineBlock(c));
  out.push(...mediaSetupChanges(a.media, chosen("embedding", a)));
  return out;
}

/** Reads the saved voice answer; anything unexpected means "not done". */
function loadVoice(raw: unknown): VoiceChoice | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  return typeof o.language === "string" && o.language !== "" && (o.profile === "fast" || o.profile === "quality") ? { language: o.language, profile: o.profile } : null;
}

/** Reads the saved media answers; anything unexpected falls back to the contract defaults. */
function loadMedia(raw: unknown): MediaSetup {
  const d = mediaSetupDefaults();
  if (typeof raw !== "object" || raw === null) return d;
  const o = raw as Record<string, unknown>;
  const modalities = Array.isArray(o.modalities) ? o.modalities.filter((x): x is MediaModality => ALL_MODALITIES.includes(x as MediaModality)) : d.modalities;
  return {
    enabled: typeof o.enabled === "boolean" ? o.enabled : d.enabled,
    provider: typeof o.provider === "string" ? o.provider : d.provider,
    modalities: [...new Set(modalities)],
    caption: CAPTION_CHOICES.includes(o.caption as CaptionChoice) ? (o.caption as CaptionChoice) : null,
    captionSource: CAPTION_SOURCES.includes(o.captionSource as CaptionSourceSetting) ? (o.captionSource as CaptionSourceSetting) : d.captionSource,
    backfill: o.backfill === "manual" ? ("manual" as MediaBackfillSetting) : d.backfill,
  };
}
