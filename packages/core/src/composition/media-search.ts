// Media search composition (ME2): builds the media index port, caption service, index hook and backfill job, and attaches
// the hook to the OutputStore. The RPC surface (`createMediaSearchSurface`) is connected by the caller: see WIRING POINT.
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
import { createBackfillJob, createBudgetCallback, type BackfillJob } from '../media-search/backfill.ts';
import { createMediaIndexHook, type MediaIndexHook, type MediaRecord } from '../media-search/hook.ts';
import { createCaptionService, resolveCaptionProvider, type CaptionService, type CaptionProviders } from '../media-search/caption/service.ts';
import { createLocalCaptionProvider, localTranscriber, DEFAULT_CAPTION_MODEL } from '../media-search/caption/local.ts';
import type { CaptionProvider } from '../media-search/caption/types.ts';
import type { MediaIndexPort } from '../media-search/types.ts';
import { createMediaSearchSurface, createMediaOwnerAcl } from '../rpc/media-search-surface.ts';
import { deriveUserPrincipal } from '../identity/principals.ts';
import type { Handler } from '../rpc/server.ts';

export interface MediaSearchDeps {
  home: string;
  config: () => HarnessConfig;
  engine: unknown;
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
  const budgetCallback = createBudgetCallback(d.budget);
  const ports = createFfmpegPorts({ tempDir: join(d.home, 'media', 'tmp'), ...d.ffmpeg });
  let port: MediaIndexPort; let kind: MediaIndexKind;
  try {
    ({ port, kind } = selectMediaIndex({ engine: d.engine, config: cfg(), ports: { frames: ports.frames, audio: ports.audio, budget: budgetCallback }, ...(d.testPort ? { test: d.testPort } : {}) }));
  } catch (e) {
    d.logger.error('media index unavailable', { err: e });
    port = new DisabledMediaIndex('composition failed'); kind = 'disabled';
  }

  const maxChars = () => cfg().caption.maxChars;
  const providers: CaptionProviders = {
    local: createLocalCaptionProvider({
      modelDir: join(d.home, 'models', 'caption', DEFAULT_CAPTION_MODEL), maxChars,
      ...(ports.frames ? { extractor: ports.frames } : {}),
      ...(d.asr && ports.audio ? { transcribe: localTranscriber({ asr: d.asr, decoder: ports.audio, maxChars }) } : {}),
    }),
    ...(d.cloudCaption ? { cloud: d.cloudCaption } : {}),
  };
  const captions = createCaptionService({
    config: () => cfg().caption,
    provider: () => {
      try { return resolveCaptionProvider({ config: cfg().caption, pinned: d.privacyPinned?.() ?? false, providers, embeddingLocal: cfg().provider.startsWith('local') }); }
      catch (e) { d.logger.warn('caption provider refused', { err: e }); return undefined; }
    },
  });

  const ownerOf = async (mediaId: string): Promise<string> => {
    // The owner file is written next to the put; retry briefly for the order in which the surface writes them.
    for (let i = 0; ; i++) {
      try { return (JSON.parse(await readFile(join(d.home, 'media', 'owners', `${mediaId}.json`), 'utf8')) as { agentId: string }).agentId; }
      catch (e) { if (i >= 10) throw e; await new Promise(r => setTimeout(r, 25)); }
    }
  };
  const hook = createMediaIndexHook({
    port: () => port, captions, config: cfg, events: { emit }, counters, logger: d.logger,
    scopeOf: async record => agentScope(d.agents, record.agentId ?? await ownerOf(record.mediaId)),
  });
  const backfill = createBackfillJob({ port: () => port, config: cfg, budgetCallback, events: { emit }, logger: d.logger, stateFile: join(d.home, 'state', 'media-search.json') });

  let unlisten: (() => void) | undefined;
  const store = d.store;
  if (store && kind !== 'disabled') {
    const recordOf = (m: Manifest): MediaRecord | null => {
      const file = m.files[0];
      return file ? { mediaId: m.id, kind: 'image', mime: `image/${file.format}`, source: { path: join(store.root, m.id, file.path) }, prompt: m.prompt } : null;
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
    scopeOf: principal => {
      const agentId = principal.kind === 'agent' ? principal.userId : 'main';
      const scope = agentScope(d.agents, agentId);
      return principal.kind === 'agent' ? scope : { ...scope, user: deriveUserPrincipal(principal.userId), trust: 'proved' };
    },
    ...createMediaOwnerAcl({ home: d.home }),
  }).methods;
}
