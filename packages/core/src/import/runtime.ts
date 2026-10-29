/** Private post-restart completion uses the existing reembed driver while public writes remain held. */
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { apiPrincipal, isClientContext } from "@plur1bus/module-api";
import type { MigrationDriver } from "../embedding-migrate/driver.ts";
import { targetFromModel } from "../embedding-migrate/target.ts";
import type { PrincipalResolver } from "../rbac/guard.ts";
import type { Principal } from "../rbac/types.ts";
import type { CallContext, Handler } from "../rpc/server.ts";
import { RpcError } from "../rpc/errors.ts";
import { createImportRecords, type ImportPlanRecord } from "./maintenance-records.ts";
import { readColdBytes } from "./maintenance-files.ts";
import { writeAtomicSync } from "./fs-atomic.ts";
import { openMaintenanceJournal } from "./maintenance-journal.ts";
import { fingerprintImportTarget } from "./maintenance-worker.ts";

export interface ImportRunControl { runId: string; planId: string; planSha256: string }
export interface ImportRuntimeStatus {
  runId: string;
  state: "pending" | "completed" | "failed";
  completed: number;
  total?: number;
  restartRequired?: boolean;
  error?: { code: string; reason: string };
}
interface Receipt {
  schema: "import.runtime/1";
  runId: string;
  planSha256: string;
  attempt: number;
  state: "pending" | "completed" | "failed";
  migrationId?: string;
  finalizedInvocationId?: string;
}
interface RuntimeOptions {
  home: string;
  heldRunId(): string | undefined;
  resolvePrincipal: PrincipalResolver;
  /** Current AdminStore lookup; the original role stored in a plan is never authoritative. */
  person(id: string): Principal | null;
  model(model: string, licenceId: string | undefined, principal: Principal):
    Promise<{ present: boolean; licenceAccepted: boolean }>;
  runningModel(): string | undefined;
  driver(control: ImportRunControl, plan: ImportPlanRecord): MigrationDriver;
  /** Existing Engine store provisioning only, while public effects remain held. */
  prepareTarget?(): Promise<void>;
  release(runId: string): Promise<void>;
  cleanupSource?(plan: ImportPlanRecord): Promise<void>;
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$(?![\s\S])/;
const HASH = /^[a-f0-9]{64}$(?![\s\S])/;
const denied = () => new RpcError("E_DENIED", "Import runtime control is unavailable", { reason: "local-core-only" });
const unavailable = () => new RpcError("E_CONFLICT", "Import runtime job changed", { reason: "import-job-changed" });

export function createImportRuntime(options: RuntimeOptions) {
  const records = createImportRecords(options.home);
  const active = new Map<string, { driver?: MigrationDriver; done: Promise<void> }>();
  let closed = false;
  const path = (runId: string) => join(options.home, "imports", runId, "runtime.json");
  const save = (receipt: Receipt) => writeAtomicSync(path(receipt.runId), JSON.stringify(receipt) + "\n", 0o600);
  const receipt = async (control: ImportRunControl, attempt: number): Promise<Receipt | undefined> => {
    if (!await lstat(path(control.runId)).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw unavailable();
      return undefined;
    })) return undefined;
    const raw = JSON.parse((await readColdBytes(path(control.runId), 4096)).toString("utf8")) as Receipt;
    if (raw.schema !== "import.runtime/1" || raw.runId !== control.runId || raw.planSha256 !== control.planSha256
      || !["pending", "completed", "failed"].includes(raw.state) || !Number.isSafeInteger(raw.attempt)
      || Object.keys(raw).some(key => !["schema", "runId", "planSha256", "attempt", "state", "migrationId", "finalizedInvocationId"].includes(key))
      || raw.finalizedInvocationId !== undefined && !UUID.test(raw.finalizedInvocationId)
      || raw.migrationId !== undefined && (typeof raw.migrationId !== "string" || raw.migrationId.length > 256)) throw unavailable();
    return raw.attempt === attempt ? raw : undefined;
  };
  const authenticate = async (input: unknown, ctx: CallContext, method: string, full: boolean) => {
    if (closed || apiPrincipal(ctx) !== undefined || isClientContext(ctx)) throw denied();
    const caller = await options.resolvePrincipal(ctx, method, input);
    if (caller?.kind !== "person" || caller.role !== "owner") throw denied();
    if (!input || typeof input !== "object" || Array.isArray(input)) throw unavailable();
    const raw = input as Record<string, unknown>;
    if (typeof raw.runId !== "string" || !UUID.test(raw.runId) || raw.runId !== options.heldRunId()
      || Object.keys(raw).some(key => !(full ? ["runId", "planId", "planSha256"] : ["runId"]).includes(key))) throw unavailable();
    const native = JSON.parse((await readColdBytes(join(options.home, "imports", raw.runId, "maintenance-run.json"),
      256 * 1024)).toString("utf8")) as { version?: number; job?: Record<string, unknown>; run?: { state?: string } };
    const job = native.job;
    if (native.version !== 1 || !job || job.runId !== raw.runId || native.run?.state !== "restarting-core"
      || typeof job.planId !== "string" || !UUID.test(job.planId)
      || typeof job.planSha256 !== "string" || !HASH.test(job.planSha256) || typeof job.ownerId !== "string"
      || typeof job.invocationId !== "string" || !UUID.test(job.invocationId)
      || !["apply", "rollback", "recover"].includes(String(job.mode))
      || !Number.isSafeInteger(job.attempt) || (job.attempt as number) < 1
      || full && (job.planId !== raw.planId || job.planSha256 !== raw.planSha256)) throw unavailable();
    const control = { runId: raw.runId, planId: job.planId, planSha256: job.planSha256 };
    const { record: plan } = await records.readPlan(control.planId, job.ownerId, control.planSha256, true);
    if (plan.runId !== control.runId) throw unavailable();
    const actor = options.person(plan.ownerId);
    const restored = job.mode !== "apply";
    if (!restored && (actor?.kind !== "person" || !["owner", "admin"].includes(actor.role))) throw denied();
    return { control, plan, actor, attempt: job.attempt as number, restored, invocationId: job.invocationId };
  };
  const status = async (control: ImportRunControl, plan: ImportPlanRecord, attempt: number,
    restored: boolean, invocationId: string): Promise<ImportRuntimeStatus> => {
    const saved = await receipt(control, attempt);
    const state = saved?.state ?? "pending";
    const driver = active.get(control.runId)?.driver;
    const progress = await driver?.status();
    const completed = progress?.progress.rowsDone ?? 0;
    const total = progress?.progress.rows;
    const restartRequired = !restored && !!plan.options.reembed && options.runningModel() !== plan.options.reembed.model;
    if (state === "completed" && !restartRequired && !restored && saved?.finalizedInvocationId !== invocationId) {
      // Only this authenticated held generation can add legitimate bootstrap/reembed mutations to rollback's proof.
      await options.prepareTarget?.();
      const journal = openMaintenanceJournal(options.home, control.runId);
      const prior = journal.read();
      if (prior.phase !== "committed" || prior.attempt !== attempt || !prior.snapshotSha256) throw unavailable();
      const targetSha256 = await fingerprintImportTarget(options.home, plan.roots);
      journal.finalizeCommittedTarget(targetSha256);
      save({ ...saved!, finalizedInvocationId: invocationId });
    }
    return { runId: control.runId, state, completed, ...(total === undefined ? {} : { total }),
      ...(state === "completed" ? { restartRequired } : {}),
      ...(state === "failed" ? { error: { code: "E_IMPORT_FAILED", reason: "reembed-failed" } } : {}) };
  };
  const start = async (context: Awaited<ReturnType<typeof authenticate>>) => {
    const { control, plan, actor, attempt, restored } = context;
    const saved = await receipt(control, attempt);
    const metadata: Receipt = { schema: "import.runtime/1", runId: control.runId,
      planSha256: control.planSha256, attempt, state: "pending", ...(saved?.migrationId ? { migrationId: saved.migrationId } : {}) };
    if (restored || !plan.options.reembed) {
      if (saved?.state === "completed") return;
      save({ ...metadata, state: "completed" });
      return;
    }
    if (plan.sourceEmbedding?.model === plan.options.reembed.model) {
      if (saved?.state === "completed") return;
      if (!actor) throw denied();
      const check = await options.model(plan.options.reembed.model, plan.options.reembed.licenceId, actor);
      if (!check.present || !check.licenceAccepted) throw unavailable();
      save({ ...metadata, state: "completed" });
      return;
    }
    if (saved?.state === "completed" || saved?.state === "failed" || active.has(control.runId)) return;
    let begin!: () => void;
    const reserved = new Promise<void>(resolve => { begin = resolve; });
    const operation: { driver?: MigrationDriver; done: Promise<void> } = { done: reserved };
    active.set(control.runId, operation);
    operation.done = reserved.then(async () => {
      try {
        const requested = plan.options.reembed!;
        if (!actor) throw denied();
        const check = await options.model(requested.model, requested.licenceId, actor);
        if (!check.present || !check.licenceAccepted || closed) throw unavailable();
        const target = targetFromModel({ model: requested.model });
        if (!target.ok) throw unavailable();
        const driver = operation.driver = options.driver(control, plan);
        const prior = await driver.status();
        if (!metadata.migrationId) {
          const planned = await driver.plan({ target: target.fingerprint });
          if (!planned.plan) throw unavailable();
          metadata.migrationId = planned.plan.id;
          save(metadata);
        } else if (prior.checkpoint?.id !== metadata.migrationId) throw unavailable();
        const current = await driver.status();
        if (current.checkpoint?.phase !== "switched") {
          const checkpoint = current.checkpoint?.phase === "ready-to-switch" ? current.checkpoint
            : await (await driver.start()).done;
          if (checkpoint.phase !== "ready-to-switch" || closed) throw unavailable();
          if ((await driver.switch()).phase !== "switched") throw unavailable();
        }
        save({ ...metadata, state: "completed" });
      } catch {
        save({ ...metadata, state: "failed" });
      }
    });
    begin();
    void operation.done.catch(() => {});
  };
  const methods: Record<string, Handler> = {
    "admin.import.runtime.complete": async (input, ctx) => {
      const context = await authenticate(input, ctx, "admin.import.runtime.complete", true);
      await start(context);
      return status(context.control, context.plan, context.attempt, context.restored, context.invocationId);
    },
    "admin.import.runtime.status": async (input, ctx) => {
      const context = await authenticate(input, ctx, "admin.import.runtime.status", true);
      return status(context.control, context.plan, context.attempt, context.restored, context.invocationId);
    },
    "admin.import.runtime.release": async (input, ctx) => {
      const context = await authenticate(input, ctx, "admin.import.runtime.release", true);
      const current = await status(context.control, context.plan, context.attempt, context.restored, context.invocationId);
      if (current.state !== "completed" || current.restartRequired) throw unavailable();
      const marker = JSON.parse((await readColdBytes(join(options.home, "imports", context.control.runId,
        "activation.json"), 8192)).toString("utf8")) as Record<string, unknown>;
      if (marker.version !== 1 || marker.runId !== context.control.runId || marker.planSha256 !== context.control.planSha256
        || marker.attempt !== context.attempt || marker.invocationId !== context.invocationId
        || Object.keys(marker).some(key => !["version", "runId", "planSha256", "attempt", "invocationId", "result"].includes(key))
        || !marker.result || typeof marker.result !== "object" || Array.isArray(marker.result)) throw unavailable();
      const result = marker.result as Record<string, unknown>;
      if (typeof result.ok !== "boolean" || typeof result.restored !== "boolean" || typeof result.resumable !== "boolean"
        || !["completed", "aborted", "failed"].includes(String(result.status))) throw unavailable();
      if (!context.restored && result.ok === true && result.restored === false) await options.cleanupSource?.(context.plan);
      await options.release(context.control.runId);
      return { runId: context.control.runId, released: true };
    },
  };
  return { methods, async close(): Promise<void> {
    closed = true;
    await Promise.allSettled([...active.values()].map(operation => operation.driver?.stop(1000)));
  } };
}
