import { SCHEMA, validateParams, validateResult } from "@plur1bus/rpc-schema";
import type { CoreRpc } from "./core-rpc.ts";
import type { Handler, HandlerInput, RouteSpec } from "./routes.ts";
import type { AuditEmitter } from "./audit.ts";
import { ApiError, errors, fromCoreError } from "./errors.ts";

const defs=(SCHEMA as any).$defs;
/** RPC JSON Schema is the only result source. Inline local references for standalone OpenAPI validation. */
function inlineSchema(value:any,refs:readonly string[]=[]):any {
  if(Array.isArray(value))return value.map(v=>inlineSchema(v,refs));
  if(!value||typeof value!=="object")return value;
  if(value.$ref){const ref=value.$ref;if(typeof ref!=="string"||!ref.startsWith("#/$defs/")||refs.includes(ref))throw Error("unsupported chat schema reference");const target=ref.slice(2).split("/").reduce((v:any,key:string)=>v[key],SCHEMA);const {$ref:_,...rest}=value;return inlineSchema({...target,...rest},[...refs,ref]);}
  return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,inlineSchema(v,refs)]));
}
function rpcMethod(name:string){return name==="create-agent"?"create":name==="messages"?"get":name;}
function bodySchema(name:string) {
  const method=rpcMethod(name);
  const schema=JSON.parse(JSON.stringify(defs.methods[`chat.${method}`].params));
  delete schema.properties.sessionId;
  if(name==="create-agent")delete schema.properties.agentId;
  delete schema.properties.idempotencyKey;
  delete schema.properties.resumeAfterSeq;
  schema.required=schema.required.filter((key:string)=>Object.hasOwn(schema.properties,key));
  return inlineSchema(schema);
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
export const CHAT_ROUTES: readonly RouteSpec[] = routes.map(([name,method,path,scope]) => ({ id:`chats.${name}`,method,path,summary:`Own direct chat ${name}`,tag:"chats",auth:"any",authz:{action:`chat:${scope}`},csrf:method!=="GET",rate:method==="GET"?"read":"write",stability:"experimental",since:"1.0.0",...(method!=="GET"?{requestBody:bodySchema(name)}:{}),...(method==="GET"?{extra:{400:{description:"Unknown, duplicate or invalid chat query",schema:{$ref:"#/components/schemas/Error"}}}}:{}),successStatus:name==="create"||name==="create-agent"||name==="fork"?201:200,success:{description:"Principal-bound direct-chat result; incognito transcripts are volatile.",schema:inlineSchema(defs.methods[`chat.${rpcMethod(name)}`].result)} }));
function query(i: HandlerInput, fields: readonly string[]) {
  const result: Record<string, unknown>={};
  for(const [key,value] of i.query ?? []) {
    if(!fields.includes(key)||Object.hasOwn(result,key))throw errors.badRequest("query","unknown or duplicate chat query");
    result[key]=["limit","afterSeq","beforeSeq","before"].includes(key)?(/^[1-9][0-9]*$/.test(value)||value==="0"?Number(value):Number.NaN):value;
  }
  if (Object.hasOwn(result,"before")) { if(Object.hasOwn(result,"beforeSeq"))throw errors.badRequest("query","duplicate chat boundary");result.beforeSeq=result.before;delete result.before; }
  if (result.agent) { result.agentId=result.agent;delete result.agent; }
  if (result.q) { result.search=result.q;delete result.q; }
  if (result.state) { result.archived=result.state;delete result.state; }
  return result;
}
export function buildChatHandlers(core: CoreRpc, audit: AuditEmitter): Record<string, Handler> {
  return Object.fromEntries(routes.map(([name])=>[`chats.${name}`,async(i: HandlerInput)=>{
    const method=rpcMethod(name);
    if(i.body!==undefined){const allowed=bodySchema(name).properties;if(!i.body||typeof i.body!=="object"||Array.isArray(i.body)||Object.keys(i.body).some(key=>!Object.hasOwn(allowed,key)))throw errors.badRequest("chat-body","unknown chat body field");}
    const params={...query(i,name==="list"?["agent","q","state","limit","cursor"]:name==="events"?["afterSeq","limit"]:name==="get"||name==="messages"?["limit","before","beforeSeq"]:["limit"]),...(i.body as object ?? {}),...i.pathParams};
    // History opens on its newest bounded window; chat.get retains its legacy forward order.
    if(name==="messages"&&!Object.hasOwn(params,"beforeSeq"))(params as Record<string,unknown>).beforeSeq=Number.MAX_SAFE_INTEGER;
    const key=i.headers?.["idempotency-key"];
    if(key !== undefined) {if(typeof key!=="string"||key.length<1||key.length>128||/[\u0000-\u001f\u007f]/.test(key))throw errors.badRequest("idempotency-key","invalid idempotency key");(params as Record<string,unknown>).idempotencyKey=key;}
    const stream=name==="submit"&&typeof i.headers?.accept==="string"&&i.headers.accept.includes("text/event-stream");
    const last=i.headers?.["last-event-id"];let afterSeq=0;
    if(last!==undefined){
      if(!stream||typeof last!=="string"||last.length>160||typeof key!=="string")throw errors.badRequest("last-event-id","resume requires SSE and the original idempotency key");
      const match=/^([^:\r\n]{1,128}):([1-9][0-9]{0,15})$/.exec(last);
      if(!match||match[1]!==i.pathParams?.sessionId||!Number.isSafeInteger(Number(match[2])))throw errors.badRequest("last-event-id","invalid chat resume event");
      afterSeq=Number(match[2]);(params as Record<string,unknown>).resumeAfterSeq=afterSeq;
    }
    if (!validateParams(`chat.${method}`,params).ok)throw errors.badRequest("chat-params","invalid chat parameters");
    try {
      if(stream) await core.call("chat.events",{sessionId:i.pathParams!.sessionId!,afterSeq,limit:1});
      const body=await core.call<Record<string,unknown>>(`chat.${method}`,params);
      if(!validateResult(`chat.${method}`,body).ok)throw new ApiError(502,"E_CORE_UNAVAILABLE","invalid chat result",{reason:"chat-result"});
      audit.emit("chat.call",i.principal!.id,`chat:${i.pathParams?.sessionId ?? "new"}`,{operation:method,outcome:"ok"});
      return {body,...(stream?{chatStream:{sessionId:i.pathParams!.sessionId!,afterSeq,turnId:body.turnId as string}}:{})};
    }catch(e){audit.emit("chat.call",i.principal!.id,"chat",{operation:method,outcome:"denied"});throw fromCoreError(e);}
  }]));
}
