/** CLI-1 human coding RPC. Principal, surface and task scope come from this connection, never message text. */
import type { CodeSessionCheckParams, CodeSessionDiffParams, CodeSessionModeParams, CodeSessionOpenParams } from "@plur1bus/rpc-schema";
import type { CodingActions } from "../coding/actions.ts";
import type { CodingSessions } from "../coding/sessions.ts";
import { authenticatedPrincipal } from "../rbac/guard.ts";
import { RpcError } from "./errors.ts";
import { mapSessionError } from "../session/methods.ts";
import { surfaceError } from "./surface-errors.ts";
import type { CallContext, Handler } from "./server.ts";

/** Thin adapters; the shared services also serve ACP without another writer or protocol. */
export function buildCodeSurface(d: {
  coding: CodingSessions;
  actions: CodingActions;
  surfaceOf(ctx: CallContext): 0 | 1 | 2 | 3 | Promise<0 | 1 | 2 | 3>;
  openPermissions(): Promise<unknown>;
}): Record<string, Handler> {
  const wrap =
    (action: Handler): Handler =>
    async (p, ctx) => {
      if (authenticatedPrincipal(ctx).kind !== "person")
        throw new RpcError("E_DENIED", "coding commands require a person");
      try {
        await d.openPermissions();
        return await action(p, ctx);
      } catch (error) {
        try {
          return mapSessionError(error);
        } catch (mapped) {
          return surfaceError(mapped);
        }
      }
    };
  return {
    "code.session.mode": wrap(async (p: CodeSessionModeParams, ctx) =>
      d.coding.setMode(p, authenticatedPrincipal(ctx), {
        connectionId: ctx.connectionId,
        surface: await d.surfaceOf(ctx),
        signal: ctx.signal,
      }),
    ),
    "code.session.open": wrap(async (p: CodeSessionOpenParams, ctx) =>
      d.coding.open(p, authenticatedPrincipal(ctx), {
        connectionId: ctx.connectionId,
        surface: await d.surfaceOf(ctx),
        signal: ctx.signal,
      }),
    ),
    "code.session.diff": wrap((p: CodeSessionDiffParams, ctx) =>
      d.actions.diff(p, authenticatedPrincipal(ctx), d.coding.taskId(ctx.connectionId, p.sessionId)),
    ),
    "code.session.check": wrap((p: CodeSessionCheckParams, ctx) =>
      d.actions.check(p, authenticatedPrincipal(ctx), ctx.signal, d.coding.taskId(ctx.connectionId, p.sessionId)),
    ),
  };
}
