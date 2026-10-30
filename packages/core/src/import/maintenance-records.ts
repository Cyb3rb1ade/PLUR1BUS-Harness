/** Immutable private source/plan/ticket records. Public requests supply IDs, never a worker path or target config. */
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { validateParams, type AdminImportPlanParams } from "@plur1bus/rpc-schema";
import { maintenanceRunDirectory } from "./maintenance-journal.ts";
import { normalizedRoots, privateBytes, readColdBytes, type MutationRoot } from "./maintenance-files.ts";
import { ImportError, isSourceType, type SourceType } from "./types.ts";
import type { SourceStoreModel } from "./source-store-model.ts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$(?![\s\S])/;
const HASH = /^[a-f0-9]{64}$(?![\s\S])/;
const SNAPSHOT = /^[A-Za-z0-9_-]{43}$(?![\s\S])/;
const PLAN_TTL_MS = 24 * 60 * 60 * 1000;
const PREFLIGHT_TTL_MS = 300_000;
const MAX_RECORD_BYTES = 8 * 1024 * 1024;
const unavailable = () => new ImportError("E_NOT_FOUND", "import-record-unavailable", "Import record is unavailable");

export type ImportPlanOptions = NonNullable<AdminImportPlanParams["options"]>;
export interface ImportPlanInput {
  ownerId: string;
  sourceId: string;
  snapshotId: string;
  sourceType: SourceType;
  sourceSha256: string;
  /** Sealed ancestors of a derived mapped source, authenticated by this plan's digest. */
  sourceSnapshots?: { id: string; sha256: string }[];
  /** Private, source-hash-bound candidate; only a source-model-configured Engine probe grants transfer. */
  sourceEmbedding?: SourceStoreModel;
  configRevision: string;
  options: ImportPlanOptions;
  roots: MutationRoot[];
  importBytes: number;
  coldBytes: number;
  entities: number;
  unresolvedConflicts: number;
}
export interface ImportPlanRecord extends ImportPlanInput {
  schema: "import.plan/1";
  id: string;
  runId: string;
  createdAt: string;
  expiresAt: string;
}
export interface ImportPreflightInput {
  ownerId: string;
  planId: string;
  runId: string;
  planSha256: string;
  sourceSha256: string;
  targetSha256: string;
  operation: "apply" | "rollback";
}
export interface ImportPreflightRecord extends ImportPreflightInput {
  schema: "import.preflight/1";
  id: string;
  createdAt: string;
  expiresAt: string;
}

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable();
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => !keys.includes(key))) throw unavailable();
  return raw;
}

function owner(value: unknown): value is string {
  return typeof value === "string" && !!value && value.length <= 512;
}

function hash(value: unknown): value is string {
  return typeof value === "string" && HASH.test(value);
}

function id(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function lifetime(raw: Record<string, unknown>): void {
  if (typeof raw.createdAt !== "string" || typeof raw.expiresAt !== "string"
    || !Number.isFinite(Date.parse(raw.createdAt)) || !Number.isFinite(Date.parse(raw.expiresAt))
    || Date.parse(raw.expiresAt) <= Date.parse(raw.createdAt)) throw unavailable();
}

const PLAN_INPUT = ["ownerId", "sourceId", "snapshotId", "sourceType", "sourceSha256", "sourceSnapshots", "sourceEmbedding", "configRevision", "options",
  "roots", "importBytes", "coldBytes", "entities", "unresolvedConflicts"];

function planInput(value: unknown): ImportPlanInput {
  const raw = object(value, PLAN_INPUT);
  if (!owner(raw.ownerId) || !id(raw.sourceId) || typeof raw.snapshotId !== "string" || !SNAPSHOT.test(raw.snapshotId)
    || !isSourceType(raw.sourceType) || !hash(raw.sourceSha256) || typeof raw.configRevision !== "string"
    || raw.configRevision.length > 256 || !validateParams("admin.import.plan", {
      sourceId: raw.sourceId, options: raw.options,
    }).ok) throw unavailable();
  for (const key of ["importBytes", "coldBytes", "entities", "unresolvedConflicts"]) {
    if (!Number.isSafeInteger(raw[key]) || (raw[key] as number) < 0) throw unavailable();
  }
  if (raw.sourceSnapshots !== undefined && (!Array.isArray(raw.sourceSnapshots) || raw.sourceSnapshots.length > 64
    || raw.sourceSnapshots.some(value => {
      const item = object(value, ["id", "sha256"]);
      return typeof item.id !== "string" || !SNAPSHOT.test(item.id) || !hash(item.sha256);
    }))) throw unavailable();
  if (raw.sourceEmbedding !== undefined) {
    const candidate = object(raw.sourceEmbedding, ["model", "dimensions", "storeId", "agentId"]);
    const settings = raw.options as ImportPlanOptions;
    if (typeof candidate.model !== "string" || candidate.model.length > 256 || !candidate.model
      || !Number.isSafeInteger(candidate.dimensions) || (candidate.dimensions as number) < 1 || (candidate.dimensions as number) > 16_384
      || typeof candidate.agentId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(candidate.agentId)
      || candidate.storeId !== `agent:${candidate.agentId}` || candidate.storeId !== settings.adoptStoreId
      || settings.adoptStrategy !== "re-embed" || !settings.reembed) throw unavailable();
  }
  if ((raw.options as ImportPlanOptions).adoptStrategy === "re-embed" && raw.sourceEmbedding === undefined) throw unavailable();
  const roots = normalizedRoots(raw.roots as MutationRoot[]);
  return { ...raw, roots } as unknown as ImportPlanInput;
}

function planRecord(value: unknown): ImportPlanRecord {
  const raw = object(value, ["schema", "id", "runId", "createdAt", "expiresAt", ...PLAN_INPUT]);
  if (raw.schema !== "import.plan/1" || !id(raw.id) || !id(raw.runId)) throw unavailable();
  lifetime(raw);
  const { schema: _schema, id: _id, runId: _runId, createdAt: _createdAt, expiresAt: _expiresAt, ...input } = raw;
  return { ...raw, ...planInput(input) } as unknown as ImportPlanRecord;
}

const PREFLIGHT_INPUT = ["ownerId", "planId", "runId", "planSha256", "sourceSha256", "targetSha256", "operation"];

function ticketInput(value: unknown): ImportPreflightInput {
  const raw = object(value, PREFLIGHT_INPUT);
  if (!owner(raw.ownerId) || !id(raw.planId) || !id(raw.runId) || !hash(raw.planSha256) || !hash(raw.sourceSha256)
    || !hash(raw.targetSha256) || !["apply", "rollback"].includes(String(raw.operation))) throw unavailable();
  return raw as unknown as ImportPreflightInput;
}

function ticketRecord(value: unknown): ImportPreflightRecord {
  const raw = object(value, ["schema", "id", "createdAt", "expiresAt", ...PREFLIGHT_INPUT]);
  if (raw.schema !== "import.preflight/1" || !id(raw.id)) throw unavailable();
  lifetime(raw);
  const { schema: _schema, id: _id, createdAt: _createdAt, expiresAt: _expiresAt, ...input } = raw;
  return { ...raw, ...ticketInput(input) } as unknown as ImportPreflightRecord;
}

/** Factory has no side effects. Each operation validates fixed private segments before opening a record. */
export function createImportRecords(home: string, options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  // A write creates and secures the record directory; a read only validates it (no icacls per read on Windows).
  const path = (kind: "plans" | "preflight", recordId: string, create = true) => {
    if (!id(recordId)) throw unavailable();
    return join(maintenanceRunDirectory(home, kind, { create }), recordId + ".json");
  };
  const read = async (kind: "plans" | "preflight", recordId: string) => {
    const bytes = await readColdBytes(path(kind, recordId, false), MAX_RECORD_BYTES);
    return { value: JSON.parse(bytes.toString("utf8")) as unknown,
      sha256: createHash("sha256").update(bytes).digest("hex") };
  };
  const write = async (kind: "plans" | "preflight", recordId: string, value: object) => {
    const bytes = Buffer.from(JSON.stringify(value) + "\n");
    if (bytes.length > MAX_RECORD_BYTES) throw unavailable();
    await privateBytes(path(kind, recordId), bytes);
    return createHash("sha256").update(bytes).digest("hex");
  };
  const readPlan = async (planId: string, ownerId: string, expectedSha256?: string, allowExpired = false) => {
    try {
      const raw = await read("plans", planId);
      if (expectedSha256 !== undefined && raw.sha256 !== expectedSha256) throw unavailable();
      const record = planRecord(raw.value);
      if (record.id !== planId || record.ownerId !== ownerId || !allowExpired && Date.parse(record.expiresAt) <= now()) {
        throw unavailable();
      }
      return { record, sha256: raw.sha256 };
    } catch {
      throw unavailable();
    }
  };
  return {
    async putPlan(input: ImportPlanInput): Promise<{ record: ImportPlanRecord; sha256: string }> {
      try {
        const checked = planInput(input);
        const record: ImportPlanRecord = { schema: "import.plan/1", ...checked, id: randomUUID(), runId: randomUUID(),
          createdAt: new Date(now()).toISOString(), expiresAt: new Date(now() + PLAN_TTL_MS).toISOString() };
        return { record, sha256: await write("plans", record.id, record) };
      } catch {
        throw unavailable();
      }
    },
    readPlan,
    async putPreflight(input: ImportPreflightInput): Promise<ImportPreflightRecord> {
      try {
        const checked = ticketInput(input);
        const plan = await readPlan(checked.planId, checked.ownerId, checked.planSha256, checked.operation === "rollback");
        if (plan.record.runId !== checked.runId || plan.record.sourceSha256 !== checked.sourceSha256) throw unavailable();
        const record: ImportPreflightRecord = { schema: "import.preflight/1", ...checked, id: randomUUID(),
          createdAt: new Date(now()).toISOString(), expiresAt: new Date(now() + PREFLIGHT_TTL_MS).toISOString() };
        await write("preflight", record.id, record);
        return record;
      } catch {
        throw unavailable();
      }
    },
    async readPreflight(preflightId: string, ownerId: string): Promise<ImportPreflightRecord> {
      try {
        const record = ticketRecord((await read("preflight", preflightId)).value);
        if (record.id !== preflightId || record.ownerId !== ownerId || Date.parse(record.expiresAt) <= now()) {
          throw unavailable();
        }
        return record;
      } catch {
        throw unavailable();
      }
    },
  };
}

export type ImportRecords = ReturnType<typeof createImportRecords>;
