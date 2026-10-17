import { creationDigest } from "./saga.ts";
// A separate authenticated supervisor call supplies compare-and-set; ConfigWatch.set alone has no revision argument.
import { connect, RpcCallError, readRunToken, readRecordedPid, supervisorAddress } from "@plur1bus/module-api";
import { CONFIG_SCHEMA, type HarnessConfig } from "@plur1bus/config-schema";
import type { Layout } from "../paths.ts";
import { agentReferenceErrors } from "./create.ts";
import { RpcError } from "../rpc/errors.ts";
const unavailable = () => new RpcError("E_STORAGE", "agent config registration unavailable");
export async function registerAgentConfig(l: Layout, id: string, agent: HarnessConfig["agents"][string]): Promise<void> {
  // The id is spliced into a dotted config key: anything but a plain agent name could address another subtree.
  if (typeof id !== "string" || !new RegExp(CONFIG_SCHEMA.properties.agents.propertyNames.pattern).test(id)) throw new RpcError("E_INVALID_PARAMS", "invalid agent name", { detail: "name" });
  // Raw connection/IO errors carry local paths and socket addresses; they never leave this function.
  let client: Awaited<ReturnType<typeof connect>>;
  try {
    const pid = readRecordedPid(l.supervisorPid);
    client = await connect({ address: supervisorAddress(l.home), token: readRunToken(l.home, l.supervisorToken), endpoint: "supervisor", connectTimeoutMs: 1000, callTimeoutMs: 120000, ...(pid === undefined ? {} : { expectedServerPid: pid }) });
  } catch { throw unavailable(); }
  try {
    const current = await client.call<{ value: HarnessConfig; revision: string }>("config.get", {});
    if (Object.hasOwn(current.value.agents, id)) throw new RpcError("E_AGENT_EXISTS", "agent already exists");
    const errors = agentReferenceErrors(current.value, agent);
    if (errors.length) throw new RpcError("E_INVALID_PARAMS", errors[0]!.message, { detail: errors[0]!.field });
    await client.call("config.set", { changes: [{ key: `agents.${id}`, value: agent }], ifRevision: current.revision });
  } catch (e) {
    if (e instanceof RpcError) throw e;
    if (e instanceof RpcCallError) throw new RpcError(e.error, "agent config registration refused", { ...(e.reason ? { reason: e.reason } : {}) });
    throw unavailable();
  } finally { await client.close().catch(() => {}); }
}

/** Compensation removes only this reserved agent, using the Config owner's revision. */
export async function unregisterAgentConfig(l: Layout, id: string, expected: HarnessConfig["agents"][string]): Promise<void> {
  if (!new RegExp(CONFIG_SCHEMA.properties.agents.propertyNames.pattern).test(id)) throw new RpcError("E_INVALID_PARAMS", "invalid agent name");
  let client: Awaited<ReturnType<typeof connect>>;
  try { client = await connect({ address: supervisorAddress(l.home), token: readRunToken(l.home, l.supervisorToken), endpoint: "supervisor", connectTimeoutMs: 1000, callTimeoutMs: 120000 }); }
  catch { throw unavailable(); }
  try {
    const current = await client.call<{ value: HarnessConfig; revision: string }>("config.get", {});
    if (current.value.agents[id] && creationDigest(current.value.agents[id]) !== creationDigest(expected)) throw new RpcError("E_CONFLICT", "agent config changed during provisioning");
    const agents = { ...current.value.agents }; delete agents[id];
    await client.call("config.set", { changes: [{ key: "agents", value: agents }], ifRevision: current.revision });
  } catch { throw unavailable(); } finally { await client.close().catch(() => {}); }
}
