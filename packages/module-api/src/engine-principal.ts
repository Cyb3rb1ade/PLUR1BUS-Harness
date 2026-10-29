import { timingSafeEqual } from "node:crypto";
import type { CallContext } from "./rpc-server.ts";
import { RpcError } from "./rpc-error.ts";

/** The engine authenticates with its own run/engine.token, never the local owner's core token. */
export interface EngineDelegation { clientId: "plur1bus-engine"; token: string }
const contexts = new WeakSet<CallContext>();

/** Called by the shared server only after authenticating the engine connection. */
export function bindEnginePrincipal(ctx: CallContext): void { contexts.add(ctx); }
/** A request cannot acquire this principal by adding fields to its JSON params or context. */
export function isEngineContext(ctx: CallContext): boolean { return contexts.has(ctx); }

/** Check the exact delegation shape and compare the independent credential in constant time. */
export function verifyEngineDelegation(value: unknown, token: string | undefined): void {
  const deny = (): never => { throw new RpcError("E_UNAUTHORIZED", "engine delegation refused", { reason: "engine-delegation" }); };
  if (!token || !/^[a-f0-9]{64}$/iu.test(token) || !value || typeof value !== "object" || Array.isArray(value)) return deny();
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(key => key !== "clientId" && key !== "token") || v.clientId !== "plur1bus-engine" || typeof v.token !== "string") return deny();
  const supplied = Buffer.from(v.token), expected = Buffer.from(token);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return deny();
}
