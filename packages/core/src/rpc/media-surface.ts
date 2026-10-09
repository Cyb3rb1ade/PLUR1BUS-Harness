import { join } from "node:path";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  FileJobPersistence,
  JobRunner,
  OutputStore,
  MediaError,
  metadataEnabled,
  type ImageAdapter,
  type ImageRequest,
  type Job,
} from "../../../media/src/index.ts";
import { atomicJson, safeId } from "../../../media/src/files.ts";
import type { CallBudget } from "../budget/index.ts";
import { authorize } from "../rbac/authorize.ts";
import { authenticatedPrincipal } from "../rbac/guard.ts";
import type { Principal } from "../rbac/types.ts";
import type { Handler, CallContext, NotifyOptions } from "./server.ts";
import { RpcError } from "./errors.ts";
import { surfaceError } from "./surface-errors.ts";

/** Hash reference contents incrementally; never JSON-expand image bytes into the policy request. */
export function mediaActionHash(
  operation: string,
  request: ImageRequest,
  agentId: string,
): string {
  const { referenceImages, mask, ...parameters } = request;
  const hash = createHash("sha256").update(
    JSON.stringify({
      operation,
      agentId,
      parameters,
      references: referenceImages?.length ?? 0,
      mask: !!mask,
    }),
  );
  for (const image of [...(referenceImages ?? []), ...(mask ? [mask] : [])]) {
    hash
      .update(image.format)
      .update(String(image.bytes.byteLength))
      .update(createHash("sha256").update(image.bytes).digest());
  }
  return hash.digest("hex");
}

export interface MediaSurfaceDeps {
  home: string;
  adapters: readonly ImageAdapter[];
  store: OutputStore;
  budget: CallBudget | null;
  signal: AbortSignal;
  policy: (
    operation: "generate" | "edit",
    request: ImageRequest,
    agentId: string,
    principal: Principal,
    ctx: CallContext,
  ) => Promise<void>;
  notify: (method: string, params: object, options: NotifyOptions) => void;
}
interface Owner {
  agentId: string;
  userId: string;
  connectionId: string;
}
interface Preferences {
  global: boolean;
  agents: Record<string, boolean>;
}
/** Surface orchestration only. Provider execution, persistence and accounting remain in the existing ports. */
export function createMediaSurface(d: MediaSurfaceDeps) {
  const jobs = new FileJobPersistence(join(d.home, "media", "jobs"));
  const ownerDir = join(d.home, "media", "owners");
  const active = new Set<Promise<void>>();
  const owner = async (id: string): Promise<Owner> => {
    try {
      return JSON.parse(
        await readFile(join(ownerDir, `${safeId(id)}.json`), "utf8"),
      ) as Owner;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT")
        throw new RpcError("E_NOT_FOUND", "media object not found");
      throw e;
    }
  };
  const check = (a: Principal, agentId: string, write = false) => {
    if (
      authorize(a, write ? "agent.use" : "agent.read", {
        kind: "agent",
        agentId,
      }).effect !== "allow"
    )
      throw new RpcError("E_DENIED", "agent rights required");
  };
  const visible = (a: Principal, agentId: string) =>
    authorize(a, "agent.read", { kind: "agent", agentId }).effect === "allow";
  const prefsPath = join(d.home, "media", "preferences.json");
  const preferences = async (): Promise<Preferences> => {
    try {
      return JSON.parse(await readFile(prefsPath, "utf8")) as Preferences;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT")
        return { global: false, agents: {} };
      throw e;
    }
  };
  const bind =
    (
      fn: (p: any, a: Principal, ctx: CallContext) => Promise<unknown>,
    ): Handler =>
    async (p, ctx) => {
      try {
        return await fn(p, authenticatedPrincipal(ctx), ctx);
      } catch (e) {
        return surfaceError(e);
      }
    };
  const publicJob = (job: Job, o: Owner) => ({
    id: job.id,
    agentId: o.agentId,
    adapter: job.adapter,
    operation: job.operation,
    state: job.state,
    progress: job.progress,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(job.output ? { outputId: job.output.id } : {}),
    ...(job.error ? { error: job.error } : {}),
  });
  const readOutput = async (id: string, a: Principal, write = false) => {
    const o = await owner(id);
    check(a, o.agentId, write);
    const manifest = await d.store.get(id);
    if (!manifest) throw new RpcError("E_NOT_FOUND", "output not found");
    return { manifest, o };
  };
  const image = async (id: string, a: Principal, index = 0) => {
    const { manifest } = await readOutput(id, a);
    const file = manifest.files[index];
    if (!file || !/^\d+\.(png|jpeg|webp)$/.test(file.path))
      throw new RpcError("E_INVALID_PARAMS", "invalid image index");
    if (file.bytes > 16 * 1024 * 1024)
      throw new RpcError(
        "E_NOT_AVAILABLE",
        "image exceeds RPC transfer limit",
        { reason: "too_large" },
      );
    const bytes = await readFile(join(d.store.root, safeId(id), file.path));
    if (
      bytes.length !== file.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== file.sha256
    )
      throw new MediaError("invalid_response");
    return { bytes, format: file.format as "png" | "jpeg" | "webp" };
  };
  const submit = (operation: "generate" | "edit") =>
    bind(async (p, a, ctx) => {
      check(a, p.agentId, true);
      const adapter = d.adapters.find(
        (adapter) => adapter.id === (p.adapter ?? d.adapters[0]?.id),
      );
      if (!adapter || !adapter.capabilities()[operation])
        throw new MediaError("backend_unavailable");
      const { referenceIds, maskId, ...request } = p.request as ImageRequest & {
        referenceIds?: string[];
        maskId?: string;
      };
      if (referenceIds?.length)
        request.referenceImages = await Promise.all(
          referenceIds.map((id) => image(id, a)),
        );
      if (maskId) request.mask = await image(maskId, a);
      if (operation === "edit" && !request.referenceImages?.length)
        throw new MediaError("unsupported_parameter");
      const prefs = await preferences();
      request.embedMetadata = metadataEnabled({
        global: prefs.global,
        ...(prefs.agents[p.agentId] === undefined
          ? {}
          : { agent: prefs.agents[p.agentId] }),
        ...(request.embedMetadata === undefined
          ? {}
          : { call: request.embedMetadata }),
      });
      await d.policy(operation, request, p.agentId, a, ctx);
      if (!d.budget)
        throw new RpcError("E_NOT_AVAILABLE", "budget unavailable");
      const units = [
        {
          kind: "image" as const,
          resolution: request.size
            ? `${request.size.width}x${request.size.height}`
            : "default",
          quantity: request.n ?? 1,
        },
      ];
      const admitted = d.budget.checkBeforeCall({
        principal: a.userId,
        agent: p.agentId,
        project: "direct",
        model: adapter.model ?? adapter.id,
        provider: adapter.id,
        estimatedInputTokens: 0,
        maxOutputTokens: 0,
        media: units,
      });
      if (admitted.kind === "refuse")
        throw new RpcError("E_DENIED", "media budget exceeded", {
          reason: "budget_exceeded",
        });
      const reservationId = admitted.reservationId;
      const selectedAdapter = adapter;
      let submitted = false;
      const reserved: ImageAdapter = {
        id: adapter.id,
        ...(adapter.model ? { model: adapter.model } : {}),
        capabilities: () => adapter.capabilities(),
        generate: run("generate"),
        edit: run("edit"),
      };
      function run(op: "generate" | "edit") {
        return async (
          r: ImageRequest,
          c?: import("../../../media/src/index.ts").GenerationContext,
        ) => {
          submitted = true;
          try {
            const result = await selectedAdapter[op](r, c);
            d.budget!.settle(reservationId, {
              inputTokens: 0,
              outputTokens: 0,
              media: [{ ...units[0]!, quantity: result.files.length }],
            });
            return result;
          } catch (e) {
            if (c?.signal?.aborted)
              d.budget!.settle(reservationId, {
                inputTokens: 0,
                outputTokens: 0,
                media: units,
              });
            else d.budget!.releaseUnused(reservationId);
            throw e;
          }
        };
      }
      const persistence = {
        get: (id: string) => jobs.get(id),
        list: () => jobs.list(),
        claim: (id: string) => jobs.claim(id),
        async put(job: Job) {
          await jobs.put(job);
          if (
            job.state === "running" ||
            ["succeeded", "failed", "cancelled"].includes(job.state)
          )
            d.notify(
              job.state === "running"
                ? "media.job.progress"
                : "media.job.finished",
              {
                jobId: job.id,
                agentId: p.agentId,
                state: job.state,
                fraction: job.progress.fraction,
              },
              { audience: [ctx.connectionId] },
            );
        },
      };
      const runner = new JobRunner(persistence, d.store, [reserved]);
      let job: Job;
      let queuedId: string | undefined;
      try {
        job = await runner.enqueue(adapter.id, request, operation);
        queuedId = job.id;
        await atomicJson(join(ownerDir, `${job.id}.json`), {
          agentId: p.agentId,
          userId: a.userId,
          connectionId: ctx.connectionId,
        });
      } catch (e) {
        d.budget.releaseUnused(reservationId);
        if (queuedId)
          await rm(join(jobs.root, `${queuedId}.json`), { force: true }).catch(
            () => {},
          );
        throw e;
      }
      const cancel = new AbortController();
      runners.set(job.id, cancel);
      const task = runner
        .run(job.id, AbortSignal.any([d.signal, cancel.signal]))
        .catch(() => {})
        .finally(() => {
          if (!submitted) d.budget!.releaseUnused(reservationId);
          runners.delete(job.id);
          active.delete(task);
        });
      active.add(task);
      return { jobId: job.id };
    });
  const runners = new Map<string, AbortController>();
  const methods: Record<string, Handler> = {
    "media.generate": submit("generate"),
    "media.edit": submit("edit"),
    "media.job.get": bind(async (p, a) => {
      const o = await owner(p.id);
      check(a, o.agentId);
      const job = await jobs.get(p.id);
      if (!job) throw new RpcError("E_NOT_FOUND", "job not found");
      return publicJob(job, o);
    }),
    "media.job.list": bind(async (p, a) => {
      const result = [];
      for (const job of await jobs.list()) {
        const o = await owner(job.id);
        if (visible(a, o.agentId) && (!p.agentId || p.agentId === o.agentId))
          result.push(publicJob(job, o));
      }
      return { jobs: result };
    }),
    "media.job.cancel": bind(async (p, a) => {
      const o = await owner(p.id);
      check(a, o.agentId, true);
      const running = runners.get(p.id);
      if (running) running.abort();
      else await new JobRunner(jobs, d.store, []).cancel(p.id);
      return { cancelled: true };
    }),
    "media.output.get": bind(async (p, a) => {
      const { manifest, o } = await readOutput(p.id, a);
      const file = p.file === undefined ? null : await image(p.id, a, p.file);
      return {
        manifest: { ...manifest, agentId: o.agentId },
        canShare: false,
        ...(file
          ? {
              data: Buffer.from(file.bytes).toString("base64"),
              mimeType: `image/${file.format}`,
            }
          : {}),
      };
    }),
    "media.output.list": bind(async (p, a) => {
      await mkdir(ownerDir, { recursive: true, mode: 0o700 });
      const outputs = [];
      for (const name of await readdir(ownerDir)) {
        if (!name.endsWith(".json")) continue;
        const id = name.slice(0, -5);
        const o = await owner(id);
        if (!visible(a, o.agentId) || (p.agentId && p.agentId !== o.agentId))
          continue;
        const m = await d.store.get(id);
        if (
          m &&
          (!p.adapter || m.metadata.adapter === p.adapter) &&
          (p.after === undefined || m.createdAt >= p.after) &&
          (p.before === undefined || m.createdAt <= p.before)
        )
          outputs.push({ ...m, agentId: o.agentId });
      }
      return { outputs };
    }),
    "media.output.delete": bind(async (p, a) => {
      await readOutput(p.id, a, true);
      await d.store.delete(p.id);
      return { deleted: true };
    }),
    "media.adapters.list": bind(async () => ({
      adapters: d.adapters.map((a) => ({
        id: a.id,
        model: a.model,
        capabilities: a.capabilities(),
      })),
    })),
    "media.preferences.get": bind(async () => preferences()),
    "media.preferences.set": bind(async (p, a) => {
      if (p.agentId) {
        if (
          authorize(a, "agent.manage", { kind: "agent", agentId: p.agentId })
            .effect !== "allow"
        )
          throw new RpcError("E_DENIED", "agent manage required");
      } else if (
        authorize(a, "settings.write", { kind: "system" }).effect !== "allow"
      )
        throw new RpcError("E_DENIED", "settings write required");
      const prefs = await preferences();
      if (p.agentId) prefs.agents[p.agentId] = p.embedMetadata;
      else prefs.global = p.embedMetadata;
      await atomicJson(prefsPath, prefs);
      return prefs;
    }),
  };
  const storeFor = (agentId: string, userId: string): OutputStore =>
    new (class extends OutputStore {
      constructor() {
        super(d.store.root, d.store.options);
      }
      override async put(
        id: string,
        request: ImageRequest,
        result: import("../../../media/src/index.ts").ImageResult,
        agentMetadata?: boolean,
      ) {
        const prefs = await preferences();
        const call = request.embedMetadata;
        const manifest = await d.store.put(
          id,
          {
            ...request,
            embedMetadata: metadataEnabled({
              global: prefs.global,
              ...((agentMetadata ?? prefs.agents[agentId]) === undefined
                ? {}
                : { agent: agentMetadata ?? prefs.agents[agentId] }),
              ...(call === undefined ? {} : { call }),
            }),
          },
          result,
        );
        await atomicJson(join(ownerDir, `${id}.json`), {
          agentId,
          userId,
          connectionId: "",
        });
        return manifest;
      }
    })();
  const recover = async () => {
    // Never resubmit an interrupted RPC job or steal a live claim. Core owns this home exclusively on startup.
    await jobs.recoverClaims();
    for (const job of await jobs.list()) {
      if (!["queued", "running"].includes(job.state)) continue;
      const output = await d.store.get(job.id);
      if (output) {
        job.output = output;
        job.state = "succeeded";
        job.progress = { fraction: 1 };
      } else {
        job.state = "failed";
        job.error = "interrupted";
      }
      job.updatedAt = Date.now();
      await jobs.put(job);
    }
  };
  return {
    methods,
    storeFor,
    recover,
    async close() {
      await Promise.allSettled([...active]);
    },
  };
}
