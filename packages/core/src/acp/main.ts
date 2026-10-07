// The ACP server process: connect to the running core as a peer client, then serve ACP on stdin/stdout until stdin ends.
// Separate from `acp-bin.ts` so a test can drive `runAcpMain` with its own streams.
import { parseArgs } from "node:util";
import { connect, readRecordedPid, readRunToken, type CoreClient } from "@plur1bus/module-api";
import { coreAddress, layout, resolveHome } from "../paths.ts";
import { CoreSessionBackend } from "./backend.ts";
import { AcpServer, type LogFields } from "./server.ts";

export interface AcpMainIo { stdin: NodeJS.ReadableStream & NodeJS.ReadStream; stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream }

/** Exit code: 0 clean end of input, 1 the core could not be reached, 2 usage. */
export async function runAcpMain(argv: string[], io: AcpMainIo, connectCore: (home: string) => Promise<CoreClient> = defaultConnect): Promise<number> {
  const err = (event: string, fields: LogFields = {}) => { io.stderr.write(`${JSON.stringify({ level: "info", event: `acp.${event}`, ...fields })}\n`); };
  let values: { home?: string | undefined; agent?: string | undefined; account?: string | undefined; user?: string | undefined };
  try { ({ values } = parseArgs({ args: argv, options: { home: { type: "string" }, agent: { type: "string" }, account: { type: "string" }, user: { type: "string" } }, strict: true })); }
  catch (e) { io.stderr.write(`acp: ${e instanceof Error ? e.message : "bad arguments"}\n`); return 2; }
  if (!values.agent || !values.account || !values.user) { io.stderr.write("acp: --agent, --account and --user are required\n"); return 2; }
  const home = resolveHome(values.home ? { home: values.home } : {});
  let client: CoreClient;
  try { client = await connectCore(home); }
  catch (e) { io.stderr.write(`acp: cannot reach the core (${e instanceof Error ? e.name : "error"}); is it running? try: plur1bus daemon start\n`); return 1; }
  try {
    const backend = new CoreSessionBackend({ client, caller: { channel: "cli", accountId: values.account, userId: values.user }, agentId: values.agent });
    const server = new AcpServer({ backend, input: io.stdin as never, output: io.stdout as never, log: err });
    err("started");
    await server.run();
    return 0;
  } finally { await client.close().catch(() => {}); }
}

async function defaultConnect(home: string): Promise<CoreClient> {
  const l = layout(home);
  const pid = readRecordedPid(l.corePid);
  return connect({ address: coreAddress(home), token: readRunToken(home, l.coreToken), ...(pid === undefined ? {} : { expectedServerPid: pid }) });
}
