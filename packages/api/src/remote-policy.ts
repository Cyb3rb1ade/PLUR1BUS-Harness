import { isIP } from "node:net";
import { compileAllowlist, SECURITY_NOTICE_VERSION } from "../../remote-access/src/security.ts";
import { loopbackBind } from "./server.ts";
export interface RemoteListenerPolicy {publish:"network"|"tailnet";publicOrigin:string;allowSubnets?:readonly string[];noticeAck?:{by:string;at:number;version:number}}
/** Every caller, including embedders, must satisfy transport invariants before binding. */
export function remoteListenerPolicy(host:string,tls:boolean,remote?:RemoteListenerPolicy) {
  if(!remote)return {host:loopbackBind(host),secure:tls};
  const origin=new URL(remote.publicOrigin);
  if(origin.protocol!=="https:"||origin.username||origin.password||origin.pathname!=="/"||origin.search||origin.hash)throw new Error("remote publicOrigin must be an HTTPS origin");
  if(remote.publish==="tailnet")loopbackBind(host);
  else {
    if(!tls)throw new Error("network API requires TLS");
    if(!isIP(host))throw new Error("network bind must be a literal IP address");
    if(remote.noticeAck?.version!==SECURITY_NOTICE_VERSION||!remote.noticeAck.by.trim()||!Number.isSafeInteger(remote.noticeAck.at))throw new Error("network security notice must be confirmed");
  }
  const list=compileAllowlist(remote.allowSubnets??[]);if(!list.ok)throw new Error("invalid remote subnet allowlist");
  return {host,secure:true,origin:origin.origin.toLowerCase(),hostHeader:origin.host.toLowerCase(),allowlist:list.list};
}
export function secondFactorRequired(role:string,remote:boolean,policy:"remote"|"always"|"never"="remote") { return (role==="owner"||role==="admin") && (policy==="always"||policy==="remote"&&remote); }
