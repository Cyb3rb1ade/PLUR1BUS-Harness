import { authorize } from '../rbac/authorize.ts';
// Media search composition (ME2): builds the media index port, caption service, index hook and backfill job, and attaches
// the hook to the OutputStore. The RPC surface (`createMediaSearchSurface`) is connected by the caller: see WIRING POINT.
import { safeId } from '../../../media/src/files.ts';
import { guardedMediaIndex, type MediaEncodingBudget } from '../media-search/admission.ts';
import { localMediaSelection } from '../media-search/engine-host.ts';
import { mediaError } from '../media-search/errors.ts';
import { localOnlyShared } from '../privacy/local-only.ts';
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { HarnessConfig } from '@plur1bus/config-schema';
import type { Principal } from '@cyb3rb1ade/plur1bus-memory/types/engine.js';
import type { OutputStore, Manifest } from '../../../media/src/index.ts';
import type { AsrProvider } from '../../../voice-providers/src/types.ts';
import type { CallBudget } from '../budget/index.ts';
import type { AgentRegistry } from '../agents.ts';
import type { HarnessLogger } from '../logger.ts';
import { DisabledMediaIndex } from '../media-search/disabled.ts';
import { selectMediaIndex, type MediaIndexKind } from '../media-search/select.ts';
import { createFfmpegPorts } from '../media-search/ffmpeg.ts';
import { createBackfillJob, type BackfillJob } from '../media-search/backfill.ts';
import { createMediaIndexHook, type MediaIndexHook, type MediaRecord } from '../media-search/hook.ts';
import { createCaptionService, resolveCaptionProvider, type CaptionService, type CaptionProviders } from '../media-search/caption/service.ts';
import { createLocalCaptionProvider, localTranscriber, DEFAULT_CAPTION_MODEL } from '../media-search/caption/local.ts';
import type { CaptionProvider } from '../media-search/caption/types.ts';
import type { MediaIndexPort, MediaKind, Scope } from '../media-search/types.ts';
import { createMediaSearchSurface, createMediaOwnerAcl } from '../rpc/media-search-surface.ts';
import { deriveUserPrincipal } from '../identity/principals.ts';
import type { Handler } from '../rpc/server.ts';

export interface MediaSearchDeps {
  home: string;
  config: () => HarnessConfig;
  engine: unknown;
  /** Actual HostServices.fetch binding, checked by bootstrap before engine construction. */
  hostFetchReady?: boolean;
  agents: Pick<AgentRegistry, 'workspaceOf'>;
  logger: HarnessLogger;
  /** The OutputStore generation/edit results land in; null: nothing to observe. */
  store: Pick<OutputStore, 'root' | 'addListener'> | null;
  budget: CallBudget | null;
  /** Local speech recogniser for audio captions (voice runtime); absent: audio gets no auto caption. */
  asr?: AsrProvider;
  /** D109 privacy pin; no key exists in the config schema yet, so the caller supplies it. Default: not pinned. */
  privacyPinned?: () => boolean;
  /** Cloud caption providers by configured id, built by the caller from the provider layer (see `createCloudCaptionProvider`). */
  cloudCaption?: (id: string) => CaptionProvider | undefined;
  /** `media.index.failed` / `media.index.status` go here; default: the core log. */
  emit?: (name: string, payload: Record<string, unknown>) => void;
  /** Test seams. */
  testPort?: MediaIndexPort;
  /** Unbound until #603 plus Secret lease admission land; no token-budget substitution. */
  encodingBudget?: MediaEncodingBudget;
  ffmpeg?: Partial<Parameters<typeof createFfmpegPorts>[0]>;
}
export interface MediaSearchComposition {
  /** WIRING POINT: hand `port`, `hook`, `backfill` and `captions` to `createMediaSearchSurface` (rpc/media-search-surface.ts). */
  port: MediaIndexPort; kind: MediaIndexKind;
  hook: MediaIndexHook; backfill: BackfillJob; captions: CaptionService;
  counters: { snapshot(): Record<string, number> };
  close(): Promise<void>;
}

const agentScope = (agents: MediaSearchDeps['agents'], agentId: string): Principal => {
  const dir = agents.workspaceOf(agentId);
  if (!dir) throw new Error('unknown agent for media scope');
  // Agent-private: nothing proves a user for generated outputs, so visibility never widens.
  return { agentId, workspace: `workspace-dir:v1:${realpathSync(dir)}`, channel: 'cli', accountId: '', chat: { id: '', kind: 'direct' }, trust: 'inferred' } as Principal;
};

/** Never throws: any failure leaves media search disabled and the rest of the core running. */
export async function composeMediaSearch(d: MediaSearchDeps): Promise<MediaSearchComposition> {
  const cfg = () => d.config().memory.mediaEmbedding;
  const emit = d.emit ?? ((name, payload) => d.logger.info(name, payload));
  const counts: Record<string, number> = {};
  const counters = { indexFailed: (stage: string) => { counts[`index_failed_${stage}`] = (counts[`index_failed_${stage}`] ?? 0) + 1; }, snapshot: () => ({ ...counts }) };
  const snapshot = structuredClone(cfg());
  const effective = (agentId?: string) => {
    const own = agentId ? d.config().agents[agentId]?.memory?.mediaEmbedding : undefined;
    return { ...cfg(), ...own, modalities: (own?.modalities ?? cfg().modalities).filter((m): m is MediaKind => m !== undefined), video: { ...cfg().video, ...own?.video }, audio: { ...cfg().audio, ...own?.audio }, caption: { ...cfg().caption, ...own?.caption } };
  };
  const ownerOf = async (mediaId: string): Promise<string> => {
    safeId(mediaId);
    for (let i=0;;i++) {
      try { const owner=JSON.parse(await readFile(join(d.home,'media','owners',`${mediaId}.json`),'utf8')) as {agentId?:unknown};
        if (typeof owner.agentId !== 'string') throw new Error('unknown media owner');
        return owner.agentId;
      } catch(e) { if(i>=10) throw e; await new Promise(r=>setTimeout(r,25)); }
    }
  };
  const budgetCallback = { canContinue: async () => localMediaSelection(cfg()) };
  // Media paths (store outputs, uploads) live below <home>/media; the store root is added in case it is configured elsewhere. Nothing else is readable by ffmpeg or the caption providers.
  const allowedRoots = [join(d.home, 'media'), ...(d.store ? [d.store.root] : [])];
  const ports = createFfmpegPorts({ tempDir: join(d.home, 'media', 'tmp'), allowedRoots, ...d.ffmpeg });
  let port: MediaIndexPort; let kind: MediaIndexKind;
  // privacy pin (privacy.localOnly): a cloud media embedding provider is not started; the index stays disabled with
  // the reason instead of switching to another model (the same local set the config validation uses).
  const mediaProvider = cfg().provider;
  if (cfg().enabled !== false && !['local', 'local-transformers', 'egemma2', 'off'].includes(mediaProvider) && d.privacyPinned?.()) {
    d.logger.warn('media index disabled by privacy.localOnly', { provider: mediaProvider });
    port = new DisabledMediaIndex(`privacy.localOnly: media embedding provider ${mediaProvider} is not local`); kind = 'disabled';
  } else if (!d.testPort && !d.hostFetchReady) {
    port = new DisabledMediaIndex('Host Fetch port is not bound'); kind = 'disabled';
  } else try {
    ({ port, kind } = selectMediaIndex({ engine: d.engine, config: cfg(), ports: { frames: ports.frames, audio: ports.audio, budget: budgetCallback }, scopeOfMedia: async id => agentScope(d.agents, await ownerOf(id)), ...(d.testPort ? { test: d.testPort } : {}) }));
  } catch (e) {
    d.logger.error('media index unavailable', { err: e });
    port = new DisabledMediaIndex('composition failed'); kind = 'disabled';
  }

  const maxChars = () => cfg().caption.maxChars;
  const providers: CaptionProviders = {
    local: createLocalCaptionProvider({
      modelDir: join(d.home, 'models', 'caption', DEFAULT_CAPTION_MODEL), maxChars, allowedRoots,
      ...(ports.frames ? { extractor: ports.frames } : {}),
      ...(d.asr && ports.audio ? { transcribe: localTranscriber({ asr: d.asr, decoder: ports.audio, maxChars }) } : {}),
    }),
    ...(d.cloudCaption ? { cloud: d.cloudCaption } : {}),
  };
  const captionServiceFor = (agentId?: string) => createCaptionService({
    config: () => effective(agentId).caption,
    // Read on every call: a pin set after the provider was chosen still stops a cloud provider before it is called.
    pinned: () => d.privacyPinned?.() ?? false,
    provider: () => {
      try { return resolveCaptionProvider({ config: effective(agentId).caption, pinned: d.privacyPinned?.() ?? false, providers, embeddingLocal: localMediaSelection(effective(agentId)) }); }
      catch (e) { d.logger.warn('caption provider refused', { err: e }); return undefined; }
    },
  });

  const captions = captionServiceFor();
  const mediaPolicy = (scope?: Scope, mediaKind?: MediaKind) => {
      const c=effective(scope?.agentId), local=localMediaSelection(c);
      const pinned=(d.privacyPinned?.() ?? false) || localOnlyShared(d.config());
      if(!local && pinned) throw mediaError('E_MEDIA_PRIVACY','privacy.localOnly blocks cloud media');
      if(!c.enabled || c.provider==='off') throw mediaError('E_MEDIA_UNAVAILABLE','media index disabled for agent');
      if(!local) throw mediaError('E_MEDIA_UNAVAILABLE','media encoder/Secret lease admission is not bound');
      if(![128,256,512,768].includes(c.dimensions)) throw mediaError('E_MEDIA_DIMENSION','unsupported media vector dimension');
      if(c.model!==snapshot.model || c.dimensions!==snapshot.dimensions) throw mediaError('E_MEDIA_UNAVAILABLE','shared Engine does not support this agent model override');
      if(mediaKind && !c.modalities.includes(mediaKind)) throw mediaError('E_MEDIA_CAPABILITY','media kind disabled for this agent');
      return {local,model:c.model,pinned};
  };
  if (kind !== 'disabled') port = guardedMediaIndex(port, {policy:mediaPolicy,...(d.encodingBudget ? {budget:d.encodingBudget}:{})});
  const hook = createMediaIndexHook({
    port: () => port, captions, captionForScope: scope => captionServiceFor(scope.agentId), config: cfg, events: { emit }, counters, logger: d.logger,
    admit: (record, scope) => { mediaPolicy(scope, record.kind); },
    scopeOf: async record => {
      const owner = await ownerOf(record.mediaId);
      if (record.agentId !== undefined && record.agentId !== owner) throw mediaError('E_MEDIA_UNAVAILABLE', 'media owner mismatch');
      return agentScope(d.agents, owner);
    },
  });
  const backfill = createBackfillJob({ port: () => port, config: cfg, budgetCallback, events: { emit }, logger: d.logger, stateFile: join(d.home, 'state', 'media-search.json') });

  let unlisten: (() => void) | undefined;
  const store = d.store;
  if (store && kind !== 'disabled') {
    const recordOf = (m: Manifest): MediaRecord | null => {
      const file = m.files[0];
      if (!file) return null;
      const kind = m.kind === 'video' ? 'video' : 'image';
      const mime = kind === 'video' && file.format === 'mov' ? 'video/quicktime' : `${kind}/${file.format}`;
      return { mediaId: m.id, kind, mime, source: { path: join(store.root, m.id, file.path) }, prompt: m.prompt };
    };
    unlisten = store.addListener({
      onPut: m => { const r = recordOf(m); if (r) hook.onStored(r); },
      onDelete: id => hook.onDeleted(id),
    });
  }
  if (kind !== 'disabled') {
    void backfill.init().then(() => backfill.watch()).catch(e => d.logger.warn('media backfill init failed', { err: e }));
  }
  return {
    port, kind, hook, backfill, captions, counters,
    async close() { unlisten?.(); backfill.close(); await hook.idle().catch(() => {}); },
  };
}

/** RPC methods of the media index over a composed media search. People search as the default agent with their own user
 *  principal; an agent searches its own scope only (the RBAC rule keeps agents away from everything but search/status). */
export function mediaSearchMethods(d: Pick<MediaSearchDeps, 'home' | 'config' | 'agents'>, m: MediaSearchComposition): Record<string, Handler> {
  return createMediaSearchSurface({
    index: () => (m.kind === 'disabled' ? null : m.port),
    config: d.config,
    backfill: { pause: async () => { await m.backfill.pause(); }, resume: async () => { await m.backfill.resume(); }, reindex: async () => { await m.backfill.reindex(); } },
    globalStatus: true,
    scopeOf: principal => {
      if(principal.kind === 'agent') return agentScope(d.agents, principal.userId);
      return Object.keys(d.config().agents).filter(agentId => authorize(principal, 'agent.read', {kind:'agent',agentId}).effect === 'allow')
        .map(agentId => ({...agentScope(d.agents,agentId),user:deriveUserPrincipal(principal.userId),trust:'proved' as const}));
    },
    ...createMediaOwnerAcl({ home: d.home }),
  }).methods;
}
