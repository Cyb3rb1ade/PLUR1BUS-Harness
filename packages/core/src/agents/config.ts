// A separate authenticated supervisor call supplies compare-and-set; ConfigWatch.set alone has no revision argument.
import { connect, RpcCallError, readRunToken, readRecordedPid, supervisorAddress } from "@plur1bus/module-api";
import type { HarnessConfig } from "@plur1bus/config-schema";
import type { Layout } from "../paths.ts";
import { agentReferenceErrors } from "./create.ts";
import { RpcError } from "../rpc/errors.ts";
export async function registerAgentConfig(l: Layout, id: string, agent: HarnessConfig["agents"][string]): Promise<void> {
  const pid = readRecordedPid(l.supervisorPid);
  const client = await connect({ address: supervisorAddress(l.home), token: readRunToken(l.home, l.supervisorToken), endpoint: "supervisor", connectTimeoutMs: 1000, callTimeoutMs: 120000, ...(pid === undefined ? {} : { expectedServerPid: pid }) });
  try {
    const current = await client.call<{ value: HarnessConfig; revision: string }>("config.get", {});
    if (Object.hasOwn(current.value.agents, id)) throw new RpcError("E_AGENT_EXISTS", "agent already exists");
    const errors = agentReferenceErrors(current.value, agent);
    if (errors.length) throw new RpcError("E_INVALID_PARAMS", errors[0]!.message, { detail: errors[0]!.field });
    await client.call("config.set", { changes: [{ key: `agents.${id}`, value: agent }], ifRevision: current.revision });
  } catch (e) {
    if (e instanceof RpcCallError) throw new RpcError(e.error, "agent config registration refused", { ...(e.reason ? { reason: e.reason } : {}) });
    throw e;
  } finally { await client.close(); }
}
