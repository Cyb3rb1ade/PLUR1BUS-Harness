import { SCHEMA, validateParams } from "@plur1bus/rpc-schema";
import type { CoreRpc } from "./core-rpc.ts";
import type { Handler, HandlerInput, RouteSpec } from "./routes.ts";
import type { AuditEmitter } from "./audit.ts";
import { errors, fromCoreError } from "./errors.ts";

const defs=(SCHEMA as any).$defs;
function bodySchema(name:string) {
  const method=name==="create-agent"?"create":name;
  const schema=JSON.parse(JSON.stringify(defs.methods[`chat.${method}`].params));
  delete schema.properties.sessionId;
  if(name==="create-agent")delete schema.properties.agentId;
  delete schema.properties.idempotencyKey;
  schema.required=schema.required.filter((key:string)=>Object.hasOwn(schema.properties,key));
  // Inline AgentId to keep API schemas self-contained; RPC $defs are not API components.
  if(schema.properties.agentId?.$ref)schema.properties.agentId=defs.AgentId;
  return schema;
}
const routes = [
  ["list","GET","/api/v1/chats","read"], ["create","POST","/api/v1/chats","write"],
  ["create-agent","POST","/api/v1/agents/{agentId}/chats","write"],
  ["get","GET","/api/v1/chats/{sessionId}","read"], ["update","PATCH","/api/v1/chats/{sessionId}","write"],
  ["messages","GET","/api/v1/chats/{sessionId}/messages","read"], ["submit","POST","/api/v1/chats/{sessionId}/messages","write"],
  ["events","GET","/api/v1/chats/{sessionId}/events","read"], ["cancel","POST","/api/v1/chats/{sessionId}/cancel","write"],
  ["archive","POST","/api/v1/chats/{sessionId}/archive","write"], ["restore","POST","/api/v1/chats/{sessionId}/restore","write"],
  ["fork","POST","/api/v1/chats/{sessionId}/fork","write"], ["export","POST","/api/v1/chats/{sessionId}/export","read"],
  ["delete","DELETE","/api/v1/chats/{sessionId}","delete"],
] as const;
export const CHAT_ROUTES: readonly RouteSpec[] = routes.map(([name,method,path,scope]) => ({ id:`chats.${name}`,method,path,summary:`Own direct chat ${name}`,tag:"chats",auth:"any",authz:{action:`chat:${scope}`},csrf:method!=="GET",rate:method==="GET"?"read":"write",stability:"experimental",since:"1.0.0",...(method!=="GET"?{requestBody:bodySchema(name)}:{}),...(method==="GET"?{extra:{400:{description:"Unknown, duplicate or invalid chat query",schema:{$ref:"#/components/schemas/Error"}}}}:{}),successStatus:name==="create"||name==="create-agent"||name==="fork"?201:200,success:{description:"Principal-bound direct-chat result; incognito transcripts are volatile.",schema:{type:"object"}} }));
function query(i: HandlerInput, fields: readonly string[]) {
  const result: Record<string, unknown>={};
  for(const [key,value] of i.query ?? []) {
    if(!fields.includes(key)||Object.hasOwn(result,key))throw errors.badRequest("query","unknown or duplicate chat query");
    result[key]=["limit","afterSeq","beforeSeq"].includes(key)?Number(value):key==="agent"?value:value;
  }
  if (result.agent) { result.agentId=result.agent;delete result.agent; }
  if (result.q) { result.search=result.q;delete result.q; }
  if (result.state) { result.archived=result.state;delete result.state; }
  return result;
}
export function buildChatHandlers(core: CoreRpc, audit: AuditEmitter): Record<string, Handler> {
  return Object.fromEntries(routes.map(([name])=>[`chats.${name}`,async(i: HandlerInput)=>{
    const method=name==="create-agent"?"create":name==="messages"?"get":name;
    const params={...query(i,name==="list"?["agent","q","state","limit"]:name==="events"?["afterSeq","limit"]:["limit"]),...(i.body as object ?? {}),...i.pathParams};
    const key=i.headers?.["idempotency-key"];
    if(key !== undefined) {if(typeof key!=="string"||key.length<1||key.length>128)throw errors.badRequest("idempotency-key","invalid idempotency key");(params as Record<string,unknown>).idempotencyKey=key;}
    if (!validateParams(`chat.${method}`,params).ok)throw errors.badRequest("chat-params","invalid chat parameters");
    try {
      if(name==="submit" && i.headers?.accept?.includes("text/event-stream")) await core.call("chat.events",{sessionId:i.pathParams!.sessionId!,afterSeq:0,limit:1});
      const body=await core.call<Record<string,unknown>>(`chat.${method}`,params);
      audit.emit("chat.call",i.principal!.id,`chat:${i.pathParams?.sessionId ?? "new"}`,{operation:method,outcome:"ok"});
      return {body,...(name==="submit" && i.headers?.accept?.includes("text/event-stream")?{chatStream:{sessionId:i.pathParams!.sessionId!,afterSeq:0,turnId:body.turnId as string}}:{})};
    }catch(e){audit.emit("chat.call",i.principal!.id,"chat",{operation:method,outcome:"denied"});throw fromCoreError(e);}
  }]));
}
