// Preserve the page's session-shaped contract while the production adapter uses authenticated chat REST.
import { getApi } from "../../api/shared.ts";
import { HttpApi, type Api, type RpcMethods, type RpcOptions } from "../../api/client.ts";
import { isApiError, RpcError } from "../../api/errors.ts";
const adapted = new WeakMap<Api,Api>();
export function directChatApi(base: Api): Api {
  const rpc: Api["rpc"] = async <M extends string>(method:M,params?:RpcMethods[M]["params"],opts:RpcOptions={}) => {
    const p=params as Record<string,unknown> ?? {},id=encodeURIComponent(String(p.sessionId ?? "")),options=opts.signal?{signal:opts.signal}:undefined;
    const query=(input:Record<string,unknown>)=>{const q=new URLSearchParams();for(const [key,value] of Object.entries(input))if(value!==undefined)q.set(key,String(value));return q.size?`?${q}`:"";};
    try {
      let answer:unknown;
      switch(method){
        case "session.create": {const {kind:_kind,...body}=p;answer=await base.post("/api/v1/chats",body,options);break;}
        case "session.list":answer=await base.get("/api/v1/chats"+query({agent:p.agentId,state:p.archived,q:p.search,limit:p.limit}),options);break;
        case "session.resume": {answer=await base.get(`/api/v1/chats/${id}`+query({limit:p.limit}),options);if((answer as {session?:{archivedAt?:number|null}}).session?.archivedAt!=null)throw new RpcError(-32000,"archived",undefined,"E_CONFLICT","archived");break;}
        case "session.submit": {const {sessionId:_id,...body}=p;answer=await base.post(`/api/v1/chats/${id}/messages`,body,options);break;}
        case "session.events":answer=await base.get(`/api/v1/chats/${id}/events`+query({afterSeq:p.afterSeq,limit:p.limit}),options);break;
        case "session.cancel":answer=await base.post(`/api/v1/chats/${id}/cancel`,{},options);break;
        default:return base.rpc(method,params,opts);
      }
      return answer as RpcMethods[M]["result"];
    }catch(e){
      if(isApiError(e)&&(!("reason" in e)||e.reason!=="route")&&"errorCode" in e&&e.errorCode&&!["E_DENIED","E_UNAUTHORIZED","E_CORE_UNAVAILABLE","E_NOT_AVAILABLE"].includes(e.errorCode)&&e.kind!=="rpc-error")throw new RpcError(-32000,e.message,undefined,e.errorCode,e.reason);
      throw e;
    }
  };
  return {rpc,get:base.get.bind(base),post:base.post.bind(base),patch:base.patch.bind(base),put:base.put.bind(base),delete:base.delete.bind(base),events:base.events.bind(base)};
}
export function getChatApi():Api {
  const base=getApi();
  // Injected component mocks keep their narrow session port; browser and production use HttpApi.
  if(!(base instanceof HttpApi))return base;
  let result=adapted.get(base);if(!result){result=directChatApi(base);adapted.set(base,result);}return result;
}
