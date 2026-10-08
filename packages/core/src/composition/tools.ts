import type { createHostctlPool } from '../../../hostctl/src/pool.ts';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { CallBudgetExceededError, type CallBudget } from '../budget/index.ts';
import { homedir } from 'node:os';
import { ToolRegistry, type ToolDef } from '../tools/registry.ts';
import { createFsTools } from '../tools/fs/tools.ts';
import { canonicalisePath, type PathRoot, type DenyEntry } from '../policy/paths-index.ts';
import { CAPABILITIES } from '../policy/index.ts';
import { HOST_TOOLS, createNodeHostContext, denyEntriesFor, isHostPlatform, type HostContext } from '../host-tools/index.ts';
import { createExecTool } from '../tools/exec/tool.ts';
import { createNodeProcessPort, systemTimers } from '../tools/exec/node-process.ts';
import { scopedMcpPort } from '../mcp/index.ts';
import type { ExecConfig } from '../tools/exec/types.ts';
import type { AuditSink } from '../rbac/audit.ts';
import type { GrantSource } from '../policy/index.ts';
import { mcpToolDefs, type McpToolPort } from '../tools/mcp-bridge.ts';
import { OutputStore, MediaError, type ImageAdapter, type ImageRequest } from '../../../media/src/index.ts';
import type { ChatRequest } from '../session/provider.ts';

export interface ToolCompositionOptions {
  home: string; budget?: CallBudget; degraded?: (service: string, error: unknown) => void; roots: readonly PathRoot[]; deny?: readonly DenyEntry[];
  host?: HostContext; exec?: Partial<ExecConfig>; audit: AuditSink; grants: GrantSource;
  mcp?: { port: McpToolPort; servers: readonly string[] };
  media?: { adapter: ImageAdapter; store: OutputStore };
  extra?: readonly ToolDef[];
  hostctl?: ReturnType<typeof createHostctlPool>;
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
  const registry = new ToolRegistry();
  const platform = isHostPlatform(process.platform) ? process.platform : 'linux';
  const deny = [...denyEntriesFor(homedir(), process.env, platform), { path: join(o.home, 'run') }, { path: join(o.home, 'state') }, ...(o.deny ?? [])];
  const fs = o.roots.length ? createFsTools({ roots: o.roots, deny }) : { tools: [] };
  for (const tool of fs.tools) {
    const run = tool.execute;
    registry.register({ ...tool, capability: tool.effect === 'read' ? 'fs.read' : 'fs.write', risk: 'low', trust: 'first-party', limits: { maxResultBytes: 1024 * 1024 }, classify: async args => {
    const raw = (args as { path: string }).path;
    const access = tool.effect === 'read' ? 'read' : 'write';
    const resolved = await canonicalisePath(raw, { roots: o.roots, deny, access, requireRoot: false, ...(o.roots[0] ? { cwd: o.roots[0].path } : {}) });
    if (!resolved.ok) return { flags: { outsideRoots: true, denyListHit: true }, targets: [raw], access };
    return { flags: { outsideRoots: resolved.rootId === null, denyListHit: false }, targets: [resolved.canonical], access };
  }, execute: async (args, ctx) => unwrap(await run(args, ctx)) });
  }
  const host = o.host ?? createNodeHostContext();
  for (const tool of HOST_TOOLS) {
    const cap = CAPABILITIES.get(tool.capability)!;
    registry.register({ name: tool.name, description: tool.description, inputSchema: tool.schema.input, capability: tool.capability, effect: cap.intrinsicEffect, risk: tool.riskClass, trust: 'first-party', classify: () => ({ flags: { outsideRoots: true } }), execute: async (args, ctx) => tool.run(args, { ...host, signal: ctx.signal }) });
  }
  // Only ToolDispatcher invokes this closure after a recorded D109 authorization. The inner exec gate is narrowed
  // to that already-authorized invocation; it still enforces config.mode, roots, deny paths, arguments and env.
  registry.register({ name: 'exec.run', description: 'Run an enabled, allowlisted program inside a granted root without a shell.', inputSchema: (await import('../tools/exec/tool.ts')).EXEC_RUN_SCHEMA, capability: 'shell.exec', effect: 'local-write', risk: 'medium', trust: 'first-party', execute: async (args, ctx) => {
    const tool = createExecTool({ config: { ...o.exec, mode: o.exec?.mode ?? 'deny', roots: o.roots, deny }, process: createNodeProcessPort(), timers: systemTimers, audit: o.audit, policy: { grants: o.grants, clock: { now: Date.now } }, policyContext: { principal: { person: ctx.principal }, subject: { kind: 'agent', agentId: ctx.agentId }, surface: ctx.surface ?? 0, ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}), overrides: { 'shell.exec': 'allowed' } } });
    const run = tool.execute; return unwrap(await run(args, ctx));
  } });
  if (o.media) for (const operation of ['generate', 'edit'] as const) {
    if (!o.media.adapter.capabilities()[operation]) continue;
    registry.register({ name: `image.${operation}`, description: `${operation} an image and return a durable output reference.`, inputSchema: { type: 'object', additionalProperties: false, properties: { referenceIds: { type: 'array', maxItems: 10, items: { type: 'string', pattern: '^[a-f0-9-]{36}$' } }, prompt: { type: 'string', minLength: 1, maxLength: 32000 }, n: { type: 'integer', minimum: 1, maximum: 10 }, format: { enum: ['png', 'jpeg', 'webp'] } }, required: ['prompt'] }, capability: 'net.submit', effect: 'money', risk: 'high', trust: 'first-party', execute: async (args, ctx) => {
      const { referenceIds, ...input } = args as ImageRequest & { referenceIds?: string[] };
      const references: NonNullable<ImageRequest['referenceImages']> = [];
      for (const id of referenceIds ?? []) {
        const manifest = await o.media!.store.get(id);
        const file = manifest?.files[0];
        if (!manifest || !file || !/^\d+\.(png|jpeg|webp)$/.test(file.path)) throw new MediaError('unsupported_parameter');
        references.push({ bytes: await readFile(join(o.media!.store.root, id, file.path)), format: file.format as 'png' | 'jpeg' | 'webp' });
      }
      const request: ImageRequest = { ...input, ...(references.length ? { referenceImages: references } : {}) };
      if (operation === 'edit' && !request.referenceImages?.length) throw new MediaError('unsupported_parameter');
      const media = [{ kind: 'image' as const, resolution: request.size ? `${request.size.width}x${request.size.height}` : 'default', quantity: request.n ?? 1 }];
      const admitted = o.budget?.checkBeforeCall({ principal: req.principal!, agent: ctx.agentId, project: req.projectId ?? 'direct', model: o.media!.adapter.model ?? o.media!.adapter.id, provider: o.media!.adapter.id, session: req.sessionId, ...(req.turnId ? { turn: req.turnId } : {}), estimatedInputTokens: 0, maxOutputTokens: 0, media });
      if (admitted?.kind === 'refuse') throw new CallBudgetExceededError(admitted);
      let result: Awaited<ReturnType<ImageAdapter['generate']>>;
      try { result = await o.media!.adapter[operation](request, { signal: ctx.signal }); }
      catch (e) {
        // A failed generation returns no media: nothing is billed, so the reservation is released. An abort may still complete
        // (and bill) remotely (docs/media.md), so it settles the requested quantity instead of leaving the reservation pending.
        if (admitted?.kind === 'allow') {
          if (ctx.signal.aborted) o.budget!.settle(admitted.reservationId, { inputTokens: 0, outputTokens: 0, media });
          else o.budget!.releaseUnused(admitted.reservationId);
        }
        throw e;
      }
      if (admitted?.kind === 'allow') o.budget!.settle(admitted.reservationId, { inputTokens: 0, outputTokens: 0, media: [{ ...media[0]!, quantity: result.files.length }] });
      ctx.signal.throwIfAborted();
      const manifest = await o.media!.store.put(randomUUID(), request, result);
      return { id: manifest.id, files: manifest.files, metadata: manifest.metadata };
    } });
  }
  for (const tool of o.roots.length ? (o.hostctl?.forRoots(o.roots, deny).definitions() ?? []) : []) registry.register(tool);
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
