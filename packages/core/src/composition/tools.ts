import { classifyHostTool } from '../host-tools/classify.ts';
import { createSandboxProcessPort, createSandboxHostExec, type SandboxOptions } from '../tools/sandbox/ports.ts';
import { codingCompletionTool, type CodingCompletion } from '../collab/coding-surface.ts';
import { collaborationTools, type CollaborationTools } from '../tools/collaboration.ts';
import type { createHostctlPool } from '../../../hostctl/src/pool.ts';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { CallBudgetExceededError, type CallBudget } from '../budget/index.ts';
import { homedir } from 'node:os';
import { ToolRegistry, type ToolClassification, type ToolDef, type ToolProcessSandbox } from '../tools/registry.ts';
import { createFsTools } from '../tools/fs/tools.ts';
import { canonicalisePath, type PathRoot, type DenyEntry } from '../policy/paths-index.ts';
import { CAPABILITIES } from '../policy/index.ts';
import { HOST_TOOLS, createNodeHostContext, denyEntriesFor, redactText, isHostPlatform, type HostContext } from '../host-tools/index.ts';
import { secretNamesTool, type SecretNamesPort } from '../tools/secret-names.ts';
import { createExecTool } from '../tools/exec/tool.ts';
import { buildEnv, DEFAULT_ENV_ALLOW, envFingerprint } from '../tools/exec/env.ts';
import { systemTimers } from '../tools/exec/node-process.ts';
import { scopedMcpPort } from '../mcp/index.ts';
import type { ExecConfig } from '../tools/exec/types.ts';
import type { LogWriter } from '../logs/writer.ts';
import type { AuditSink } from '../rbac/audit.ts';
import type { GrantSource } from '../policy/index.ts';
import { mcpToolDefs, type McpToolPort } from '../tools/mcp-bridge.ts';
import { OutputStore, MediaError, type ImageAdapter, type ImageRequest } from '../../../media/src/index.ts';
import type { ChatRequest } from '../session/provider.ts';
import { WebFailure } from '../tools/web/failure.ts';
import type { WebSearch } from '../tools/web/search.ts';
import { WEB_SEARCH_DESCRIPTION, WEB_SEARCH_SCHEMA } from '../tools/web/tools.ts';
import { DOCUMENT_RENDER_DESCRIPTION, DOCUMENT_RENDER_SCHEMA, reviewDocument, type DocumentRenderArgs, type ReviewBrowser, type TemplateId } from '../../../documents/src/index.ts';

/** hostctl routes that launch processes, native apps or OS services through the hostctl worker (no sandbox policy yet). */
const HOSTCTL_UNSANDBOXED = /^hostctl\.(?:proc\.(?:exec|start|shell)|app\.open|clipboard\.|notify|fs\.(?:search|trash))/;

export interface ToolCompositionOptions {
  sandbox?: SandboxOptions;
  collaboration?: CollaborationTools;
  coding?: CodingCompletion;
  home: string; budget?: CallBudget; degraded?: (service: string, error: unknown) => void; roots: readonly PathRoot[]; deny?: readonly DenyEntry[];
  host?: HostContext; exec?: Partial<ExecConfig>; audit: AuditSink; grants: GrantSource;
  mcp?: { port: McpToolPort; servers: readonly string[] };
  media?: { adapter: ImageAdapter; store: OutputStore };
  extra?: readonly ToolDef[];
  hostctl?: ReturnType<typeof createHostctlPool>;
  /** web.search over the configured SearXNG sidecar. Absent, the tool is not offered. */
  webSearch?: WebSearch;
  /** secret_names: this agent's secret names, scope and presence (never values). Absent, the tool is not offered. */
  secretNames?: SecretNamesPort;
  /** When set, exec.run child stdout/stderr are wrapped as untrusted `process.output.line` records. */
  output?: LogWriter;
  /** document.render (D100) over a headless Chromium. Absent, the tool is not offered. */
  documents?: { browser: ReviewBrowser };
}
async function classifyExecRun(args: unknown, o: { roots: readonly PathRoot[]; deny: readonly DenyEntry[]; exec?: Partial<ExecConfig>; sandboxed: boolean }): Promise<ToolClassification> {
  const raw = args && typeof args === 'object' && !Array.isArray(args) ? args as { cwd?: unknown; env?: unknown } : undefined;
  if (typeof raw?.cwd !== 'string') throw new Error('cwd must be a string');
  const resolved = await canonicalisePath(raw.cwd, { roots: o.roots, deny: o.deny, access: 'read', requireRoot: false, platform: process.platform });
  if (!resolved.ok) throw new Error(`cwd refused: ${resolved.reason}`);
  const env = buildEnv({ allow: o.exec?.envAllow ?? DEFAULT_ENV_ALLOW, base: process.env, requested: raw.env === undefined ? undefined : raw.env as Record<string, string>, windows: process.platform === 'win32' });
  // `sandboxed`: the process port confines every launch unless the owner turned `tools.sandbox.required` off (audited); a path grant
  // on the cwd then needs the person's explicit "not sandboxed" acknowledgement (D109 Q17, `decide`).
  return { flags: { outsideRoots: resolved.rootId === null, denyListHit: false, sandboxed: o.sandboxed, ...(resolved.systemTree ? { systemTree: true } : {}) }, targets: [resolved.canonical], hashExtra: envFingerprint(env), access: 'write' };
}

function unwrap(value: unknown): unknown {
  if (value && typeof value === 'object' && 'isError' in value) {
    if (value.isError === true) throw new ToolAdapterError('tool-failed', value);
    if ('value' in value) return value.value;
  }
  return value;
}
export class ToolAdapterError extends Error {
  readonly code: string; readonly detail: unknown;
  constructor(code: string, detail: unknown) { super(code); this.name = 'ToolAdapterError'; this.code = code; this.detail = detail; }
}
/** Registration is per turn for scoped MCP visibility. No executable tool escapes the dispatcher. */
export async function composeTools(o: ToolCompositionOptions, req: ChatRequest): Promise<ToolRegistry> {
  if (req.readOnlyWorktree) o = { ...o, roots: [{ id: req.agentId, path: req.readOnlyWorktree }] };
  const registry = new ToolRegistry();
  if (o.coding && o.collaboration) registry.register(codingCompletionTool(o.coding, req, () => o.collaboration!.principal(req)));
  if (o.collaboration) for (const tool of collaborationTools(o.collaboration, req)) registry.register(tool);
  const platform = isHostPlatform(process.platform) ? process.platform : 'linux';
  const deny = [...denyEntriesFor(homedir(), process.env, platform), { path: join(o.home, 'run') }, { path: join(o.home, 'state') }, { path: join(o.home, 'config.json') }, { path: join(o.home, 'bin') }, { path: join(o.home, 'runtime') }, { path: join(o.home, 'secrets') }, ...(o.deny ?? [])];
  const fs = o.roots.length ? createFsTools({ roots: o.roots, deny }) : { tools: [] };
  for (const tool of fs.tools) {
    const run = tool.execute;
    registry.register({ ...tool, capability: tool.effect === 'read' ? 'fs.read' : 'fs.write', risk: 'low', trust: 'first-party', limits: { maxResultBytes: 1024 * 1024 }, classify: async args => {
    const raw = (args as { path: string }).path;
    const access = tool.effect === 'read' ? 'read' : 'write';
    const resolved = await canonicalisePath(raw, { roots: o.roots, deny, access, requireRoot: false, ...(o.roots[0] ? { cwd: o.roots[0].path } : {}) });
    if (!resolved.ok) return { flags: { outsideRoots: true, denyListHit: true }, targets: [raw], access };
    return { flags: { outsideRoots: resolved.rootId === null, denyListHit: false, ...(resolved.systemTree ? { systemTree: true } : {}) }, targets: [resolved.canonical], access };
  }, execute: async (args, ctx) => unwrap(await run(args, ctx)) });
  }
  const sandboxOptions = { home: o.home, roots: o.roots, deny, audit: o.audit, principal: req.principal!, ...(o.sandbox ? { sandbox: o.sandbox } : {}) };
  const host = { ...(o.host ?? createNodeHostContext()), exec: createSandboxHostExec(sandboxOptions) };
  for (const tool of HOST_TOOLS) {
    const cap = CAPABILITIES.get(tool.capability)!;
    registry.register({ name: tool.name, description: tool.description, inputSchema: tool.schema.input, capability: tool.capability, effect: cap.intrinsicEffect, risk: tool.riskClass, trust: 'first-party', classify: args => classifyHostTool(tool, args, { roots: o.roots, deny }), execute: async (args, ctx) => tool.run(args, { ...host, signal: ctx.signal }) });
  }
  // Only ToolDispatcher invokes this closure after a recorded D109 authorization. The inner exec gate is narrowed
  // to that already-authorized invocation; it still enforces config.mode, roots, deny paths, arguments and env.
  registry.register({ name: 'exec.run', description: 'Run an enabled, allowlisted program inside a granted root without a shell.', inputSchema: (await import('../tools/exec/tool.ts')).EXEC_RUN_SCHEMA, capability: 'shell.exec', effect: 'local-write', risk: 'medium', trust: 'first-party', classify: args => classifyExecRun(args, { roots: o.roots, deny, sandboxed: o.sandbox?.required !== false, ...(o.exec ? { exec: o.exec } : {}) }), execute: async (args, ctx) => {
    if (ctx.classified) {
      const live = await classifyExecRun(args, { roots: o.roots, deny, sandboxed: o.sandbox?.required !== false, ...(o.exec ? { exec: o.exec } : {}) });
      if (ctx.classified.targets?.[0] !== live.targets?.[0] || ctx.classified.hashExtra !== live.hashExtra) {
        throw new Error('exec.run cwd/env no longer matches the classified call');
      }
    }
    const invocationRoots = ctx.classified?.flags?.outsideRoots && ctx.classified.targets?.[0] ? [...o.roots, { id: 'invocation-only', path: ctx.classified.targets[0] }] : o.roots;
    const tool = createExecTool({ config: { ...o.exec, mode: o.exec?.mode ?? 'deny', roots: invocationRoots, deny }, process: createSandboxProcessPort({ ...sandboxOptions, roots: invocationRoots }), timers: systemTimers, audit: o.audit, policy: { grants: o.grants, clock: { now: Date.now } }, policyContext: { principal: { person: ctx.principal }, subject: { kind: 'agent', agentId: ctx.agentId }, surface: ctx.surface ?? 0, ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}), overrides: { 'shell.exec': 'allowed' } }, ...(o.output ? { output: o.output } : {}) });
    const run = tool.execute; const value = unwrap(await run(args, ctx)); const result = value as { stdout: string; stderr: string }; return { ...(value as object), stdout: redactText(result.stdout), stderr: redactText(result.stderr), sandboxed: o.sandbox?.required !== false };
  } });
  if (o.media) for (const name of ['image.generate', 'image.edit', 'media.generate', 'media.edit'] as const) {
    if (name.startsWith('media.') && !CAPABILITIES.has(name)) continue;
    const operation = name.endsWith('edit') ? 'edit' as const : 'generate' as const;
    if (!o.media.adapter.capabilities()[operation] && !(name.startsWith('media.') && o.media.adapter.capabilities().video?.videoToVideo)) continue;
    registry.register({ name, description: `${operation} an image or video and return a durable output reference.`, inputSchema: { type: 'object', additionalProperties: false, properties: { kind: {enum:['image','video']}, durationSeconds:{type:'number',exclusiveMinimum:0,maximum:600}, resolution:{type:'string',maxLength:64}, fps:{type:'integer',minimum:1,maximum:120}, audio:{type:'boolean'}, aspect:{type:'string',maxLength:128}, embedMetadata:{type:'boolean'}, videoFormat:{enum:['mp4','mov','webm']}, referenceVideoId:{type:'string',pattern:'^[a-f0-9-]{36}$'}, referenceIds: { type: 'array', maxItems: 10, items: { type: 'string', pattern: '^[a-f0-9-]{36}$' } }, prompt: { type: 'string', minLength: 1, maxLength: 32000 }, n: { type: 'integer', minimum: 1, maximum: 10 }, format: { enum: ['png', 'jpeg', 'webp'] } }, required: ['prompt'] }, capability: name.startsWith('media.') ? `media.${operation}` : 'net.submit', effect: name.startsWith('media.') ? 'local-write' : 'money', classify: () => ({flags:{outsideRoots:false,denyListHit:false}}), risk: name.startsWith('media.') ? 'low' : 'high', trust: 'first-party', execute: async (args, ctx) => {
      if (name.startsWith('media.') && !o.budget) throw new MediaError('backend_unavailable');
      const { referenceIds, referenceVideoId, ...input } = args as ImageRequest & { referenceIds?: string[]; referenceVideoId?: string };
      const references: NonNullable<ImageRequest['referenceImages']> = [];
      for (const id of referenceIds ?? []) {
        const manifest = await o.media!.store.get(id);
        const file = manifest?.files[0];
        if (!manifest || !file || !/^\d+\.(png|jpeg|webp)$/.test(file.path)) throw new MediaError('unsupported_parameter');
        references.push({ bytes: await readFile(join(o.media!.store.root, id, file.path)), format: file.format as 'png' | 'jpeg' | 'webp' });
      }
      const request: ImageRequest = { ...input, ...(references.length ? { referenceImages: references } : {}) };
      if (referenceVideoId) {
        const manifest = await o.media!.store.get(referenceVideoId), file = manifest?.files[0];
        if (!file || !/^0\.(mp4|mov|webm)$/.test(file.path) || file.bytes > 16*1024*1024) throw new MediaError('unsupported_parameter');
        request.referenceVideo = {bytes:await readFile(join(o.media!.store.root,referenceVideoId,file.path)),format:file.format as 'mp4'|'mov'|'webm'};
      }
      if (operation === 'edit'  && !request.referenceImages?.length && !request.referenceVideo) throw new MediaError('unsupported_parameter');
      const admitted = o.budget?.checkBeforeCall({ principal: req.principal!, agent: ctx.agentId, project: req.projectId ?? 'direct', model: (request.kind === 'video' ? o.media!.adapter.capabilities().video?.model : undefined) ?? o.media!.adapter.model ?? o.media!.adapter.id, provider: o.media!.adapter.id, session: req.sessionId, ...(req.turnId ? { turn: req.turnId } : {}), estimatedInputTokens: 0, maxOutputTokens: 0 });
      if (admitted?.kind === 'refuse') throw new CallBudgetExceededError(admitted);
      let result: Awaited<ReturnType<ImageAdapter['generate']>>;
      try { result = await o.media!.adapter[operation](request, { signal: ctx.signal }); }
      catch (e) {
        // A failed generation returns no media, so the reservation is released. An abort may still complete remotely
        // (docs/media.md), so the call is settled (0 tokens) instead of leaving the reservation pending.
        if (admitted?.kind === 'allow') {
          if (ctx.signal.aborted) o.budget!.settle(admitted.reservationId, { inputTokens: 0, outputTokens: 0 });
          else if (request.kind !== 'video') o.budget!.releaseUnused(admitted.reservationId);
        }
        throw e;
      }
      ctx.signal.throwIfAborted();
      const manifest = await o.media!.store.put(randomUUID(), request, result);
      if (admitted?.kind === 'allow') o.budget!.settle(admitted.reservationId, { inputTokens: 0, outputTokens: 0 });
      return { id: manifest.id, files: manifest.files, metadata: manifest.metadata };
    } });
  }
  if (o.webSearch) {
    const webSearch = o.webSearch;
    // D109: a search is a network read (`net.fetch`). The sidecar is the only destination and it is fixed by configuration.
    registry.register({ name: 'web.search', description: WEB_SEARCH_DESCRIPTION, inputSchema: WEB_SEARCH_SCHEMA, capability: 'net.fetch', effect: CAPABILITIES.get('net.fetch')!.intrinsicEffect, risk: 'low', trust: 'first-party', execute: async (args, ctx) => {
      try { return await webSearch.search(args as never, { signal: ctx.signal, agentId: ctx.agentId, sessionId: ctx.sessionId }); }
      catch (e) { throw new ToolAdapterError('tool-failed', (e instanceof WebFailure ? e : new WebFailure('internal-error', 'unexpected failure')).toResult()); }
    } });
  }
  if (o.secretNames) registry.register(secretNamesTool(o.secretNames));
  // D106: hostctl's worker launches processes the harness sandbox cannot confine. The dispatcher enforces processSandbox on
  // every call (refused while required; owner bypass audited before each launch), so the tool itself stays unwrapped.
  const hostctlProcessSandbox: ToolProcessSandbox = { required: o.sandbox?.required !== false, recordBypass: launch => o.audit.append({ at: Date.now(), actor: { user: launch.principal, host: 'local' }, action: 'sandbox.bypass', target: launch.tool, detail: { required: false, sandboxed: false } }) };
  for (const tool of o.roots.length ? (o.hostctl?.forRoots(o.roots, deny).definitions() ?? []) : []) registry.register(HOSTCTL_UNSANDBOXED.test(tool.name) ? { ...tool, processSandbox: hostctlProcessSandbox } : tool);
  if (o.documents) {
    const browser = o.documents.browser;
    // Output is confined to the granted roots only: `requireRoot: true` refuses a path outside every root (no approval path).
    const resolveOutput = async (raw: string) => {
      const resolved = await canonicalisePath(raw, { roots: o.roots, deny, access: 'write', requireRoot: true, ...(o.roots[0] ? { cwd: o.roots[0].path } : {}) });
      if (!resolved.ok) return { refusal: resolved.reason };
      return { canonical: resolved.canonical };
    };
    registry.register({
      name: 'document.render', description: DOCUMENT_RENDER_DESCRIPTION, inputSchema: DOCUMENT_RENDER_SCHEMA as Record<string, unknown>,
      capability: 'fs.write', effect: 'local-write', risk: 'low', trust: 'first-party',
      classify: async (args) => {
        const raw = (args as DocumentRenderArgs).outputPath;
        const hit = await resolveOutput(raw);
        if ('refusal' in hit) return { flags: { outsideRoots: true, denyListHit: true }, targets: [raw], access: 'write' as const };
        return { flags: { outsideRoots: false, denyListHit: false }, targets: [hit.canonical], access: 'write' as const };
      },
      execute: async (args, ctx) => {
        const a = args as DocumentRenderArgs;
        const hit = await resolveOutput(a.outputPath); // re-check, fail closed, independent of the gate
        if ('refusal' in hit) throw new Error(`output path refused: ${hit.refusal}`);
        const { pdf, report } = await reviewDocument({ template: a.template as TemplateId, content: a.content, title: a.title, ...(a.subtitle ? { subtitle: a.subtitle } : {}), ...(a.meta ? { meta: a.meta } : {}) }, browser, {}, ctx.signal);
        await mkdir(dirname(hit.canonical), { recursive: true });
        await writeFile(hit.canonical, pdf);
        return { path: hit.canonical, bytes: pdf.byteLength, review: { checked: report.checked, findings: report.findings.map((f) => `${f.severity}:${f.check}:${f.message}`), vision: report.vision } };
      },
    });
  }
  for (const tool of o.extra ?? []) registry.register(tool);
  if (o.mcp) for (const server of o.mcp.servers) {
    req.signal.throwIfAborted();
    // MCP visibility is checked by its registry under the agent/principal passed here.
    try {
      // Policy uses the authenticated approving person; MCP visibility keeps the turn's canonical identity.
      const scoped = scopedMcpPort(o.mcp.port, req.principal!);
      const bridge = await mcpToolDefs(scoped, server, { agentId: req.agentId, principal: req.principal! }, { signal: req.signal });
      for (const skipped of bridge.skipped) o.degraded?.(`mcp.${server}`, skipped);
      for (const tool of bridge.tools) registry.register(tool);
    } catch (e) { req.signal.throwIfAborted(); o.degraded?.(`mcp.${server}`, e); }
  }
  return registry;
}
