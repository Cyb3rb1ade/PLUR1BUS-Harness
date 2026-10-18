import type { RouteSpec } from "./routes.ts";
import { WS_ACTION } from "./ws.ts";
export const WS_ROUTES: readonly RouteSpec[] = [
  {id:"ws.ticket",method:"POST",path:"/api/v1/ws-ticket",tag:"transport",summary:"Issue one-use reserved WebSocket ticket",auth:"session",authz:{action:WS_ACTION},csrf:true,rate:"stream",stability:"experimental",since:"1.0.0",successStatus:200,success:{description:"Session-bound upgrade proof; use only in WebSocket subprotocol",schema:{type:"object"}}},
  {id:"ws.reserved",method:"GET",path:"/ws",tag:"transport",summary:"Reserved WebSocket upgrade; no PTY application protocol",auth:"session",authz:{action:WS_ACTION},csrf:false,rate:"stream",stability:"experimental",since:"1.0.0",successStatus:426,success:{description:"WebSocket upgrade required",schema:{type:"object"}}},
];
