// Media search: pure rules shared by the setup step, the Memory settings, the agent override and the search view (no DOM).
// Everything here follows the binding contract (media-search-contract.md): free provider choice, validation only for
// capability, licence, privacy pin and availability, captioning preselected only when embedding is local, defaults as in
// the contract. Changes are sent only where a value differs from the contract default, so an untouched form writes nothing.
import type { MediaIndexKind, MediaSearchParams } from "../../../../rpc-schema/generated/types.ts";
import { MEDIA_EMBEDDING_DEFAULTS, isMediaErrorCode, type CaptionSourceSetting, type MediaBackfillSetting, type MediaCapabilities, type MediaErrorCode, type MediaModality } from "./contract.ts";
import { t, type Key } from "../../i18n.ts";
import { DEFAULT_EMBEDDING, choiceById, choicesOf } from "../setup/licences.ts";

export const MEDIA_KINDS: readonly MediaIndexKind[] = ["image", "video", "audio"];
export const ALL_MODALITIES: readonly MediaModality[] = ["image", "video", "audio"];
export const SEARCH_LIMIT = 20;

// ---- Providers -----------------------------------------------------------------------------------------------------

/** One selectable provider. Local ones come from the setup model table (licences.ts). `openai` is the one cloud provider
 * the forms offer; it serves text only, so it can never be the media index (contract example "OpenAI-Text + Gemma-Medien"). */
export type ProviderOption = { id: string; name: string; local: boolean; caps: MediaCapabilities; licence: string; nc: boolean; dims: readonly number[] };
export const CLOUD_CAPTION_PROVIDER = "openai";

// Modality capability of the local models. Until the catalogue RPC carries `capabilities` (contract: additive extension),
// this table is the client's copy; only EmbeddingGemma 2 is multimodal among the models the setup offers.
const MEDIA_CAPS: Readonly<Record<string, MediaCapabilities>> = {
  egemma2: { text: true, image: true, video: true, audio: true },
};
const TEXT_ONLY: MediaCapabilities = { text: true, image: false, video: false, audio: false };
const DIMS_GEMMA = [768, 512, 256, 128] as const;

export const TEXT_PROVIDERS: readonly ProviderOption[] = [
  ...choicesOf("embedding").map((c): ProviderOption => ({
    id: c.id, name: c.name, local: true, caps: MEDIA_CAPS[c.id] ?? TEXT_ONLY, licence: c.licence, nc: c.nc,
    dims: c.id === "egemma2" ? DIMS_GEMMA : [],
  })),
  { id: CLOUD_CAPTION_PROVIDER, name: "OpenAI (cloud)", local: false, caps: TEXT_ONLY, licence: "—", nc: false, dims: [] },
];

/** Providers that can serve the media index: must have every modality the caller asks for (checked in validation). */
export const MEDIA_PROVIDERS: readonly ProviderOption[] = TEXT_PROVIDERS.filter((p) => p.local && p.caps.image);

export const providerById = (id: string): ProviderOption | undefined => TEXT_PROVIDERS.find((p) => p.id === id);
export const isLocalProvider = (id: string): boolean => providerById(id)?.local === true;

// ---- Captioning ------------------------------------------------------------------------------------------------------

/** Caption source: `local` (the local captioner), `off`, or the cloud provider id. */
export type CaptionChoice = "local" | "off" | typeof CLOUD_CAPTION_PROVIDER;
export const CAPTION_CHOICES: readonly CaptionChoice[] = ["local", CLOUD_CAPTION_PROVIDER, "off"];
export const CAPTION_SOURCES: readonly CaptionSourceSetting[] = ["prompt-then-user-then-auto", "user-only", "off"];

/** Captioning preselection (contract): local when embedding is local; with cloud embedding nothing is preselected. */
export function captionPreselection(textProvider: string): CaptionChoice | null {
  return isLocalProvider(textProvider) ? "local" : null;
}

// ---- Setup answers -----------------------------------------------------------------------------------------------------

/** The media part of the wizard's answers. `caption: null` means "not chosen"; the preselection applies to it (see effective). */
export type MediaSetup = {
  enabled: boolean;
  provider: string;
  modalities: MediaModality[];
  caption: CaptionChoice | null;
  captionSource: CaptionSourceSetting;
  backfill: MediaBackfillSetting;
};
export const mediaSetupDefaults = (): MediaSetup => ({
  enabled: true, provider: DEFAULT_EMBEDDING, modalities: [...ALL_MODALITIES], caption: null, captionSource: "prompt-then-user-then-auto", backfill: "auto",
});

/** The caption choice that applies: the user's answer, else the preselection for the text provider (null when cloud). */
export const effectiveCaption = (m: MediaSetup, textProvider: string): CaptionChoice | null => m.caption ?? captionPreselection(textProvider);

/** The E_MEDIA_* code of a rejected call, or null. The client maps only the closed ErrorCode list, so the raw `error.data.error`
 * is read here. */
export function mediaErrorOf(e: unknown): MediaErrorCode | null {
  const d = typeof e === "object" && e !== null ? (e as { data?: unknown }).data : undefined;
  const c = typeof d === "object" && d !== null ? (d as { error?: unknown }).error : undefined;
  return isMediaErrorCode(c) ? c : null;
}

// ---- Validation (client-side mirror of E_MEDIA_*; the server stays authoritative) -----------------------------------

export type MediaProblem = { code: MediaErrorCode | "caption-required" | "modalities-required"; field: "provider" | "modalities" | "caption" };
export type MediaCheckInput = { textProvider: string; media: MediaSetup; privacyPin: boolean; ncConfirmed: boolean };

/** Capability, licence, privacy pin, availability. A disabled media index needs no checks. Returns the problems, empty = ok. */
export function validateMedia(input: MediaCheckInput): MediaProblem[] {
  const { media: m } = input;
  if (!m.enabled) return [];
  const out: MediaProblem[] = [];
  if (m.modalities.length === 0) out.push({ code: "modalities-required", field: "modalities" });
  const p = providerById(m.provider);
  if (!p) out.push({ code: "E_MEDIA_UNAVAILABLE", field: "provider" });
  else if (!p.caps.image || m.modalities.some((mod) => !p.caps[mod])) out.push({ code: "E_MEDIA_CAPABILITY", field: "provider" });
  if (p?.nc && !input.ncConfirmed) out.push({ code: "E_MEDIA_LICENSE", field: "provider" });
  if (input.privacyPin && (p && !p.local || effectiveCaption(m, input.textProvider) === CLOUD_CAPTION_PROVIDER)) out.push({ code: "E_MEDIA_PRIVACY", field: "provider" });
  if (effectiveCaption(m, input.textProvider) === null) out.push({ code: "caption-required", field: "caption" });
  return out;
}

/** Setup: problems that block "Next" for the media part (caption must be chosen when embedding is cloud). */
export const blocksNext = (problems: readonly MediaProblem[]): boolean => problems.length > 0;

// ---- Config changes (memory.mediaEmbedding.*) ----------------------------------------------------------------------

export type Change = { key: string; value: unknown };
const PREFIX = "memory.mediaEmbedding";
const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x) => b.includes(x));

/** Media config changes from the setup answers: only what differs from the contract default. Empty when untouched. */
export function mediaSetupChanges(m: MediaSetup, textProvider: string): Change[] {
  const d = mediaSetupDefaults();
  const out: Change[] = [];
  if (m.enabled !== d.enabled) out.push({ key: `${PREFIX}.enabled`, value: m.enabled });
  if (!m.enabled) return out;
  if (m.provider !== d.provider) out.push({ key: `${PREFIX}.provider`, value: m.provider });
  if (!sameSet(m.modalities, ALL_MODALITIES)) out.push({ key: `${PREFIX}.modalities`, value: [...m.modalities] });
  const cap = effectiveCaption(m, textProvider);
  if (cap !== null && cap !== captionPreselection(textProvider)) out.push({ key: `${PREFIX}.caption.provider`, value: cap });
  if (cap === null) return out;
  if (m.captionSource !== d.captionSource) out.push({ key: `${PREFIX}.caption.source`, value: m.captionSource });
  if (m.backfill !== d.backfill) out.push({ key: `${PREFIX}.backfill`, value: m.backfill });
  return out;
}

// ---- Search ------------------------------------------------------------------------------------------------------------

export type SearchForm = { text: string; likeMediaId?: string; kinds: MediaIndexKind[]; fuseCaptions: boolean };

/** The schema's `kinds` is a tuple of one to three distinct kinds (generated), not an array; the form's list is always unique. */
function kindsTuple(list: readonly MediaIndexKind[]): NonNullable<MediaSearchParams["kinds"]> | undefined {
  const [a, b, c] = list;
  if (a === undefined || list.length > 3) return undefined;
  if (b === undefined) return [a];
  if (c === undefined) return [a, b];
  return [a, b, c];
}

/** The RPC params, or null when there is nothing to search for. Exactly one of `text` and `likeMediaId` is sent. */
export function searchParams(f: SearchForm): MediaSearchParams | null {
  const kinds = f.kinds.length === 0 || f.kinds.length === MEDIA_KINDS.length ? undefined : kindsTuple(f.kinds);
  const common = { limit: SEARCH_LIMIT, ...(kinds ? { kinds } : {}), ...(f.fuseCaptions ? { fuseCaptions: true } : {}) };
  if (f.likeMediaId) return { likeMediaId: f.likeMediaId, ...common };
  const text = f.text.trim();
  return text === "" ? null : { text, ...common };
}

/** The place of a segment as m:ss–m:ss, for video and audio hits. */
export function segmentLabel(startMs: number, endMs: number): string {
  return `${clock(startMs)}–${clock(endMs)}`;
}
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const mm = String(Math.floor((total % 3600) / 60)).padStart(h > 0 ? 2 : 1, "0");
  const ss = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Where a player jumps to for a segment hit, in seconds. */
export const jumpSeconds = (startMs: number): number => Math.max(0, startMs / 1000);

// ---- Roles and status ---------------------------------------------------------------------------------------------------

/** Index actions (pause, resume, reindex) are owner or admin (contract RBAC). */
export const canManageIndex = (role: string | undefined): boolean => role === "owner" || role === "admin";
/** Caption editing: anyone allowed to edit the medium; agents never (contract). Roles that may edit are approximated here. */
export const canEditCaption = (role: string | undefined): boolean => role === "owner" || role === "admin" || role === "operator";

export type BackfillView = { state: string; done: number; total: number; fraction: number; paused: string | null };
export function backfillView(b: { state: string; done: number; total: number; pausedReason?: string }): BackfillView {
  const fraction = b.total > 0 ? Math.min(1, b.done / b.total) : 0;
  return { state: b.state, done: b.done, total: b.total, fraction, paused: b.state === "paused" ? (b.pausedReason ?? "user") : null };
}

// ---- Agent override and suggestions -------------------------------------------------------------------------------------

/** Suggestion buttons only fill the media fields; they never switch a mode (contract: no preset mode). The text-index
 * suggestions of the contract's examples wait for the text-index keys (docs/web-ui.md, F49). */
export const SUGGESTIONS = [
  { id: "allMedia", modalities: [...ALL_MODALITIES] },
  { id: "imagesOnly", modalities: ["image"] as MediaModality[] },
] as const;

export const isNcTextChoice = (id: string): boolean => choiceById(id)?.nc === true;

/** Config keys of the override for one agent: `agents.<id>.memory.mediaEmbedding.<field>`, same structure as the global keys. */
export const overrideKey = (agentId: string, field: string): string => `agents.${agentId}.memory.mediaEmbedding.${field}`;

// ---- Problem texts ------------------------------------------------------------------------------------------------------

/** Problem code -> text key: the E_MEDIA_* codes of the contract and the two wizard checks. */
const PROBLEM_TEXT: Readonly<Record<string, Key>> = {
  E_MEDIA_CAPABILITY: "mediasearch.error.capability",
  E_MEDIA_LICENSE: "mediasearch.error.licence",
  E_MEDIA_PRIVACY: "mediasearch.error.privacy",
  E_MEDIA_UNAVAILABLE: "mediasearch.error.unavailable",
  E_MEDIA_DIMENSION: "mediasearch.error.dimension",
  E_MEDIA_UNSUPPORTED_KIND: "mediasearch.error.unsupportedKind",
  "caption-required": "mediasearch.setup.problem.captionRequired",
  "modalities-required": "mediasearch.setup.problem.modalitiesRequired",
};
/** The text of a problem code (E_MEDIA_* or a wizard check). */
export const problemText = (code: string): string => t(PROBLEM_TEXT[code] ?? "mediasearch.error.unknown");

// ---- Settings draft (the media index; the text index is not written yet, see docs/web-ui.md F49) -------------------------

export type MediaDraft = {
  enabled: boolean; provider: string; modalities: MediaModality[];
  video: { segmentSec: number; maxFrames: number; sceneDetect: boolean };
  audio: { segmentSec: number; maxSeconds: number };
  caption: { provider: string; source: string; maxChars: number; perSegment: boolean };
  backfill: "auto" | "manual";
};
export type ConfigChange = { key: string; value: unknown };
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** The effective draft: the saved `memory.mediaEmbedding` over the contract defaults. An unset caption provider is the
 * preselection for the default text provider (the text provider itself is not read here, see F49). */
export function draftOf(config: unknown): MediaDraft {
  const d = MEDIA_EMBEDDING_DEFAULTS;
  const root = isObj(config) && isObj(config.memory) && isObj(config.memory.mediaEmbedding) ? config.memory.mediaEmbedding : {};
  const get = (path: string[]): unknown => path.reduce<unknown>((a, k) => (isObj(a) ? a[k] : undefined), root);
  const str = (v: unknown, def: string): string => (typeof v === "string" ? v : def);
  const num = (v: unknown, def: number): number => (typeof v === "number" ? v : def);
  const bool = (v: unknown, def: boolean): boolean => (typeof v === "boolean" ? v : def);
  const raw = get(["modalities"]);
  const modalities = Array.isArray(raw) ? raw.filter((x): x is MediaModality => ALL_MODALITIES.includes(x as MediaModality)) : [...d.modalities];
  return {
    enabled: bool(get(["enabled"]), d.enabled),
    provider: str(get(["provider"]), d.provider),
    modalities,
    video: { segmentSec: num(get(["video", "segmentSec"]), d.video.segmentSec), maxFrames: num(get(["video", "maxFrames"]), d.video.maxFrames), sceneDetect: bool(get(["video", "sceneDetect"]), d.video.sceneDetect) },
    audio: { segmentSec: num(get(["audio", "segmentSec"]), d.audio.segmentSec), maxSeconds: num(get(["audio", "maxSeconds"]), d.audio.maxSeconds) },
    caption: {
      provider: str(get(["caption", "provider"]), captionPreselection(DEFAULT_EMBEDDING) ?? "off"),
      source: str(get(["caption", "source"]), d.caption.source),
      maxChars: num(get(["caption", "maxChars"]), d.caption.maxChars),
      perSegment: bool(get(["caption", "perSegment"]), d.caption.perSegment),
    },
    backfill: get(["backfill"]) === "manual" ? "manual" : "auto",
  };
}

/** The changed keys only, against the effective draft the form loaded. Empty when nothing changed. */
export function changesOf(before: MediaDraft, after: MediaDraft): ConfigChange[] {
  const p = "memory.mediaEmbedding";
  const out: ConfigChange[] = [];
  const b = before, a = after;
  if (b.enabled !== a.enabled) out.push({ key: `${p}.enabled`, value: a.enabled });
  if (b.provider !== a.provider) out.push({ key: `${p}.provider`, value: a.provider });
  if (b.modalities.join() !== a.modalities.join()) out.push({ key: `${p}.modalities`, value: [...a.modalities] });
  if (b.video.segmentSec !== a.video.segmentSec) out.push({ key: `${p}.video.segmentSec`, value: a.video.segmentSec });
  if (b.video.maxFrames !== a.video.maxFrames) out.push({ key: `${p}.video.maxFrames`, value: a.video.maxFrames });
  if (b.video.sceneDetect !== a.video.sceneDetect) out.push({ key: `${p}.video.sceneDetect`, value: a.video.sceneDetect });
  if (b.audio.segmentSec !== a.audio.segmentSec) out.push({ key: `${p}.audio.segmentSec`, value: a.audio.segmentSec });
  if (b.audio.maxSeconds !== a.audio.maxSeconds) out.push({ key: `${p}.audio.maxSeconds`, value: a.audio.maxSeconds });
  if (b.caption.provider !== a.caption.provider) out.push({ key: `${p}.caption.provider`, value: a.caption.provider });
  if (b.caption.source !== a.caption.source) out.push({ key: `${p}.caption.source`, value: a.caption.source });
  if (b.caption.maxChars !== a.caption.maxChars) out.push({ key: `${p}.caption.maxChars`, value: a.caption.maxChars });
  if (b.caption.perSegment !== a.caption.perSegment) out.push({ key: `${p}.caption.perSegment`, value: a.caption.perSegment });
  if (b.backfill !== a.backfill) out.push({ key: `${p}.backfill`, value: a.backfill });
  return out;
}

/** The setup view of the draft, for the shared validation. */
export function toSetup(d: MediaDraft): MediaSetup {
  const c = d.caption.provider;
  return {
    enabled: d.enabled, provider: d.provider, modalities: d.modalities,
    caption: c === "local" || c === "off" || c === CLOUD_CAPTION_PROVIDER ? c : null,
    captionSource: d.caption.source as CaptionSourceSetting, backfill: d.backfill,
  };
}
