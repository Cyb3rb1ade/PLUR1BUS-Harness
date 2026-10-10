// The local voice catalog: data in, validated typed view out. Languages and models are entries, never code paths.
import { VoiceProviderError } from "../errors.ts";
import catalogJson from "./catalog.json" with { type: "json" };

export type Profile = "fast" | "quality";
export type ModelKind = "stt" | "tts" | "vad";
export type LicenceStatus = "confirmed" | "unconfirmed";

export interface Licence {
  id: string;
  name: string;
  url?: string;
  /** true: commercial use allowed; false: non-commercial only; null: not known. */
  commercial: boolean | null;
  status: LicenceStatus;
  notice?: string;
}
export interface DownloadItem {
  url: string | null;
  sha256: string | null;
  sizeBytes: number | null;
  /** Plain file saved at this relative path inside the model directory. */
  path?: string;
  archive?: "tar.bz2";
  stripComponents?: number;
}
export interface CatalogModel {
  id: string;
  kind: ModelKind;
  engine: string;
  streaming?: boolean;
  displayName: string;
  language?: string;
  sampleRate?: number;
  licence: Licence;
  download: DownloadItem[];
  /** role -> path relative to the model directory. */
  roles: Record<string, string>;
  speakers?: Record<string, number>;
  defaultSpeaker?: string;
  packageStatus?: string;
}
export interface CatalogLanguage {
  name: string;
  stt: { fast: string; quality?: string };
  tts: { fast: string; quality?: string; fallback?: string };
}
export interface Catalog {
  version: 1;
  vad: string;
  models: Record<string, CatalogModel>;
  languages: Record<string, CatalogLanguage>;
}

const fail = (msg: string): never => { throw new VoiceProviderError("catalog", `voice catalog: ${msg}`); };
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

/** Validate a parsed catalog document. Throws `catalog` errors with the offending path. */
export function parseCatalog(raw: unknown): Catalog {
  if (!isObj(raw)) return fail("not an object");
  if (raw["version"] !== 1) fail("unsupported version");
  if (!isObj(raw["models"]) || !isObj(raw["languages"])) fail("models and languages are required");
  const models: Record<string, CatalogModel> = {};
  for (const [id, m] of Object.entries(raw["models"] as Record<string, unknown>)) {
    if (!isObj(m)) { fail(`model ${id} is not an object`); continue; }
    if (!["stt", "tts", "vad"].includes(m["kind"])) fail(`model ${id}: bad kind`);
    if (typeof m["engine"] !== "string" || typeof m["displayName"] !== "string") fail(`model ${id}: engine and displayName are required`);
    const l = m["licence"];
    if (!isObj(l) || typeof l["id"] !== "string" || typeof l["name"] !== "string" || !["confirmed", "unconfirmed"].includes(l["status"]) || !(l["commercial"] === true || l["commercial"] === false || l["commercial"] === null)) fail(`model ${id}: licence needs id, name, commercial (true|false|null) and status`);
    if (!Array.isArray(m["download"]) || m["download"].length === 0) fail(`model ${id}: download list is required`);
    for (const d of m["download"] as unknown[]) {
      if (!isObj(d)) { fail(`model ${id}: bad download item`); continue; }
      if (d["url"] !== null && typeof d["url"] !== "string") fail(`model ${id}: download url must be a string or null`);
      if (d["sha256"] !== null && !(typeof d["sha256"] === "string" && /^[0-9a-f]{64}$/i.test(d["sha256"]))) fail(`model ${id}: sha256 must be 64 hex characters or null`);
      if (d["archive"] === undefined && typeof d["path"] !== "string") fail(`model ${id}: a plain download needs a path`);
      if (typeof d["path"] === "string" && (d["path"].startsWith("/") || d["path"].split(/[\\/]/).includes(".."))) fail(`model ${id}: download path escapes the model directory`);
    }
    if (!isObj(m["roles"])) fail(`model ${id}: roles are required`);
    for (const p of Object.values(m["roles"] as Record<string, unknown>)) if (typeof p !== "string" || p.startsWith("/") || p.split(/[\\/]/).includes("..")) fail(`model ${id}: role path escapes the model directory`);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) fail(`model id ${id} is not a safe directory name`);
    models[id] = { ...(m as object), id } as CatalogModel;
  }
  const languages: Record<string, CatalogLanguage> = {};
  for (const [code, l] of Object.entries(raw["languages"] as Record<string, unknown>)) {
    if (!/^[a-z]{2,3}(-[A-Za-z0-9]+)?$/.test(code)) fail(`language code ${code} is not valid`);
    if (!isObj(l) || !isObj(l["stt"]) || !isObj(l["tts"]) || typeof l["stt"]["fast"] !== "string" || typeof l["tts"]["fast"] !== "string") { fail(`language ${code}: stt.fast and tts.fast are required`); continue; }
    for (const [group, ref] of [["stt", l["stt"]], ["tts", l["tts"]]] as const) for (const [k, id] of Object.entries(ref as Record<string, unknown>)) {
      const model = typeof id === "string" ? models[id] : undefined;
      if (!model) fail(`language ${code}: ${group}.${k} names unknown model ${String(id)}`);
      else if (model.kind !== group) fail(`language ${code}: ${group}.${k} names ${id}, a ${model.kind} model`);
    }
    languages[code] = l as unknown as CatalogLanguage;
  }
  const vad = raw["vad"];
  if (typeof vad !== "string" || models[vad]?.kind !== "vad") fail("vad must name a vad model");
  return { version: 1, vad: vad as string, models, languages };
}

/**
 * Overlay: entries in `override` replace or add models and languages by key. Parsed again as a whole.
 * The licence of a built-in model id is not overridable: an override entry with a built-in id keeps everything it
 * brings except `licence`, which stays the built-in record. New ids carry their own licence and are gated like any other.
 */
export function mergeCatalog(base: Catalog, override: unknown): Catalog {
  if (override === undefined || override === null) return base;
  if (!isObj(override)) return fail("catalogOverride is not an object");
  const overrideModels: Record<string, unknown> = {};
  if (isObj(override["models"])) {
    for (const [id, m] of Object.entries(override["models"] as Record<string, unknown>)) {
      const builtin = base.models[id];
      overrideModels[id] = builtin && isObj(m) ? { ...m, licence: builtin.licence } : m;
    }
  }
  return parseCatalog({ version: 1, vad: override["vad"] ?? base.vad, models: { ...base.models, ...overrideModels }, languages: { ...base.languages, ...(isObj(override["languages"]) ? override["languages"] : {}) } });
}

let builtin: Catalog | undefined;
export function builtinCatalog(): Catalog {
  if (!builtin) builtin = parseCatalog(catalogJson);
  return builtin;
}

export function loadCatalog(override?: unknown): Catalog {
  return mergeCatalog(builtinCatalog(), override);
}

/** Pick the models a language needs for a profile. quality falls back to fast when the language has no quality tier. */
export function modelsFor(catalog: Catalog, language: string, profile: Profile): { stt: CatalogModel; tts: CatalogModel; ttsFallback?: CatalogModel; vad: CatalogModel } {
  const lang = catalog.languages[language];
  if (!lang) throw new VoiceProviderError("catalog", `voice catalog: language "${language}" is not in the catalog`);
  const stt = catalog.models[(profile === "quality" ? lang.stt.quality : undefined) ?? lang.stt.fast]!;
  const tts = catalog.models[(profile === "quality" ? lang.tts.quality : undefined) ?? lang.tts.fast]!;
  const fb = lang.tts.fallback ? catalog.models[lang.tts.fallback] : undefined;
  return { stt, tts, ...(fb ? { ttsFallback: fb } : {}), vad: catalog.models[catalog.vad]! };
}

export function modelSizeBytes(m: CatalogModel): number | null {
  let n = 0;
  for (const d of m.download) { if (d.sizeBytes === null) return null; n += d.sizeBytes; }
  return n;
}

/** A model can be fetched only with a URL and a pinned checksum on every item. */
export function downloadable(m: CatalogModel): { ok: true } | { ok: false; reason: string } {
  for (const d of m.download) {
    if (d.url === null) return { ok: false, reason: m.packageStatus ?? "no download URL in the catalog yet" };
    if (d.sha256 === null) return { ok: false, reason: "sha256 is not pinned in the catalog" };
  }
  return { ok: true };
}

/** Does using this model need the explicit licence confirmation? Anything not known to allow commercial use does. */
export function needsLicenceConfirmation(m: CatalogModel): boolean {
  return m.licence.commercial !== true || m.licence.status !== "confirmed";
}

export function licenceNotice(m: CatalogModel): string {
  const l = m.licence;
  const terms = l.commercial === true ? "commercial use allowed" : l.commercial === false ? "NON-COMMERCIAL use only" : "commercial use not confirmed";
  return `${m.displayName}: ${l.name} (${terms}${l.status === "unconfirmed" ? "; licence status UNCONFIRMED" : ""})${l.url ? ` ${l.url}` : ""}${l.notice ? ` ${l.notice}` : ""}`;
}

/** Identity of one confirmation: the model and the licence it was shown under. A new model or a changed licence id is a new key. */
export function licenceKey(m: CatalogModel): string {
  return `${m.id}@${m.licence.id}`;
}

/** The same gate as embeddings, but per model and licence: refuse unless this exact key was confirmed. */
export function assertLicenceAccepted(m: CatalogModel, accepted: ReadonlySet<string> | readonly string[]): void {
  if (!needsLicenceConfirmation(m)) return;
  const key = licenceKey(m);
  if (accepted instanceof Set ? accepted.has(key) : (accepted as readonly string[]).includes(key)) return;
  throw new VoiceProviderError("licence_required", `licence confirmation required for "${key}" before using ${licenceNotice(m)}`);
}
