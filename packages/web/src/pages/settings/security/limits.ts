// Projection of the running configuration. The missing-key defaults preserve old servers.
import { getApi } from "../../common/load.ts";
export interface SecurityLimits { maxGrantDays:number; requireOsConfirmation:boolean; reasonMinChars:number; reasonMaxChars:number; maxWindowMinutes:number }
export const DEFAULT_SECURITY_LIMITS:SecurityLimits={maxGrantDays:90,requireOsConfirmation:true,reasonMinChars:10,reasonMaxChars:500,maxWindowMinutes:60};
const num = (v: unknown, def: number): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : def);
const flag = (v: unknown, def: boolean): boolean => (typeof v === "boolean" ? v : def);
const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? v as Record<string, unknown> : {});
/** Only numbers and booleans of the right kind reach the page; anything else is the default. */
export function securityLimits(value:unknown):SecurityLimits {
 const cfg=obj(value),a=obj(cfg.approvals),b=obj(cfg.breakglass);
 const d=DEFAULT_SECURITY_LIMITS;
 return {maxGrantDays:num(a.maxGrantDays,d.maxGrantDays),requireOsConfirmation:flag(a.requireOsConfirmation,d.requireOsConfirmation),reasonMinChars:num(b.reasonMinChars,d.reasonMinChars),reasonMaxChars:num(b.reasonMaxChars,d.reasonMaxChars),maxWindowMinutes:num(b.maxWindowMinutes,d.maxWindowMinutes)};
}
export async function loadSecurityLimits(signal:AbortSignal):Promise<SecurityLimits>{
 const res=await getApi().rpc("config.get",undefined,{write:false,signal});return securityLimits(res.value);
}
