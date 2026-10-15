import type { RouteSpec,Handler } from "./routes.ts";
import type { RemotePairingController } from "./remote-pairing-controller.ts";
const object=(properties:Record<string,unknown>,required=Object.keys(properties))=>({type:"object",additionalProperties:false,properties,required});
const text=(maxLength=128)=>({type:"string",minLength:1,maxLength});
const result={description:"Public pairing/trust metadata only; no certificate PEM, private key or code verifier.",schema:{type:"object"}};
const admin={action:"admin.pairing.read"},device={action:"device.list"},deviceWrite={action:"remote.device.write"};
/** Reviewed exceptions: nonce-only proof of an OWNER-opened code; redemption authenticates with its one-use code
 * plus the same TLS-bound proof receipt (network) or owner-issued HMAC QR offer (CA-verified tailnet origin). */
export const REMOTE_PAIRING_BOOTSTRAP_IDS=new Set(["remote.pair-proof","remote.device.pair"]);
export const REMOTE_PAIRING_ROUTES:readonly RouteSpec[]=[
 {id:"remote.pairing.status",method:"GET",path:"/api/v1/devices/pairing",tag:"devices",summary:"Owner/Admin pairing availability; hidden at local",auth:"session",authz:admin,csrf:false,rate:"read",stability:"experimental",since:"1.0.0",successStatus:200,success:result},
 {id:"remote.pairing.offer",method:"POST",path:"/api/v1/devices/pairing",tag:"devices",summary:"Open one bounded ephemeral pairing code; QR/deep-link includes verified leaf fingerprint",auth:"session",authz:admin,csrf:true,rate:"write",requestBody:object({}),stability:"experimental",since:"1.0.0",successStatus:201,success:result},
 {id:"remote.pair-proof",method:"POST",path:"/api/v1/devices/pair-proof",tag:"devices",summary:"Reviewed TLS-bootstrap exception: client nonce only, before code disclosure; Owner-opened code required",auth:"none",authz:"public",csrf:false,rate:"auth",requestBody:object({clientNonce:{type:"string",minLength:22,maxLength:86,pattern:"^[A-Za-z0-9_-]+$"}}),stability:"experimental",since:"1.0.0",successStatus:200,success:result},
 {id:"remote.device.pair",method:"POST",path:"/api/v1/devices/pair",tag:"devices",summary:"Reviewed one-use pairing-code grant; TLS-bound proof receipt or verified-tailnet HMAC QR offer; no password session minted",auth:"none",authz:"public",csrf:false,rate:"auth",requestBody:object({code:text(64),serverNonce:text(),clientNonce:text(),tag:text(),name:text(),platform:text(64),publicKey:text(4096)},["code","name","platform","publicKey"]),stability:"experimental",since:"1.0.0",successStatus:201,success:result},
 {id:"remote.trust.get",method:"GET",path:"/api/v1/devices/trust",tag:"devices",summary:"Authenticated current/next trust and caller-owned device acknowledgement progress",auth:"session",authz:device,csrf:false,rate:"read",stability:"experimental",since:"1.0.0",successStatus:200,success:result},
 {id:"remote.trust.challenge",method:"POST",path:"/api/v1/devices/trust/challenge",tag:"devices",summary:"One-use challenge for a caller-owned registered device on the trusted TLS origin",auth:"session",authz:deviceWrite,csrf:true,rate:"auth",requestBody:object({deviceId:text()}),stability:"experimental",since:"1.0.0",successStatus:200,success:result},
 {id:"remote.trust.ack",method:"POST",path:"/api/v1/devices/trust/ack",tag:"devices",summary:"Acknowledge staged trust after core verifies registered-device key possession; identity fields cannot grant ownership",auth:"session",authz:deviceWrite,csrf:true,rate:"write",requestBody:object({deviceId:text(),publicKey:text(4096),challenge:text(),signature:text(),pin:text()}),stability:"experimental",since:"1.0.0",successStatus:200,success:result},
 {id:"remote.trust.rotate",method:"POST",path:"/api/v1/devices/trust/rotate",tag:"devices",summary:"Owner/Admin stages and announces trust before activating a new certificate; unacknowledged devices must pair again",auth:"session",authz:admin,csrf:true,rate:"write",requestBody:object({operation:{enum:["stage","activate","cancel"]}}),stability:"experimental",since:"1.0.0",successStatus:200,success:result},
];
export function buildRemotePairingHandlers(controller:RemotePairingController|undefined):Record<string,Handler>{
 const unavailable:Handler=()=>({status:404,body:{schema:"error/1",error:"E_NOT_AVAILABLE",reason:"remote-local",message:"remote pairing unavailable"}});
 if(!controller)return Object.fromEntries(REMOTE_PAIRING_ROUTES.map(r=>[r.id,unavailable]));
 return {
  "remote.pairing.status":async i=>({body:await controller.status(i)}),
  "remote.pairing.offer":async i=>({status:201,body:await controller.offer(i)}),
  "remote.pair-proof":async i=>({body:{...await controller.proof(i)}}),
  "remote.device.pair":async i=>({status:201,body:await controller.pair(i)}),
  "remote.trust.get":async i=>({body:await controller.getTrust(i)}),
  "remote.trust.challenge":async i=>({body:await controller.challenge(i)}),
  "remote.trust.ack":async i=>({body:await controller.ack(i)}),
  "remote.trust.rotate":async i=>({body:{...await controller.rotate(i)}}),
 };
}
