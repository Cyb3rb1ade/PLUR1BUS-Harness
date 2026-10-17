// Shared model acceptance ledger: the caller supplies a model selection, never the recorded actor or timestamp.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import type { AuditSink } from "../rbac/audit.ts";
export interface LicenceAcceptance { who: string; at: string; licence: string; model: string; revision: string; source: "memory" | "voice" }
export class LicenceLedger {
  readonly db: DatabaseSync;
  private audit: AuditSink; private clock: () => number;
  constructor(path: string, audit: AuditSink, clock: () => number) {
    this.audit = audit; this.clock = clock;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:" && process.platform !== "win32") chmodSync(path, 0o600);
    this.db.exec("PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS model_licences (who TEXT NOT NULL, at TEXT NOT NULL, licence TEXT NOT NULL, model TEXT NOT NULL, revision TEXT NOT NULL, source TEXT NOT NULL, PRIMARY KEY(who,licence,model,revision,source))");
  }
  recordAccess(who: string) { this.audit.append({ at:this.clock(), actor:{user:who,host:"rpc"}, action:"model.licence.access", target:"model-licences", detail:{} }); }
  confirm(who: string, model: string, licence: string, revision: string, source: LicenceAcceptance["source"]): LicenceAcceptance {
    const at = new Date(this.clock()).toISOString();
    this.audit.append({ at: this.clock(), actor: { user: who, host: "rpc" }, action: "model.licence.confirmed", target: model, detail: { licence, revision, source } });
    this.db.prepare("INSERT OR IGNORE INTO model_licences VALUES (?,?,?,?,?,?)").run(who,at,licence,model,revision,source);
    return { ...this.db.prepare("SELECT * FROM model_licences WHERE who=? AND licence=? AND model=? AND revision=? AND source=?").get(who,licence,model,revision,source) } as unknown as LicenceAcceptance;
  }
  list(): LicenceAcceptance[] { return this.db.prepare("SELECT * FROM model_licences ORDER BY at,model").all().map(row => ({ ...row })) as unknown as LicenceAcceptance[]; }
  has(who: string, model: string, licence: string, revision: string): boolean { return !!this.db.prepare("SELECT 1 FROM model_licences WHERE who=? AND model=? AND licence=? AND revision=?").get(who,model,licence,revision); }
  close() { this.db.close(); }
}
