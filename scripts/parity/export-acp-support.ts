// Runner and building blocks of the ACP exporters (see export-acp.ts).
import { mock } from "node:test";
import { PassThrough, Writable } from "node:stream";
import { CoreSessionBackend, type AcpBackend, type AcpTurnUpdate, type RpcCaller } from "../../packages/core/src/acp/backend.ts";
import { AcpFailure, type AcpFailureReason } from "../../packages/core/src/acp/failure.ts";
import type { AcpPermissionAsk, AcpPermissionHandler } from "../../packages/core/src/acp/permissions.ts";
import { AcpServer, type LogFields } from "../../packages/core/src/acp/server.ts";
import { installScriptedRandom, scriptedUuid } from "./k3b-support.ts";

const named = (name: string) => Object.assign(new Error("script"), { name });
const toError = (it: any): unknown => it.fail !== undefined ? new AcpFailure(it.fail as AcpFailureReason)
  : it.error !== undefined ? named(it.error) : "errorAnon" in it ? "a thrown string" : undefined;

const askOf = (v: any): AcpPermissionAsk => ({ toolCall: v.toolCall, options: (v.options ?? []).map((o: any) => ({ optionId: o.optionId, ...(o.name !== undefined ? { name: o.name } : {}), kind: o.kind })) });
const shown = (o: any): string => (o.outcome === "selected" ? `selected:${o.optionId}` : "cancelled");

/** The scripted backend of the `server` scenarios. */
function scriptedBackend(script: any, t: string[], gate: (n: string) => Promise<void>, release: (n: string) => void): AcpBackend {
  const idx: Record<string, number> = {};
  const take = (k: string): any => (script[k] ?? [])[(idx[k] = (idx[k] ?? -1) + 1)];
  const b: any = {
    ...(script.features ? { features: script.features } : {}),
    async createSession(input?: { cwd: string }) {
      t.push(`BACKEND createSession ${input?.cwd}`);
      const it = take("create"); if (!it) throw named("ScriptExhausted");
      const e = toError(it); if (e !== undefined) throw e;
      return { sessionId: it.sessionId ?? "", ...(it.modeJson !== undefined ? { mode: JSON.parse(it.modeJson) } : {}) };
    },
    async prompt(a: { sessionId: string; text: string }, onUpdate: (u: AcpTurnUpdate) => void, perm?: AcpPermissionHandler) {
      t.push(`BACKEND prompt ${a.sessionId} ${a.text}`);
      const ops = take("prompts"); if (!ops) throw named("ScriptExhausted");
      for (const op of ops) {
        if (op.text !== undefined) onUpdate({ type: "text", text: op.text });
        else if (op.toolCall) onUpdate({ type: "tool.call", id: op.toolCall.id, name: op.toolCall.name, ...(op.toolCall.argsJson !== undefined ? { args: JSON.parse(op.toolCall.argsJson) } : {}) });
        else if (op.toolResult) onUpdate({ type: "tool.result", id: op.toolResult.id, output: op.toolResult.output });
        else if (op.notice) onUpdate({ type: "notice", reason: op.notice.reason, text: op.notice.text });
        else if (op.permission) { const o = await perm!(askOf(JSON.parse(op.permission.askJson))); t.push(`BACKEND permission ${op.permission.tag} ${shown(o)}`); }
        else if (op.spawnPermission) { void perm!(askOf(JSON.parse(op.spawnPermission.askJson))).then((o) => { t.push(`BACKEND permission ${op.spawnPermission.tag} ${shown(o)}`); }); }
        else if (op.gate !== undefined) await gate(op.gate);
        else if (op.awaitCancel) await gate(`cancel:${a.sessionId}`);
        else if (op.yield !== undefined) { for (let i = 0; i < op.yield; i++) await Promise.resolve(); }
        else if (op.return !== undefined) return { state: op.return, ...(op.error !== undefined ? { error: op.error } : {}) };
        else if (op.throw !== undefined) throw named(op.throw);
        else if (op.throwAnon) throw "a thrown string";
      }
      return { state: "completed" };
    },
    async cancel(sid: string) {
      t.push(`BACKEND cancel ${sid}`); release(`cancel:${sid}`);
      if (script.cancelError) throw new Error("script");
    },
  };
  if (script.hasSetMode !== false) {
    b.setMode = async (sid: string, mode: string) => {
      t.push(`BACKEND setMode ${sid} ${mode}`);
      const it = take("mode"); if (!it) throw named("ScriptExhausted");
      const e = toError(it); if (e !== undefined) throw e;
      return { mode: JSON.parse(it.modeJson), changed: it.changed === true };
    };
  }
  if (script.hasDeliver !== false) {
    b.deliver = async (i: { sessionId: string; text: string; delivery: string }) => {
      t.push(`BACKEND deliver ${i.sessionId} ${i.delivery} ${i.text}`);
      const it = take("deliver"); if (!it) throw named("ScriptExhausted");
      const e = toError(it); if (e !== undefined) throw e;
      return it.resultJson !== undefined ? JSON.parse(it.resultJson) : undefined;
    };
  }
  return b as AcpBackend;
}

/** The scripted Core of the `core` scenarios. */
function scriptedRpc(script: any, t: string[], gate: (n: string) => Promise<void>): RpcCaller {
  const idx: Record<string, number> = {};
  return {
    hello: { capabilities: { methods: Object.fromEntries((script.methods ?? []).map((m: string) => [m, true])) } },
    async call(method: string, params?: object) {
      t.push(`RPC ${method} ${JSON.stringify(params)}`);
      const list: any[] = script.calls?.[method] ?? [];
      const i = (idx[method] = (idx[method] ?? -1) + 1);
      const item = list[i] ?? (list.length && "repeat" in list[list.length - 1] ? list[list.length - 1] : undefined);
      if (!item) throw named("ScriptExhausted");
      if (item.gate !== undefined) await gate(item.gate);
      if (item.err) {
        if (item.err.name === undefined) throw { error: item.err.code };
        throw Object.assign(new Error("script"), { name: item.err.name, ...(item.err.code !== undefined ? { error: item.err.code } : {}) });
      }
      return (item.okJson !== undefined ? JSON.parse(item.okJson) : null) as never;
    },
  } as RpcCaller;
}

const settle = async () => { for (let i = 0; i < 60; i++) await new Promise<void>((r) => setImmediate(r)); };

export async function runScenario(sc: any): Promise<string[]> {
  const t: string[] = [];
  const gates = new Map<string, { p: Promise<void>; res: () => void }>();
  const gateOf = (n: string) => { let g = gates.get(n); if (!g) { let res!: () => void; const p = new Promise<void>((r) => (res = r)); g = { p, res }; gates.set(n, g); } return g; };
  const gate = (n: string) => gateOf(n).p;
  const release = (n: string) => gateOf(n).res();
  const rnd = installScriptedRandom();
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const input = new PassThrough();
    let buf = "";
    const output = new Writable({ write(chunk, _e, cb) { buf += (chunk as Buffer).toString("utf8"); let i: number; while ((i = buf.indexOf("\n")) >= 0) { t.push(`OUT ${buf.slice(0, i)}`); buf = buf.slice(i + 1); } cb(); } });
    const log = (e: string, f?: LogFields) => { t.push(`LOG ${JSON.stringify({ e, ...f })}`); };
    const so = sc.server ?? {};
    const language = so.language === "de" ? "de" : "en";
    const backend: AcpBackend = sc.rpc
      ? new CoreSessionBackend({ client: scriptedRpc(sc.rpc, t, gate), caller: { channel: "cli", accountId: "acc", userId: "u" }, agentId: sc.core?.agentId ?? "bernd",
        sleep: () => Promise.resolve(), ...(sc.core?.initialMode ? { initialMode: sc.core.initialMode } : {}), language })
      : scriptedBackend(sc.backend ?? {}, t, gate, release);
    const server = new AcpServer({ backend, input, output, log, language,
      ...(so.agentInfo ? { agentInfo: { name: so.agentInfo[0], title: so.agentInfo[1], version: so.agentInfo[2] } } : {}),
      ...(so.maxLineBytes ? { maxLineBytes: so.maxLineBytes } : {}) });
    let finished = false;
    const done = server.run().then(() => { finished = true; });
    void done;
    let inputGone = false;
    const events: any[] = sc.events ?? [];
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      t.push(`EVENT ${i}`);
      if (e.in !== undefined) input.write(Buffer.from(e.in, "utf8"));
      else if (e.hex !== undefined) input.write(Buffer.from(e.hex, "hex"));
      else if (e.repeat) input.write(Buffer.from(`${e.repeat.prefix ?? ""}${e.repeat.unit.repeat(e.repeat.count)}${e.repeat.suffix ?? ""}`, "utf8"));
      else if (e.nest) input.write(Buffer.from(`${e.nest.prefix}${"[".repeat(e.nest.depth)}${"]".repeat(e.nest.depth)}${e.nest.suffix}`, "utf8"));
      else if (e.release !== undefined) release(e.release);
      else if (e.advance !== undefined) mock.timers.tick(e.advance);
      else if (e.end) { input.end(); inputGone = true; }
      else if (e.close) { input.destroy(); inputGone = true; }
      else if (e.error) input.emit("error", new Error("script"));
      else if (e.outputClosed) output.destroy();
      await settle();
    }
    if (!inputGone) input.end();
    await settle(); await settle();
    if (!finished) t.push("HUNG");
    return t;
  } finally { mock.timers.reset(); rnd.restore(); }
}

// ---- scenario building blocks -----------------------------------------------------------------------------------------------------
export const line = (m: unknown): string => `${JSON.stringify(m)}\n`;
export const rq = (id: unknown, method: string, params?: unknown): string => line({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
export const nf = (method: string, params?: unknown): string => line({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) });
export const INIT = rq(1, "initialize", { protocolVersion: 1, clientCapabilities: {} });
export const uuids = (n: number): string[] => Array.from({ length: n }, (_, i) => scriptedUuid(i + 1));
export const ev = {
  in: (s: string) => ({ in: s }),
  hex: (h: string) => ({ hex: h }),
  rel: (g: string) => ({ release: g }),
  adv: (ms: number) => ({ advance: ms }),
  end: () => ({ end: true }),
  close: () => ({ close: true }),
  error: () => ({ error: true }),
  outClosed: () => ({ outputClosed: true }),
};
export const ins = (...lines: string[]) => lines.map(ev.in);
export const textPrompt = (id: unknown, sid: string, text: string) => rq(id, "session/prompt", { sessionId: sid, prompt: [{ type: "text", text }] });
export const NEW = (id: unknown, cwd = "/work") => rq(id, "session/new", { cwd, mcpServers: [] });
/** A backend that creates `s1`, `s2`, ... and finishes every prompt with the given ops. */
export const simple = (prompts: any[][] = [[{ text: "hi" }]], extra: any = {}) => ({ create: [{ sessionId: "s1" }, { sessionId: "s2" }, { sessionId: "s3" }], prompts, ...extra });

export type Scenario = Record<string, any> & { name: string };
export async function record(list: Scenario[]): Promise<Scenario[]> {
  const out: Scenario[] = [];
  const seen = new Set<string>();
  for (const sc of list) {
    if (seen.has(sc.name)) throw new Error(`duplicate scenario ${sc.name}`);
    seen.add(sc.name);
    out.push({ ...sc, transcript: await runScenario(sc) });
  }
  return out;
}

