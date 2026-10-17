import { authenticatedPrincipal } from "../rbac/guard.ts";
import { authorize } from "../rbac/authorize.ts";
import type { Handler } from "./server.ts";
import { RpcError } from "./errors.ts";
import type { LicenceLedger } from "../licences/ledger.ts";
import { memoryModel, checkMemorySelection } from "../licences/memory.ts";
export const LICENCE_RULES = Object.fromEntries(["model.licence.confirm", "model.licence.list", "model.licence.check"].map(method => [method, { action: "settings.write", humanOnly: true, resource: () => ({ kind: "system" as const }) }]));
export function buildLicenceSurface(ledger: LicenceLedger, current: () => unknown = () => undefined): Record<string, Handler> {
  const bind = (fn: (p: any, who: string) => unknown): Handler => async (p, ctx) => {
    const who = authenticatedPrincipal(ctx);
    if (who.kind !== "person" || !["owner", "admin"].includes(who.role) || authorize(who,"settings.write",{kind:"system"}).effect !== "allow") throw new RpcError("E_DENIED", "model licence confirmation requires Owner/Admin");
    ledger.recordAccess(who.userId);
    return fn(p,who.userId);
  };
  return {
    "model.licence.confirm": bind((p, who) => { if (p.accepted !== true) throw new RpcError("E_INVALID_PARAMS", "explicit acceptance required"); const m = memoryModel(p.model); return { acceptance: ledger.confirm(who,m.model,m.licence,m.revision,"memory") }; }),
    "model.licence.list": bind(() => ({ acceptances: ledger.list() })),
    "model.licence.check": bind((p, who) => { checkMemorySelection(ledger,who,p.changes,current()); return { ok:true }; }),
  };
}
