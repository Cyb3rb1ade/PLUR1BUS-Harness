// Private API-service operations over the SAME DeviceStore as the existing person-bound device RPCs.
import { apiPrincipal } from "@plur1bus/module-api";
import type { Handler } from "./server.ts";
import { RpcError } from "./errors.ts";
import { DeviceStore, DeviceError } from "../../../remote-access/src/device-store.ts";
import type { TrustNextEvent } from "../../../remote-access/src/trust-rollover.ts";
export function buildRemoteDeviceServiceSurface(store: () => DeviceStore, notify?: (event: TrustNextEvent, owners: string[]) => void): Record<string,Handler> {
 const bind=(fn:(p:any)=>unknown):Handler=>async(p,ctx)=>{
  if(apiPrincipal(ctx)!==null)throw new RpcError("E_DENIED","API service credential required",{reason:"api-service-only"});
  try{return await fn(p);}catch(e){if(e instanceof RpcError)throw e;if(e instanceof DeviceError)throw new RpcError(e.code==="storage"?"E_STORAGE":"E_DENIED","device operation refused",{reason:`device-${e.code}`});throw new RpcError("E_STORAGE","device operation unavailable");}
 };
 return {
  "admin.api.device.pair":bind(p=>({device:store().recordPairing({name:p.name,platform:p.platform,publicKey:p.publicKey,pairedBy:p.pairedBy,scope:p.scope})})),
  "admin.api.device.challenge":bind(()=>({challenge:store().challenge().toString("base64url")})),
  "admin.api.device.prove":bind(p=>{
   const device=store().get(p.id);if(device.publicKey!==p.publicKey)throw new RpcError("E_DENIED","device key mismatch");
   const clean=store().connect({publicKey:p.publicKey,challenge:Buffer.from(p.challenge,"base64url"),signature:Buffer.from(p.signature,"base64url"),close:()=>{}});clean();
   return {device};
  }),
  "admin.api.device.announce":bind(p=>{
   const owners=[...new Set(store().list().filter(d=>!d.revoked).map(d=>d.pairedBy))];
   if(!notify)throw new RpcError("E_NOT_AVAILABLE","device trust announcements unavailable");
   notify({type:"devices.trust.next",next:p.next,stagedAt:p.stagedAt},owners);return {announced:true};
  }),
 };
}
