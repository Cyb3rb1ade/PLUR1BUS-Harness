// The wizard must never report a model choice as effective while another embedding remains active.
import type { Handler } from "./server.ts";
import { authenticatedPrincipal } from "../rbac/guard.ts";
import { RpcError } from "./errors.ts";
import { targetFromModel } from "../embedding-migrate/target.ts";
import type { MigrationDriver } from "../embedding-migrate/driver.ts";
import type { ReembedEngine } from "../embedding-migrate/port.ts";
import type { LicenceLedger } from "../licences/ledger.ts";
import { checkMemorySelection } from "../licences/memory.ts";
import type { AuditSink } from "../rbac/audit.ts";
export function buildEmbeddingSelectionSurface(d: { ledger: LicenceLedger; currentModel(): string; migration: MigrationDriver; port: ReembedEngine; audit: AuditSink; clock(): number }): Record<string,Handler> {
 return { "model.embedding.select": async (p,ctx) => {
  const who=authenticatedPrincipal(ctx);
  if(who.kind!=="person" || !["owner","admin"].includes(who.role))throw new RpcError("E_DENIED","embedding selection requires Owner/Admin");
  d.audit.append({at:d.clock(),actor:{user:who.userId,host:"rpc"},action:"model.embedding.requested",target:"embedding",detail:{}});
  checkMemorySelection(d.ledger,who.userId,[{key:"engine.embedding.local.model",value:p.model}]);
  const target=targetFromModel({model:p.model});
  if(!target.ok)throw new RpcError("E_NOT_AVAILABLE","selected embedding is not pinned in this engine; choose multilingual-e5-small or a supported model",{reason:"embedding-model-unavailable"});
  if(p.model===d.currentModel())return {model:p.model,effective:true};
  // Public validation is required even for empty generations. The planner can create empty stores too; counting
  // zero rows is not proof that a concurrently served generation is safe to switch without validation.
  if(!d.port.validate)throw new RpcError("E_NOT_AVAILABLE","embedding migration requires an engine validation API; keep the active model or update the engine, then use memory reembed --plan and --run",{reason:"embedding-migration-unavailable"});
  d.audit.append({at:d.clock(),actor:{user:who.userId,host:"rpc"},action:"model.embedding.select",target:p.model,detail:{revision:target.fingerprint.revision}});
  const planned=await d.migration.plan({target:target.fingerprint});
  if(!planned.plan)throw new RpcError("E_NOT_AVAILABLE","embedding migration could not be planned",{reason:"embedding-migration-unavailable"});
  const result=await d.migration.run();
  if(result.phase!=="ready-to-switch")throw new RpcError("E_NOT_AVAILABLE","embedding migration requires recovery; follow memory reembed --status",{reason:"embedding-migration-unavailable"});
  await d.migration.switch();
  return {model:p.model,effective:true};
 } };
}
