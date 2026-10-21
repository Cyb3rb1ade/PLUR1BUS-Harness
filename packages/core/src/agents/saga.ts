// Crash-consistent agent provisioning. Intent precedes each effect; recovery reverses all attempted effects.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RpcError } from "../rpc/errors.ts";
export interface SagaStep { name: string; apply(): Promise<void>; undo(): Promise<void> }
export interface SagaRecord { version: 1; key: string; actor: string; digest: string; agentId: string; attempted: number; state: "running" | "undoing" | "complete" | "compensated"; activated?: boolean; payload: unknown }
export class AgentCreateSaga {
  readonly directory: string;
  constructor(state: string) { this.directory = join(state, "agent-create"); }
  private path(key: string, actor: string) { return join(this.directory, `${createHash("sha256").update(`${actor}\0${key}`).digest("hex")}.json`); }
  private save(record: SagaRecord) {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const path = this.path(record.key, record.actor), temp = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(record), { mode: 0o600, flag: "wx" });
    const fd = openSync(temp, "r+"); try { fsyncSync(fd); } finally { closeSync(fd); } // "r+": fsync on a read-only handle is EPERM on Windows
    renameSync(temp, path);
    // Windows does not support fsync on directory handles; the file is durable there.
    if (process.platform !== "win32") { const dir = openSync(this.directory, "r"); try { fsyncSync(dir); } finally { closeSync(dir); } }
  }
  find(key: string, actor: string): SagaRecord | undefined {
    const path = this.path(key, actor);
    if (!existsSync(path)) return undefined;
    const r = JSON.parse(readFileSync(path, "utf8")) as SagaRecord;
    if (r.version !== 1 || r.key !== key || r.actor !== actor || !Number.isInteger(r.attempted) || r.attempted < 0 || r.attempted > 4 || !["running", "undoing", "complete", "compensated"].includes(r.state)) throw new RpcError("E_STORAGE", "invalid provisioning journal");
    return r;
  }
  markActivated(record: SagaRecord) { record.activated = true; this.save(record); }
  completedUnactivated(): SagaRecord[] {
    if (!existsSync(this.directory)) return [];
    return readdirSync(this.directory).filter(n => n.endsWith(".json")).map(n => JSON.parse(readFileSync(join(this.directory,n),"utf8")) as SagaRecord).filter(r => r.state === "complete" && !r.activated);
  }
  pending(): SagaRecord[] {
    if (!existsSync(this.directory)) return [];
    return readdirSync(this.directory).filter(n => n.endsWith(".json")).map(n => JSON.parse(readFileSync(join(this.directory,n),"utf8")) as SagaRecord).filter(r => r.state === "running" || r.state === "undoing");
  }
  async compensate(record: SagaRecord, steps: SagaStep[]) {
    record.state = "undoing"; this.save(record);
    while (record.attempted > 0) {
      const step = steps[record.attempted - 1];
      if (!step) throw new RpcError("E_STORAGE", "invalid provisioning recovery step");
      await step.undo(); record.attempted--; this.save(record);
    }
    record.state = "compensated"; this.save(record);
  }
  async provision(record: SagaRecord, steps: SagaStep[]) {
    this.save(record);
    try {
      for (const [i, step] of steps.entries()) { record.attempted = i + 1; this.save(record); await step.apply(); }
      record.state = "complete"; this.save(record);
    } catch (error) {
      try { await this.compensate(record, steps); }
      catch { throw new RpcError("E_STORAGE", "agent provisioning compensation requires recovery", { ids: { agentId: record.agentId } }); }
      throw error;
    }
  }
}
export function creationDigest(payload: unknown): string {
  const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
  return createHash("sha256").update(JSON.stringify(canonical(payload))).digest("hex");
}
