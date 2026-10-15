import type { ServerResponse } from "node:http";
import type { ApiPrincipal } from "@plur1bus/module-api";
import type { CoreRpc } from "./core-rpc.ts";
import { ApiError } from "./errors.ts";

/** Replays only the caller's selected chat/turn, then follows ordered events; credentials never enter the cursor. */
export async function streamChat(o:{ res:ServerResponse; core:CoreRpc; principal:ApiPrincipal; sessionId:string; turnId:string; afterSeq:number; headers:Record<string,string>; current:()=>Promise<boolean> }) {
  if(!o.core.callAs)throw new ApiError(503,"E_NOT_AVAILABLE","chat stream unavailable",{reason:"chat-stream-unavailable"});
  const {res}=o;let ended=false;res.once("close",()=>{ended=true;});
  let cursor=o.afterSeq;
  res.writeHead(200,{...o.headers,"content-type":"text/event-stream; charset=utf-8","cache-control":"no-store","x-accel-buffering":"no"});res.flushHeaders();
  while(!ended) {
    if(!await o.current()){res.end();return;}
    let result: {events:{seq:number;turnId:string|null;type:string;data:unknown}[];running:boolean};
    try { result=await o.core.callAs<{events:{seq:number;turnId:string|null;type:string;data:unknown}[];running:boolean}>("chat.events",{sessionId:o.sessionId,afterSeq:cursor,limit:100},o.principal,"core"); } catch { res.end();return; }
    for(const event of result.events){cursor=event.seq;if(event.turnId!==o.turnId)continue;const wire=`id: ${o.sessionId}:${event.seq}\nevent: session.event\ndata: ${JSON.stringify({event:{...event,sessionId:o.sessionId}})}\n\n`;if(Buffer.byteLength(wire)>256*1024||res.writableLength>1024*1024){res.end();return;}res.write(wire);if(["turn.completed","turn.failed"].includes(event.type)){res.end();return;}}
    if(!result.running && result.events.length<100){res.end();return;}
    if(!ended)await new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);res.off("close",done);resolve();};const timer=setTimeout(done,50);res.once("close",done);});
  }
}
