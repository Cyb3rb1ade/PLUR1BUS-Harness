import { denyEntriesFor, redactSecrets } from "./denylist.ts";
import { HostFailure, requireInt, requireString } from "./errors.ts";
import { runCaptured } from "./exec.ts";
import { asObject, baseName, HARD_MAX_OUTPUT_BYTES, type HostContext, type HostTool } from "./types.ts";

export interface ProcRow {
  pid: number;
  ppid: number;
  name: string;
  user: string;
  cpu: number;
  mem: number;
  command: string;
}

function processName(command: string, fallback: string): string {
  const token = command.trim().split(/\s+/)[0] ?? fallback;
  const app = token.replace(/\\/g, "/").match(/\/([^/]+)\.app\//);
  if (app) return app[1]!;
  return baseName(token).replace(/\.exe$/i, "") || fallback;
}

function parsePs(text: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(.*)$/);
    if (!m) continue;
    const command = m[6]!.trimEnd();
    rows.push({
      pid: Number(m[1]), ppid: Number(m[2]), user: m[3]!, cpu: Number(m[4]), mem: Number(m[5]),
      command, name: processName(command, m[1]!),
    });
  }
  return rows;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  for (const line of text.split(/\r?\n/).filter((l) => l.length > 0)) {
    const row: string[] = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i]!;
      if (inQ) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; }
        else if (ch === '"') inQ = false;
        else cur += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === ",") { row.push(cur); cur = ""; }
      else cur += ch;
    }
    row.push(cur);
    rows.push(row);
  }
  return rows;
}

function parseTasklist(text: string): ProcRow[] {
  const table = parseCsv(text);
  const header = table[0]?.map((h) => h.trim().toLowerCase()) ?? [];
  const idx = (n: string) => header.findIndex((h) => h === n);
  const iName = idx("image name"), iPid = idx("pid"), iUser = idx("user name");
  const iMem = idx("mem usage"), iCpu = idx("cpu time");
  const rows: ProcRow[] = [];
  for (const r of table.slice(1)) {
    const pid = Number((r[iPid] ?? "").replace(/[^\d]/g, ""));
    if (!Number.isInteger(pid)) continue;
    const memK = Number((r[iMem] ?? "0").replace(/[^\d]/g, ""));
    rows.push({
      pid, ppid: -1, name: processName(r[iName] ?? String(pid), String(pid)),
      user: r[iUser] ?? "", cpu: 0, mem: Number.isFinite(memK) ? memK / 1024 : 0,
      command: r[iName] ?? "",
    });
    void iCpu;
  }
  return rows;
}

function parseWmicProcess(text: string): Map<number, number> {
  const table = parseCsv(text);
  const header = table[0]?.map((h) => h.trim().toLowerCase()) ?? [];
  const iPid = header.findIndex((h) => h === "processid" || h === "pid");
  const iPpid = header.findIndex((h) => h === "parentprocessid");
  const map = new Map<number, number>();
  if (iPid < 0 || iPpid < 0) return map;
  for (const r of table.slice(1)) {
    const pid = Number(r[iPid]); const ppid = Number(r[iPpid]);
    if (Number.isInteger(pid) && Number.isInteger(ppid)) map.set(pid, ppid);
  }
  return map;
}

async function listRaw(ctx: HostContext): Promise<ProcRow[]> {
  const maxOutputBytes = Math.max(ctx.maxOutputBytes, HARD_MAX_OUTPUT_BYTES);
  if (ctx.platform === "win32") {
    const tl = await runCaptured(ctx, { program: "tasklist", args: ["/FO", "CSV", "/V"], maxOutputBytes });
    const rows = parseTasklist(tl.stdout);
    try {
      const w = await runCaptured(ctx, {
        program: "wmic",
        args: ["process", "get", "Name,ParentProcessId,ProcessId", "/FORMAT:csv"],
        maxOutputBytes,
      });
      const pp = parseWmicProcess(w.stdout);
      for (const r of rows) {
        const p = pp.get(r.pid);
        if (p !== undefined) r.ppid = p;
      }
    } catch { /* parent map is best-effort */ }
    return rows;
  }
  const ps = await runCaptured(ctx, {
    program: "ps",
    args: ["-axo", "pid=,ppid=,user=,pcpu=,pmem=,command="],
    maxOutputBytes,
  });
  if (ps.exitCode !== 0 && parsePs(ps.stdout).length === 0) {
    throw new HostFailure("not_found", "process list is not available");
  }
  return parsePs(ps.stdout);
}

function redactRow(row: ProcRow, ctx: HostContext): ProcRow {
  const deny = denyEntriesFor(ctx.homedir, ctx.env, ctx.platform);
  const command = redactSecrets(row.command, deny);
  return { ...row, command, name: row.name };
}

function userOf(raw: string): string {
  const n = raw.replace(/\\/g, "/");
  const i = n.lastIndexOf("/");
  return (i >= 0 ? n.slice(i + 1) : raw).toLowerCase();
}

function descendants(root: number, rows: ProcRow[]): Set<number> {
  const byParent = new Map<number, number[]>();
  for (const r of rows) {
    const list = byParent.get(r.ppid) ?? [];
    list.push(r.pid);
    byParent.set(r.ppid, list);
  }
  const out = new Set<number>();
  const stack = [root];
  while (stack.length) {
    const p = stack.pop()!;
    if (out.has(p)) continue;
    out.add(p);
    for (const c of byParent.get(p) ?? []) stack.push(c);
  }
  return out;
}

function ancestors(pid: number, rows: ProcRow[]): Set<number> {
  const byPid = new Map(rows.map((r) => [r.pid, r.ppid]));
  const out = new Set<number>();
  let cur: number | undefined = pid;
  for (let i = 0; i < 64 && cur !== undefined; i += 1) {
    const p = byPid.get(cur);
    if (p === undefined || p === cur || out.has(p)) break;
    out.add(p);
    cur = p;
  }
  return out;
}

async function listPublic(ctx: HostContext): Promise<{ processes: Array<Omit<ProcRow, "ppid"> & { ppid?: number }> }> {
  const rows = await listRaw(ctx);
  return {
    processes: rows.map((r) => {
      const x = redactRow(r, ctx);
      return { pid: x.pid, name: x.name, user: x.user, cpu: x.cpu, mem: x.mem, command: x.command };
    }),
  };
}

export const procListTool: HostTool = {
  name: "proc.list", capability: "sys.read", riskClass: "low",
  description: "List processes (pid, name, user, cpu, mem). Secret-shaped arguments and credential paths are redacted.",
  schema: {
    input: { type: "object", additionalProperties: false, properties: {} },
    output: { type: "object", required: ["processes"], properties: { processes: { type: "array" } } },
  },
  run: async (_input, ctx) => listPublic(ctx),
};

export const procInfoTool: HostTool = {
  name: "proc.info", capability: "sys.read", riskClass: "low",
  description: "Inspect one process by pid.",
  schema: {
    input: { type: "object", additionalProperties: false, required: ["pid"], properties: { pid: { type: "integer", minimum: 1 } } },
    output: { type: "object", required: ["pid", "name", "user"], properties: { pid: { type: "integer" }, name: { type: "string" }, user: { type: "string" } } },
  },
  async run(input, ctx) {
    const pid = requireInt(asObject(input).pid, "pid");
    const rows = await listRaw(ctx);
    const row = rows.find((r) => r.pid === pid);
    if (!row) throw new HostFailure("not_found", `process ${pid} was not found`);
    return redactRow(row, ctx);
  },
};

function parseSignal(v: unknown): { posix: string; force: boolean } {
  if (v === undefined) return { posix: "TERM", force: false };
  if (typeof v === "number" && Number.isInteger(v) && v > 0 && v < 32) {
    return { posix: String(v), force: v === 9 };
  }
  const s = requireString(v, "signal", 1, 16).replace(/^SIG/i, "").toUpperCase();
  if (!/^(TERM|KILL|INT|HUP|USR1|USR2|QUIT|[1-9][0-9]?)$/.test(s)) throw new HostFailure("invalid_input", "unsupported signal");
  return { posix: s, force: s === "KILL" || s === "9" };
}

export const procKillTool: HostTool = {
  name: "proc.kill", capability: "proc.signal", riskClass: "medium",
  description: "Signal a process. Refuses pid 1, the harness process tree, and other users' processes.",
  schema: {
    input: {
      type: "object", additionalProperties: false, required: ["pid"],
      properties: { pid: { type: "integer", minimum: 1 }, signal: { type: "string" } },
    },
    output: { type: "object", required: ["pid"], properties: { pid: { type: "integer" }, signal: { type: "string" } } },
  },
  async run(input, ctx) {
    const o = asObject(input);
    const pid = requireInt(o.pid, "pid");
    const sig = parseSignal(o.signal);
    if (pid === 1) throw new HostFailure("permission_denied", "pid 1 cannot be signalled");
    const rows = await listRaw(ctx);
    if (pid === ctx.pid || descendants(ctx.pid, rows).has(pid) || ancestors(ctx.pid, rows).has(pid)) {
      throw new HostFailure("permission_denied", "the harness process tree cannot be signalled");
    }
    const row = rows.find((r) => r.pid === pid);
    if (!row) throw new HostFailure("not_found", `process ${pid} was not found`);
    if (userOf(row.user) !== userOf(ctx.user) && ctx.uid !== 0) {
      throw new HostFailure("permission_denied", "cannot signal another user's process");
    }
    if (ctx.platform === "win32") {
      const args = sig.force ? ["/PID", String(pid), "/F"] : ["/PID", String(pid)];
      const r = await runCaptured(ctx, { program: "taskkill", args });
      if (r.exitCode !== 0) throw new HostFailure("permission_denied", "taskkill refused the process");
    } else {
      const r = await runCaptured(ctx, { program: "kill", args: [`-${sig.posix}`, String(pid)] });
      if (r.exitCode !== 0) throw new HostFailure("permission_denied", "kill refused the process");
    }
    return { pid, signal: sig.posix };
  },
};

export const procWaitTool: HostTool = {
  name: "proc.wait", capability: "sys.read", riskClass: "low",
  description: "Wait until a process exits or the timeout elapses.",
  schema: {
    input: {
      type: "object", additionalProperties: false, required: ["pid"],
      properties: { pid: { type: "integer", minimum: 1 }, timeoutMs: { type: "integer", minimum: 1 } },
    },
    output: { type: "object", required: ["pid", "exited"], properties: { pid: { type: "integer" }, exited: { type: "boolean" } } },
  },
  async run(input, ctx) {
    const o = asObject(input);
    const pid = requireInt(o.pid, "pid");
    const timeoutMs = o.timeoutMs === undefined ? ctx.timeoutMs : requireInt(o.timeoutMs, "timeoutMs", 1, 300_000);
    const deadline = ctx.clock.now() + timeoutMs;
    const interval = Math.min(50, timeoutMs);
    while (ctx.clock.now() <= deadline) {
      if (ctx.signal?.aborted) throw new HostFailure("aborted", "the call was aborted");
      const rows = await listRaw(ctx);
      if (!rows.some((r) => r.pid === pid)) return { pid, exited: true };
      const left = deadline - ctx.clock.now();
      if (left <= 0) break;
      try { await ctx.clock.sleep(Math.min(interval, left), ctx.signal); }
      catch { throw new HostFailure("aborted", "the call was aborted"); }
    }
    throw new HostFailure("timeout", `process ${pid} is still running`);
  },
};
