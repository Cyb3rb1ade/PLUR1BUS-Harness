// Wizard state, step list, validation and request parameters (pure; no DOM). The saved state holds non-secret answers only:
// the owner token is never put in it (steps.ts keeps the token in a local field until it has been sent).
import { getPref, setPref } from "../../prefs.ts";
import { DEFAULT_EMBEDDING, DEFAULT_RERANK, choiceById } from "./licences.ts";
import { CAPTION_CHOICES, CAPTION_SOURCES, mediaSetupChanges, mediaSetupDefaults, validateMedia, type CaptionChoice, type MediaSetup } from "../media-search/model.ts";
import { ALL_MODALITIES } from "../media-search/model.ts";
import type { CaptionSourceSetting, MediaBackfillSetting, MediaModality } from "../media-search/contract.ts";

export type StepId = "account" | "persona" | "model" | "switchboard" | "memory" | "backup" | "import";
export type Status = "done" | "skipped";
export type UseClass = "general" | "research" | "commercial";
export const USE_CLASSES: readonly UseClass[] = ["general", "research", "commercial"];

export type StepDef = { id: StepId; skippable: boolean; unavailable: boolean };
/** The seven steps; `?mode=bundled` leaves out the account step (a bundled app signs in by itself). */
export const STEPS: readonly StepDef[] = [
  { id: "account", skippable: false, unavailable: false },
  { id: "persona", skippable: false, unavailable: false },
  { id: "model", skippable: true, unavailable: false },
  { id: "switchboard", skippable: true, unavailable: true },
  { id: "memory", skippable: true, unavailable: false },
  { id: "backup", skippable: true, unavailable: false },
  { id: "import", skippable: true, unavailable: true },
];
export const stepsFor = (bundled: boolean): readonly StepDef[] => (bundled ? STEPS.filter((s) => s.id !== "account") : STEPS);

export type Nc = { at: string; who: string };
export type Answers = {
  agentId: string; displayName: string; createdAt: string; chatModel: string;
  useClass: UseClass; embedding: string; rerank: string;
  /** The confirmed NC-licence acceptance (who = principal id, at = ISO time); null = declined / never asked. */
  nc: Nc | null;
  /** The acceptance flag is in config.json already (so unselecting an NC model writes `false` again). */
  ncWritten: boolean;
  backupId: string;
  /** The media index part of the Memory step (media-search/model.ts). */
  media: MediaSetup;
};
export type Saved = { v: 1; step: StepId | "summary"; status: Partial<Record<StepId, Status>>; answers: Answers };

export const initial = (): Saved => ({
  v: 1, step: "account", status: {},
  answers: { agentId: "main", displayName: "", createdAt: "", chatModel: "", useClass: "general", embedding: DEFAULT_EMBEDDING, rerank: DEFAULT_RERANK, nc: null, ncWritten: false, backupId: "", media: mediaSetupDefaults() },
});

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
      agentId: str(a.agentId, base.answers.agentId), displayName: str(a.displayName, ""), createdAt: str(a.createdAt, ""), chatModel: str(a.chatModel, ""),
      useClass: USE_CLASSES.includes(a.useClass as UseClass) ? (a.useClass as UseClass) : "general",
      embedding: str(a.embedding, DEFAULT_EMBEDDING), rerank: str(a.rerank, DEFAULT_RERANK), nc, ncWritten: a.ncWritten === true, backupId: str(a.backupId, ""),
      media: loadMedia(a.media),
    };
    // A non-commercial model is only ever kept together with its confirmation (and never for the commercial use class).
    const bad = (id: string, kind: "embedding" | "rerank"): boolean => { const c = choiceById(id); return !c || c.kind !== kind || (c.nc && (nc === null || answers.useClass === "commercial")); };
    if (bad(answers.embedding, "embedding")) answers.embedding = DEFAULT_EMBEDDING;
    if (bad(answers.rerank, "rerank")) answers.rerank = DEFAULT_RERANK;
    const status: Saved["status"] = {};
    for (const s of STEPS) { const v = (typeof o.status === "object" && o.status !== null ? (o.status as Record<string, unknown>)[s.id] : undefined); if (v === "done" || v === "skipped") status[s.id] = v; }
    const step = o.step === "summary" || STEPS.some((s) => s.id === o.step) ? (o.step as Saved["step"]) : "account";
    return { v: 1, step, status, answers };
  } catch { return base; }
}
export function save(s: Saved): void { try { setPref(KEY, JSON.stringify(s)); } catch { /* the wizard works without storage */ } }

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
    const first = validateMedia({ textProvider: a.embedding, media: a.media, privacyPin: false, ncConfirmed: a.nc !== null })[0];
    if (first) e.media = first.code;
  }
  return e;
}

export type Change = { key: string; value: unknown };
/** The `config.set` changes a step writes (the exact params the tests pin). */
export function changesFor(step: StepId, a: Answers): Change[] {
  if (step === "persona") return [{ key: `agents.${a.agentId}`, value: { displayName: a.displayName.trim(), createdAt: a.createdAt } }];
  if (step === "model") return [{ key: "modelRoles.chat", value: a.chatModel }];
  if (step !== "memory") return [];
  const rerank = choiceById(a.rerank);
  const wantsNc = [a.embedding, a.rerank].some((id) => choiceById(id)?.nc === true);
  const out: Change[] = [{ key: "embedding.useClass", value: a.useClass }];
  if (wantsNc && a.nc) out.push({ key: "embedding.acceptedNcLicence", value: true }, { key: "embedding.acceptedNcLicenceAt", value: a.nc.at });
  else if (a.ncWritten) out.push({ key: "embedding.acceptedNcLicence", value: false });
  if (rerank) out.push({ key: "modelRoles.rerank", value: rerank.hf });
  out.push(...mediaSetupChanges(a.media, a.embedding));
  return out;
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
