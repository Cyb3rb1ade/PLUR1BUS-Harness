import { it } from "node:test";
import net from "node:net";
import dgram from "node:dgram";
import dns from "node:dns";
import childProcess from "node:child_process";
import { createPromptBuilder, createPromptSession, createCacheTelemetry } from "../../src/prompt/index.ts";
import { corpusInput, memory, system, tools } from "../fixtures/prompt-corpus.ts";

it("prompt assembly, session transitions and telemetry perform zero network/spawn calls", (t) => {
  const forbidden = () => { throw new Error("prompt assembly must not perform network or spawn I/O"); };
  t.mock.method(net.Socket.prototype, "connect", forbidden);
  t.mock.method(dgram, "createSocket", forbidden);
  t.mock.method(dns, "lookup", forbidden);
  t.mock.method(dns.promises, "lookup", forbidden);
  t.mock.method(globalThis, "fetch", forbidden);
  for (const method of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"] as const) t.mock.method(childProcess, method, forbidden);
  const builder = createPromptBuilder({ now: () => 0 });
  const session = createPromptSession({ builder, agentId: "bernd", model: "claude-sonnet-5", sessionId: "offline", tools, system, memorySnapshot: memory });
  session.render();
  session.recall({ blocks: [{ name: "memories", text: "new fact", chars: 8, droppable: true }] });
  session.render();
  session.refreshMemorySnapshot(memory + "\nrefreshed fact");
  session.setModel("gpt-5.6");
  const prompt = session.render();
  createCacheTelemetry().record(prompt, { cache_read: 950, cache_creation: 0, input: 50 });
  builder.render(corpusInput(20));
});
