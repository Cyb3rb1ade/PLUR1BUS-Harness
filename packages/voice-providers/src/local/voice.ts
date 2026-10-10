// LocalVoice: the language API (AL13) over the catalog, downloads, licence gate and engine. One language is resident
// at a time; a switch loads the new models first and only then unloads the old ones, so a failed switch keeps the
// working setup.
import { mkdir } from "node:fs/promises";
import { VoiceProviderError } from "../errors.ts";
import type { FetchLike } from "../http.ts";
import type { AsrProvider, Logger, TtsProvider, UsageReport } from "../types.ts";
import { noopLogger } from "../types.ts";
import { assertLicenceAccepted, downloadable, licenceNotice, loadCatalog, modelSizeBytes, modelsFor, needsLicenceConfirmation, type Catalog, type CatalogModel, type Licence, type Profile } from "./catalog.ts";
import { downloadModel, isInstalled, modelDir, type DownloadProgress, type ExtractFn } from "./download.ts";
import { createSherpaEngine, resolveModel, type LoadedAsr, type LoadedTts, type LoadedVad, type LocalEngine } from "./engine.ts";
import { createLocalAsr, createLocalTts } from "./providers.ts";

/** voice.local.* */
export interface LocalVoiceConfig {
  language?: string;
  profile?: Profile;
  perAgent?: Record<string, { language?: string; profile?: Profile }>;
  catalogOverride?: unknown;
  modelsDir?: string;
  acceptNcLicence?: boolean;
}

export interface LocalVoiceOptions {
  config?: LocalVoiceConfig;
  /** Used when config.modelsDir is absent (the host passes its data directory). */
  modelsDir: string;
  engine?: LocalEngine;
  catalog?: Catalog;
  fetch?: FetchLike;
  extract?: ExtractFn;
  /** BCP-47-ish locale of the system, for the default language. */
  systemLocale?: () => string;
  now?: () => number;
  logger?: Logger;
  usage?: (r: UsageReport) => void;
}

export interface ModelSummary {
  id: string;
  displayName: string;
  licence: Licence;
  sizeBytes: number | null;
  streaming: boolean;
  installed: boolean;
  downloadable: boolean;
  /** Why it cannot be downloaded, when it cannot. */
  reason?: string;
}
export interface ProfileInfo {
  stt: ModelSummary;
  tts: ModelSummary;
  ttsFallback?: ModelSummary;
  sizeBytes: number | null;
  installed: boolean;
  needsLicenceConfirmation: boolean;
  licenceNotices: string[];
}
export interface LanguageInfo {
  code: string;
  name: string;
  profiles: Record<Profile, ProfileInfo>;
  current: boolean;
}
export interface SetLanguageOptions {
  /** Download missing models (default false: fail with a clear message instead). */
  download?: boolean;
  acceptNcLicence?: boolean;
  profile?: Profile;
  onProgress?: (p: DownloadProgress) => void;
  signal?: AbortSignal;
}
export interface LocalVoiceState {
  language: string;
  profile: Profile;
  stt: CatalogModel;
  tts: CatalogModel;
  vad: CatalogModel;
  usedTtsFallback: boolean;
}
export type Capability = { state: "unavailable"; message: string } | { state: "idle"; message: string } | { state: "ready"; message: string; language: string; profile: Profile };

interface Loaded {
  state: LocalVoiceState;
  asr: LoadedAsr;
  tts: LoadedTts;
  vad: LoadedVad;
  refCount: number;
  retired: boolean;
}

export class LocalVoice {
  private readonly o: LocalVoiceOptions;
  private readonly cfg: LocalVoiceConfig;
  readonly catalog: Catalog;
  private readonly engine: LocalEngine;
  private readonly dir: string;
  private readonly log: Logger;
  private loaded: Loaded | undefined;
  private readonly retired: Set<Loaded> = new Set();
  private chain: Promise<unknown> = Promise.resolve();
  readonly asr: AsrProvider;
  readonly tts: TtsProvider;

  constructor(o: LocalVoiceOptions) {
    this.o = o;
    this.cfg = o.config ?? {};
    this.catalog = o.catalog ?? loadCatalog(this.cfg.catalogOverride);
    this.engine = o.engine ?? createSherpaEngine();
    this.dir = this.cfg.modelsDir ?? o.modelsDir;
    this.log = o.logger ?? noopLogger;
    const need = (): Loaded => {
      if (!this.loaded) throw new VoiceProviderError("unavailable", "local voice: no language is loaded; call setLanguage() first");
      return this.loaded;
    };
    this.asr = createLocalAsr(
      () => ({ asr: need().asr, model: need().state.stt }),
      o.usage,
      {
        onStreamOpen: (asr) => {
          const target = [this.loaded, ...this.retired].find((l) => l && l.asr === asr);
          if (target) {
            target.refCount++;
            return () => {
              target.refCount--;
              if (target.retired && target.refCount <= 0) {
                this.retired.delete(target);
                target.asr.dispose();
                target.tts.dispose();
                target.vad.dispose();
              }
            };
          }
          return () => {};
        },
      },
    );
    this.tts = createLocalTts(() => ({ tts: need().tts, model: need().state.tts }), o.usage);
  }

  /** The system language if the catalog has it, else English. */
  defaultLanguage(): string {
    const loc = (this.o.systemLocale?.() ?? Intl.DateTimeFormat().resolvedOptions().locale ?? "en").toLowerCase().replace(/_/g, "-");
    const full = loc.split(/[.@]/)[0]!;
    if (this.catalog.languages[full]) return full;
    const primary = full.split("-")[0]!;
    return this.catalog.languages[primary] ? primary : "en";
  }

  /** Language and profile for an agent: per-agent override, then voice.local, then the default. */
  resolveFor(agentId?: string): { language: string; profile: Profile } {
    const a = agentId ? this.cfg.perAgent?.[agentId] : undefined;
    const language = a?.language ?? this.cfg.language ?? this.defaultLanguage();
    return { language, profile: a?.profile ?? this.cfg.profile ?? "fast" };
  }

  current(): LocalVoiceState | undefined {
    return this.loaded?.state;
  }

  capability(): Capability {
    const a = this.engine.availability();
    if (!a.ok) return { state: "unavailable", message: a.reason };
    if (!this.loaded) return { state: "idle", message: "local voice is available; no language is loaded yet" };
    return { state: "ready", message: `local voice ready (${this.loaded.state.language}, ${this.loaded.state.profile})`, language: this.loaded.state.language, profile: this.loaded.state.profile };
  }

  async listLanguages(): Promise<LanguageInfo[]> {
    const out: LanguageInfo[] = [];
    for (const [code, lang] of Object.entries(this.catalog.languages)) out.push(await this.describe(code, lang.name));
    return out;
  }

  async getLanguage(code: string): Promise<LanguageInfo | undefined> {
    const lang = this.catalog.languages[code];
    return lang ? this.describe(code, lang.name) : undefined;
  }

  private async summary(m: CatalogModel): Promise<ModelSummary> {
    const d = downloadable(m);
    return { id: m.id, displayName: m.displayName, licence: m.licence, sizeBytes: modelSizeBytes(m), streaming: m.streaming === true, installed: await isInstalled(this.dir, m), downloadable: d.ok, ...(d.ok ? {} : { reason: d.reason }) };
  }

  private async describe(code: string, name: string): Promise<LanguageInfo> {
    const profiles = {} as Record<Profile, ProfileInfo>;
    for (const p of ["fast", "quality"] as const) {
      const m = modelsFor(this.catalog, code, p);
      const stt = await this.summary(m.stt);
      const tts = await this.summary(m.tts);
      const fb = m.ttsFallback ? await this.summary(m.ttsFallback) : undefined;
      const used = [m.stt, m.tts, m.vad];
      const sizes = used.map(modelSizeBytes);
      profiles[p] = {
        stt, tts, ...(fb ? { ttsFallback: fb } : {}),
        sizeBytes: sizes.every((s) => s !== null) ? sizes.reduce<number>((a, b) => a + (b ?? 0), 0) : null,
        installed: stt.installed && tts.installed,
        needsLicenceConfirmation: used.some(needsLicenceConfirmation),
        licenceNotices: used.filter(needsLicenceConfirmation).map(licenceNotice),
      };
    }
    return { code, name, profiles, current: this.loaded?.state.language === code };
  }

  /** Make `code` the resident language. Serialised: concurrent calls run one after another. */
  setLanguage(code: string, options: SetLanguageOptions = {}): Promise<LocalVoiceState> {
    const run = this.chain.then(() => this.doSet(code, options));
    this.chain = run.catch(() => {});
    return run;
  }

  /** Switch the resident model to what `agentId` is configured for (no-op when already loaded). */
  async useForAgent(agentId: string, options: SetLanguageOptions = {}): Promise<LocalVoiceState> {
    const want = this.resolveFor(agentId);
    const cur = this.loaded?.state;
    if (cur && cur.language === want.language && cur.profile === (options.profile ?? want.profile)) return cur;
    return this.setLanguage(want.language, { profile: want.profile, ...options });
  }

  private async doSet(code: string, options: SetLanguageOptions): Promise<LocalVoiceState> {
    const avail = this.engine.availability();
    if (!avail.ok) throw new VoiceProviderError("unavailable", avail.reason);
    const profile = options.profile ?? this.cfg.profile ?? "fast";
    const accepted = options.acceptNcLicence ?? this.cfg.acceptNcLicence ?? false;
    const sel = modelsFor(this.catalog, code, profile);

    // Choose the TTS model: the tier's own, or the declared fallback when the tier's package cannot be fetched or run.
    let tts = sel.tts;
    let usedFallback = false;
    const ownOk = (await isInstalled(this.dir, tts)) || (downloadable(tts).ok && this.engine.supports("tts", tts.engine));
    if (!ownOk && sel.ttsFallback) { tts = sel.ttsFallback; usedFallback = true; }
    for (const m of [sel.stt, tts, sel.vad]) {
      if (!this.engine.supports(m.kind, m.engine)) throw new VoiceProviderError("unavailable", `${m.displayName} needs the "${m.engine}" engine, which the installed sherpa-onnx-node does not support`);
    }
    const needed = [sel.stt, tts, sel.vad];
    for (const m of needed) assertLicenceAccepted(m, accepted);

    for (const m of needed) {
      if (await isInstalled(this.dir, m)) continue;
      if (!options.download) throw new VoiceProviderError("unavailable", `${m.displayName} is not installed; call setLanguage("${code}", { download: true }) to fetch it`);
      await mkdir(this.dir, { recursive: true });
      await downloadModel(m, { modelsDir: this.dir, acceptNcLicence: accepted, ...(this.o.fetch ? { fetch: this.o.fetch } : {}), ...(this.o.extract ? { extract: this.o.extract } : {}), ...(options.onProgress ? { onProgress: options.onProgress } : {}), ...(options.signal ? { signal: options.signal } : {}) });
    }

    const parts: { asr?: LoadedAsr; tts?: LoadedTts; vad?: LoadedVad } = {};
    try {
      parts.asr = await this.engine.loadAsr(resolveModel(sel.stt, modelDir(this.dir, sel.stt.id)));
      parts.tts = await this.engine.loadTts(resolveModel(tts, modelDir(this.dir, tts.id)));
      parts.vad = await this.engine.loadVad(resolveModel(sel.vad, modelDir(this.dir, sel.vad.id)));
    } catch (e) {
      parts.asr?.dispose(); parts.tts?.dispose(); parts.vad?.dispose();
      throw e instanceof VoiceProviderError ? e : new VoiceProviderError("unavailable", `local voice: could not load models for "${code}"`);
    }
    const old = this.loaded;
    const state: LocalVoiceState = { language: code, profile, stt: sel.stt, tts, vad: sel.vad, usedTtsFallback: usedFallback };
    this.loaded = { state, asr: parts.asr, tts: parts.tts, vad: parts.vad, refCount: 0, retired: false };
    if (old) {
      if (old.refCount > 0) {
        old.retired = true;
        this.retired.add(old);
      } else {
        old.asr.dispose();
        old.tts.dispose();
        old.vad.dispose();
      }
    }
    this.log.debug("local voice language set", { language: code, profile, fallback: usedFallback });
    return state;
  }

  /** Preload + warmup (AL12): one tiny inference on each loaded model; returns the time each took. */
  async warm(): Promise<{ asrMs: number; ttsMs: number }> {
    const l = this.loaded;
    if (!l) throw new VoiceProviderError("unavailable", "local voice: nothing is loaded to warm");
    const now = this.o.now ?? Date.now;
    const t0 = now();
    await l.asr.warm();
    const t1 = now();
    await l.tts.warm();
    const t2 = now();
    return { asrMs: t1 - t0, ttsMs: t2 - t1 };
  }

  /** Voice activity detector of the resident language (Silero via the engine). */
  vad(): LoadedVad {
    if (!this.loaded) throw new VoiceProviderError("unavailable", "local voice: no language is loaded; call setLanguage() first");
    return this.loaded.vad;
  }

  unload(): void {
    const l = this.loaded;
    this.loaded = undefined;
    l?.asr.dispose();
    l?.tts.dispose();
    l?.vad.dispose();
  }

  dispose(): void {
    this.unload();
    for (const r of this.retired) {
      r.asr.dispose();
      r.tts.dispose();
      r.vad.dispose();
    }
    this.retired.clear();
  }
}

