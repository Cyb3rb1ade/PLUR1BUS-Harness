import { authenticatedPrincipal, type PrincipalResolver } from "../rbac/guard.ts";
import { RpcError } from "../rpc/errors.ts";
import type { Handler, CallContext } from "../rpc/server.ts";
import type { Principal } from "../rbac/types.ts";
import { UserJobs, type UserJobInput } from "./index.ts";
/** Existing engine/system methods retain their behavior; user paths independently require a resolved person. */
export function attachUserJobMethods(legacy: Record<string, Handler>, jobs: UserJobs, resolve: PrincipalResolver): Record<string, Handler> {
  const who = async (ctx: CallContext, method: string, p: unknown): Promise<Principal> => {
    const person = await resolve(ctx, method, p);
    if (!person) {
      throw new RpcError("E_UNAUTHORIZED", "authentication required");
    }
    if (person.kind !== "person") {
      throw new RpcError("E_DENIED", "user jobs are human-only");
    }
    return person;
  };
  return { ...legacy,
    "jobs.create": async (p, ctx) => ({ job: jobs.create(p as UserJobInput, authenticatedPrincipal(ctx)) }),
    "jobs.update": async (p, ctx) => ({ job: jobs.update(p as {
        id: string;
      } & Partial<UserJobInput>, authenticatedPrincipal(ctx)) }),
    "jobs.delete": async (p: any, ctx) => jobs.delete(p.id, p.confirm, authenticatedPrincipal(ctx)),
    "jobs.list": async (p: any = {}, ctx) => {
      if (p.kind === "user") {
        const person = await who(ctx, "jobs.list", p);
        return { jobs: jobs.list(person), manageableAgents: jobs.targets(person) };
      }
      const old = await legacy["jobs.list"]!(p, ctx) as {
        jobs: unknown[];
      };
      if (p.kind !== "all") {
        return old;
      }
      const person = await resolve(ctx, "jobs.list", p);
      return { ...old, jobs: [...old.jobs, ...(person?.kind === "person" ? jobs.list(person) : [])], ...(person?.kind === "person" ? {manageableAgents:jobs.targets(person)} : {}) };
    },
    "jobs.history": async (p: any = {}, ctx) => {
      if (p.kind === "user" || p.job?.startsWith("user:")) {
        return { runs: jobs.history(p.job, await who(ctx, "jobs.history", p), p.limit).filter(r => p.since === undefined || r.startedAt >= p.since).filter(r => p.agentId === undefined || r.agentId === p.agentId) };
      }
      const old = await legacy["jobs.history"]!(p, ctx) as {
        runs: unknown[];
      };
      if (p.kind !== "all") {
        return old;
      }
      const person = await who(ctx, "jobs.history", p);
      return { runs: [...old.runs, ...jobs.history(undefined, person, p.limit).filter(r => p.since === undefined || r.startedAt >= p.since)] };
    },
    "jobs.run": async (p: any, ctx) => {
      if (!p.job?.startsWith("user:")) {
        return legacy["jobs.run"]!(p, ctx);
      }
      if (p.dryRun || p.args !== undefined) {
        throw new RpcError("E_INVALID_PARAMS", "user jobs do not accept dryRun or args");
      }
      const principal = await who(ctx, "jobs.run", p);
      const job = jobs.get(p.job);
      if (p.agentId !== undefined && p.agentId !== job.agentId) {
        throw new RpcError("E_INVALID_PARAMS", "agentId does not match the job");
      }
      return jobs.run(p.job, principal);
    },
  };
}
