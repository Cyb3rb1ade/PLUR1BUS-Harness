// Projection of the running configuration. The missing-key defaults preserve old servers.
import { getApi } from "../../common/load.ts";
export interface SecurityLimits { maxGrantDays:number; requireOsConfirmation:boolean; reasonMinChars:number; reasonMaxChars:number; maxWindowMinutes:number }
export const DEFAULT_SECURITY_LIMITS:SecurityLimits={maxGrantDays:90,requireOsConfirmation:true,reasonMinChars:10,reasonMaxChars:500,maxWindowMinutes:60};
export function securityLimits(value:unknown):SecurityLimits {
 const cfg=value as {approvals?:Partial<SecurityLimits>;breakglass?:Partial<SecurityLimits>}|undefined;
 const a=cfg?.approvals,b=cfg?.breakglass;
 return {maxGrantDays:a?.maxGrantDays??90,requireOsConfirmation:a?.requireOsConfirmation??true,reasonMinChars:b?.reasonMinChars??10,reasonMaxChars:b?.reasonMaxChars??500,maxWindowMinutes:b?.maxWindowMinutes??60};
}
export async function loadSecurityLimits(signal:AbortSignal):Promise<SecurityLimits>{
 const res=await getApi().rpc("config.get",undefined,{write:false,signal});return securityLimits(res.value);
}
