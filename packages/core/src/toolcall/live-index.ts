import { loadCalibration, usagePrior, type CalibrationConfig } from './calibration.ts';
import type { Engine } from '@cyb3rb1ade/plur1bus-memory/types/engine.js';
import type { ExtensionCapability, ExtensionCapabilityFeed } from './extension-feed.ts';
import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, openSync, readFileSync, realpathSync, watch, type FSWatcher } from 'node:fs';
import { join, sep } from 'node:path';
import { readIndex } from '../import/skills-registry.ts';
import { frontmatter } from '../import/yaml-lite.ts';
import { CapabilityIndex, type CapabilityEntry } from './capabilities.ts';
import { SqliteCapabilityRegistry } from './sqlite-registry.ts';
import type { RegisteredTool } from '../tools/registry.ts';
import { RpcError } from '../rpc/errors.ts';
import type { SystemJobHandler } from '../system-jobs/index.ts';
import { skillDescription } from '../prompt/skills.ts';

const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const short = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().split(/\s+/u).slice(0, 25).join(' ').slice(0, 1000);
export interface SkillSelection { blocked?: readonly string[]; pinned?: readonly string[] }
export interface IndexedSkill { entry: CapabilityEntry; text: string; authoredDescription?: string }
export interface CapabilityView { index: CapabilityIndex; discovery: CapabilityIndex; agent?: string; skills: readonly IndexedSkill[]; ids: ReadonlySet<string> }
/** Trusted registration metadata, never inferred from third-party prose. */
export function toolEntry(tool: RegisteredTool, scope: string): CapabilityEntry {
  const generatedCategory = tool.name.startsWith('image.') ? 'media.image' : /^(fs|file)\./.test(tool.name) ? 'files.manage' : tool.name.startsWith('web.') ? 'web.research' : 'ops.system';
  const metadata = tool.discovery;
  const category = metadata?.category && /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/.test(metadata.category) ? metadata.category : generatedCategory;
  return { id: `tool:${digest(scope)}:${tool.name}`, name: tool.name, description: short(metadata?.summary ?? tool.description), category,
    kind: metadata?.kind ?? (tool.name.startsWith('mcp.') ? 'mcp-tool' : 'tool'), effect: tool.effect, risk: tool.risk, source: `turn:${digest(scope)}`, version: digest(JSON.stringify([tool.description, tool.inputSchema, tool.capability, tool.effect, tool.risk, metadata])),
    useWhen: short(metadata?.useWhen ?? tool.description), notFor: short(metadata?.notFor ?? 'Actions outside the dispatcher policy and granted scope.'), generatedFields: [!metadata?.category && 'category', !metadata?.summary && 'description', !metadata?.useWhen && 'useWhen', !metadata?.notFor && 'notFor'].filter((field): field is string => !!field) };
}
/** Core-owned store. Each view is constructed from CURRENT admitted registrations, never a global persisted snapshot. */
export class LiveCapabilityIndex {
  readonly registry: SqliteCapabilityRegistry;
  readonly #home: string;
  /** The configured skill store home; tool composition uses this same source instead of a duplicate setting. */
  get home(): string { return this.#home; }
  readonly #clock: () => number;
  extensionFeed: Pick<ExtensionCapabilityFeed, 'snapshot'> | undefined;
  #extensions: ExtensionCapability[] = [];
  #embeddingReady = false;
  readonly #engine: Pick<Engine, 'embedding' | 'models'> | undefined;
  #skills: IndexedSkill[] = [];
  #lastCheck: number | null = null;
  #calibration: CalibrationConfig;
  readonly #priors = new Map<string, number>();
  #error = false;
  #feedError = false;
  #closed = false;
  readonly #watchers: FSWatcher[] = [];
  #watchTimer: NodeJS.Timeout | undefined;
  constructor(home: string, clock: () => number = Date.now, engine?: Pick<Engine, 'embedding' | 'models'>) { this.#engine = engine; this.#home = home; this.#clock = clock; this.registry = new SqliteCapabilityRegistry(join(home, 'state', 'capabilities.sqlite'), clock); this.#calibration = this.#loadCalibration(); }
  #loadCalibration(): CalibrationConfig {
    try { return loadCalibration(join(this.#home, 'capability-calibration.json')); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; return loadCalibration(); }
  }
  refreshSkills(): void {
    if (this.#closed) return;
    const skills: IndexedSkill[] = [];
    try {
      const root = realpathSync(join(this.#home, 'skills'));
      if (root !== join(realpathSync(this.#home), 'skills')) throw Error('skill store is a symlink');
      const indexed = readIndex(this.#home).skills;
      const items = this.extensionFeed ? this.#extensions.map(e => ({ id: e.name, enabled: e.enabled })) : indexed;
      for (const item of items) {
        if (item.enabled !== true) continue;
        try {
          const folder = realpathSync(join(root, item.id));
          if (folder !== join(root, item.id) || !folder.startsWith(root + sep)) continue;
          const fd = openSync(join(folder, 'SKILL.md'), constants.O_RDONLY | constants.O_NOFOLLOW);
          let text: string;
          try { const st = fstatSync(fd); if (!st.isFile() || st.size > 64 * 1024) continue; text = readFileSync(fd, 'utf8'); } finally { closeSync(fd); }
          const meta = frontmatter(text); if (!meta || typeof meta.description !== 'string') continue;
          const authored = typeof meta.category === 'string' && /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/.test(meta.category);
          const description = short(meta.description); if (!description) continue;
          const entry: CapabilityEntry = { id: `skill:${item.id}`, name: item.id, description, category: authored ? String(meta.category) : 'general.chat', kind: 'skill', effect: 'read', risk: 'low', source: 'skills', version: digest(text),
            useWhen: typeof meta.useWhen === 'string' ? short(meta.useWhen) : description, notFor: typeof meta.notFor === 'string' ? short(meta.notFor) : 'Granting permissions or bypassing approval.', generatedFields: [...(authored ? [] : ['category']), ...(typeof meta.useWhen === 'string' ? [] : ['useWhen']), ...(typeof meta.notFor === 'string' ? [] : ['notFor'])] };
          skills.push({ entry, text, authoredDescription: skillDescription(meta.description) });
        } catch { /* incomplete install, removed or unsafe path: absent on this turn */ }
      }
      this.#error = this.#feedError;
    } catch (e) {
      // A store that has not been created is empty. Other errors fail closed and are visible in Doctor.
      this.#error = this.#feedError || (e as NodeJS.ErrnoException).code !== 'ENOENT';
    }
    this.#replace('skills', skills.map(s => s.entry));
    this.#skills = skills;
  }
  watchSkills(): void {
    let attached = false;
    const changed = () => { clearTimeout(this.#watchTimer); this.#watchTimer = setTimeout(() => this.refreshSkills(), 25); this.#watchTimer.unref(); };
    const attach = () => {
      if (attached || this.#closed) return;
      try { const watcher = watch(join(this.#home, 'skills'), { recursive: true }, changed); watcher.on('error', () => { this.#error = true; }); watcher.unref(); this.#watchers.push(watcher); attached = true; } catch { /* store is not installed yet; the home watcher retries */ }
    };
    const parent = watch(this.#home, (_event, name) => { if (name === 'skills') { attach(); changed(); } });
    parent.on('error', () => { this.#error = true; }); parent.unref(); this.#watchers.push(parent); attach();
  }
  #replace(source: string, entries: readonly CapabilityEntry[]): void {
    const current = new Set(entries.map(e => e.id));
    for (const entry of entries) {
      const old = this.registry.snapshot().find(e => e.id === entry.id);
      if (old?.version !== entry.version) for (const key of this.#priors.keys()) if ((JSON.parse(key) as [string, string])[1] === entry.id) this.#priors.delete(key);
      this.registry.upsert(entry);
    }
    for (const old of this.registry.snapshot()) if (old.source === source && !current.has(old.id)) { this.registry.remove(old.id); for (const key of this.#priors.keys()) if ((JSON.parse(key) as [string, string])[1] === old.id) this.#priors.delete(key); }
  }
  async syncExtensions(): Promise<void> {
    if (!this.extensionFeed) return;
    try { this.#extensions = await this.extensionFeed.snapshot(); this.#feedError = false; } catch { this.#extensions = []; this.#feedError = true; }
    this.refreshSkills();
  }
  /** Called at the turn boundary: file-store changes and agent MCP revocations cannot wait for a watcher. */
  view(scope: string, tools: readonly RegisteredTool[], selection: SkillSelection = {}, agent?: string): CapabilityView {
    this.refreshSkills();
    const entries = tools.map(t => toolEntry(t, scope));
    this.#replace(`turn:${digest(scope)}`, entries);
    const skills = this.#skills.filter(s => !selection.blocked?.includes(s.entry.name) && (!this.extensionFeed || this.#extensions.some(e => e.name === s.entry.name && (e.agents === 'all' || (agent !== undefined && e.agents.includes(agent))))));
    for (const e of [...entries, ...skills.map(s => s.entry)]) if (!this.#priors.has(JSON.stringify([agent, e.id]))) this.#priors.set(JSON.stringify([agent, e.id]), usagePrior(this.registry.weightedStats(e.id, agent, this.#calibration.halfLifeDays), this.registry.weightedStats(e.id, undefined, this.#calibration.halfLifeDays), this.#calibration));
    const allowed = new Set([...entries, ...skills.map(s => s.entry)].map(e => e.id));
    const index = new CapabilityIndex(undefined, (query, candidates) => { const ids = new Set(candidates.map(e => e.id)); return new Map(this.registry.search(query, ids, 128).map((e, i) => [e.id, 1 / (i + 1)])); }, e => this.#priors.get(JSON.stringify([agent, e.id])) ?? 0);
    for (const entry of [...entries, ...skills.map(s => s.entry)]) index.upsert(entry);
    const discovery = new CapabilityIndex(undefined, (query, candidates) => new Map(this.registry.search(query, new Set(candidates.map(e => e.id)), 128).map((e, i) => [e.id, 1 / (i + 1)])));
    for (const entry of [...entries, ...skills.map(s => s.entry)]) discovery.upsert(entry);
    return { index, discovery, skills, ids: allowed, ...(agent ? { agent } : {}) };
  }
  /** Never starts or downloads a model: only uses the engine's already-ready local embedding service. */
  async prepare(query: string, view: CapabilityView, signal: AbortSignal): Promise<CapabilityIndex> {
    const status = this.#engine?.models?.status().embedder;
    if (status?.state !== 'ready' || !['local-transformers', 'local-gguf', 'local-onnx', 'mlx'].includes(status.identity.provider)) { this.#embeddingReady = false; return view.index; }
    try {
      const model = JSON.stringify(status.identity);
      const rows = this.registry.snapshot().filter(e => view.ids.has(e.id));
      const missing = rows.filter(e => !this.registry.vector(e.id, model));
      const hashes = missing.map(e => this.registry.hash(e.id)!);
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(2000)]);
      if (missing.length) {
        const vectors = await this.#engine!.embedding.embed(missing.map(e => `${e.description} ${e.useWhen ?? ''}`), { kind: 'passage', identity: status.identity, signal: bounded });
        if (vectors.length !== missing.length) throw Error('invalid embedding batch');
        for (const [i, e] of missing.entries()) { if (vectors[i]?.length !== status.identity.dimensions) throw Error('invalid passage vector'); this.registry.putVector(e.id, hashes[i]!, model, Array.from(vectors[i]!)); }
      }
      const [vector] = await this.#engine!.embedding.embed([query.slice(0, 4096)], { kind: 'query', identity: status.identity, signal: bounded });
      if (!vector || vector.length !== status.identity.dimensions || Array.from(vector).some(v => !Number.isFinite(v))) throw Error('invalid query vector');
      const scores = new Map<string, number>();
      for (const e of rows) {
        const v = this.registry.vector(e.id, model); if (!v || v.length !== vector.length) continue;
        let dot = 0, a = 0, b = 0;
        for (let i = 0; i < v.length; i++) { dot += v[i]! * vector[i]!; a += v[i]! ** 2; b += vector[i]! ** 2; }
        scores.set(e.id, a && b ? dot / Math.sqrt(a * b) : 0);
      }
      const index = new CapabilityIndex({ score: () => scores }, (text, entries) => new Map(this.registry.search(text, new Set(entries.map(e => e.id)), 128).map((e, i) => [e.id, 1 / (i + 1)])), e => this.#priors.get(JSON.stringify([view.agent, e.id])) ?? 0);
      for (const e of rows) index.upsert(e);
      this.#embeddingReady = true; return index;
    } catch { signal.throwIfAborted(); this.#embeddingReady = false; return view.index; }
  }
  recheck(): ReturnType<LiveCapabilityIndex['status']> {
    this.#calibration = this.#loadCalibration(); this.refreshSkills(); this.#lastCheck = this.#clock(); this.#priors.clear();
    for (const agent of this.registry.agents()) for (const e of this.registry.snapshot()) {
      const local = this.registry.weightedStats(e.id, agent, this.#calibration.halfLifeDays);
      const global = this.registry.weightedStats(e.id, undefined, this.#calibration.halfLifeDays);
      this.#priors.set(JSON.stringify([agent, e.id]), usagePrior(local, global, this.#calibration));
    }
    return this.status();
  }
  status() { return { mode: this.#embeddingReady ? 'fts5-vectors' : 'fts5-only', localEmbedding: this.#embeddingReady ? 'ready' : 'unavailable', entries: this.registry.snapshot().length, lastRecheck: this.#lastCheck, sourceError: this.#error }; }
  job(): SystemJobHandler {
    return { spec: { name: 'capabilities.recheck', needsLlm: false, singleton: true, exclusive: true, schedule: { every: 86_400_000, jitter: 0 } }, nextRunAt: () => { const next = new Date(this.#lastCheck ?? this.#clock()); next.setHours(3, 0, 0, 0); if (next.getTime() <= (this.#lastCheck ?? this.#clock())) next.setDate(next.getDate() + 1); return next.getTime(); },
      validateArgs(args) { if (args != null && (typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length)) throw new RpcError('E_INVALID_PARAMS', 'capability recheck takes no arguments'); return {}; },
      run: async (_args, ctx) => { ctx.signal.throwIfAborted(); await this.syncExtensions(); const detail = this.recheck(); return { outcome: detail.sourceError ? 'incomplete' : 'completed', detail }; } };
  }
  close(): void { this.#closed = true; clearTimeout(this.#watchTimer); for (const watcher of this.#watchers) watcher.close(); this.registry.close(); }
}
