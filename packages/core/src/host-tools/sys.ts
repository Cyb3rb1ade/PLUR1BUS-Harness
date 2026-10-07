import { HostFailure } from "./errors.ts";
import { runCaptured } from "./exec.ts";
import { asObject, type HostContext, type HostTool } from "./types.ts";

export const sysInfoTool: HostTool = {
  name: "sys.info", capability: "sys.read", riskClass: "low",
  description: "Read-only host identity: OS, version, arch, CPU, RAM, uptime.",
  schema: {
    input: { type: "object", additionalProperties: false, properties: {} },
    output: {
      type: "object",
      required: ["os", "version", "arch", "cpu", "ramBytes", "uptimeSeconds"],
      properties: {
        os: { type: "string" }, version: { type: "string" }, arch: { type: "string" },
        cpu: { type: "object" }, ramBytes: { type: "integer" }, uptimeSeconds: { type: "number" },
      },
    },
  },
  async run(_input, ctx) {
    asObject(_input);
    const cpus = ctx.os.cpus();
    return {
      os: ctx.platform,
      version: ctx.os.release(),
      arch: ctx.os.arch(),
      type: ctx.os.type(),
      hostname: ctx.os.hostname(),
      cpu: { model: cpus[0]?.model ?? "unknown", count: cpus.length, speedMHz: cpus[0]?.speed ?? 0 },
      ramBytes: ctx.os.totalmem(),
      freeRamBytes: ctx.os.freemem(),
      uptimeSeconds: ctx.os.uptime(),
      loadavg: ctx.os.loadavg(),
    };
  },
};

function parseDf(text: string): Array<{ mount: string; totalBytes: number; freeBytes: number; fs: string }> {
  const out: Array<{ mount: string; totalBytes: number; freeBytes: number; fs: string }> = [];
  for (const line of text.split(/\r?\n/).slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) continue;
    const totalK = Number(parts[1]); const freeK = Number(parts[3]);
    if (!Number.isFinite(totalK) || totalK < 0) continue;
    const mount = parts.slice(5).join(" ");
    out.push({ fs: parts[0]!, mount, totalBytes: totalK * 1024, freeBytes: (Number.isFinite(freeK) ? freeK : 0) * 1024 });
  }
  return out;
}

function parseWmicDisk(text: string): Array<{ mount: string; totalBytes: number; freeBytes: number; fs: string }> {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out: Array<{ mount: string; totalBytes: number; freeBytes: number; fs: string }> = [];
  const header = lines[0]?.split(",") ?? [];
  const iCap = header.findIndex((h) => /caption/i.test(h));
  const iFree = header.findIndex((h) => /freespace/i.test(h));
  const iSize = header.findIndex((h) => /^size$/i.test(h));
  for (const line of lines.slice(1)) {
    const cols = line.split(",");
    const size = Number(cols[iSize]); const free = Number(cols[iFree]);
    if (!Number.isFinite(size) || size <= 0) continue;
    const cap = cols[iCap] ?? "?";
    out.push({ fs: cap, mount: cap, totalBytes: size, freeBytes: Number.isFinite(free) ? free : 0 });
  }
  return out;
}

export const sysDisksTool: HostTool = {
  name: "sys.disks", capability: "sys.read", riskClass: "low",
  description: "Mounted volumes with total and free bytes.",
  schema: {
    input: { type: "object", additionalProperties: false, properties: {} },
    output: { type: "object", required: ["disks"], properties: { disks: { type: "array" } } },
  },
  async run(_input, ctx) {
    asObject(_input);
    if (ctx.platform === "win32") {
      const r = await runCaptured(ctx, {
        program: "wmic", args: ["logicaldisk", "get", "Caption,FreeSpace,Size", "/FORMAT:csv"],
      });
      return { disks: parseWmicDisk(r.stdout) };
    }
    const r = await runCaptured(ctx, { program: "df", args: ["-kP"] });
    return { disks: parseDf(r.stdout) };
  },
};

export const sysNetworkTool: HostTool = {
  name: "sys.network", capability: "sys.read", riskClass: "low",
  description: "Network interfaces without MAC addresses or secrets.",
  schema: {
    input: { type: "object", additionalProperties: false, properties: {} },
    output: { type: "object", required: ["interfaces"], properties: { interfaces: { type: "array" } } },
  },
  async run(_input, ctx) {
    asObject(_input);
    const raw = ctx.os.networkInterfaces();
    const interfaces: Array<{ name: string; family: string; address: string; internal: boolean; cidr: string | null }> = [];
    for (const [name, addrs] of Object.entries(raw)) {
      for (const a of addrs ?? []) {
        interfaces.push({
          name, family: String(a.family), address: a.address, internal: a.internal, cidr: a.cidr,
        });
      }
    }
    return { interfaces };
  },
};

function parsePmset(text: string): { available: boolean; percent?: number; charging?: boolean } {
  const pct = text.match(/(\d+)\s*%/);
  if (!pct) return { available: false };
  const charging = /charging/i.test(text) && !/discharging/i.test(text) || /AC Power/i.test(text);
  return { available: true, percent: Number(pct[1]), charging };
}

export const sysBatteryTool: HostTool = {
  name: "sys.battery", capability: "sys.read", riskClass: "low",
  description: "Battery or power status when the hardware exposes it.",
  schema: {
    input: { type: "object", additionalProperties: false, properties: {} },
    output: { type: "object", required: ["available"], properties: { available: { type: "boolean" }, percent: { type: "number" } } },
  },
  async run(_input, ctx) {
    asObject(_input);
    if (ctx.platform === "darwin") {
      try {
        const r = await runCaptured(ctx, { program: "pmset", args: ["-g", "batt"] });
        return parsePmset(r.stdout);
      } catch (e) {
        if (e instanceof HostFailure && e.code === "not_found") return { available: false };
        throw e;
      }
    }
    if (ctx.platform === "linux") {
      try {
        const names = await ctx.fs.readdir("/sys/class/power_supply");
        const bat = names.find((n) => /^BAT/i.test(n));
        if (!bat) return { available: false };
        const base = `/sys/class/power_supply/${bat}`;
        const cap = Number((await ctx.fs.readFile(`${base}/capacity`)).trim());
        const status = (await ctx.fs.readFile(`${base}/status`)).trim();
        return { available: true, percent: cap, charging: /charg/i.test(status) && !/discharg/i.test(status) };
      } catch {
        return { available: false };
      }
    }
    try {
      const r = await runCaptured(ctx, {
        program: "wmic",
        args: ["path", "Win32_Battery", "get", "BatteryStatus,EstimatedChargeRemaining", "/FORMAT:csv"],
      });
      const lines = r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const header = lines[0]?.split(",") ?? [];
      const iSt = header.findIndex((h) => /batterystatus/i.test(h));
      const iPct = header.findIndex((h) => /estimatedchargeremaining/i.test(h));
      const row = lines[1]?.split(",");
      if (!row || iPct < 0) return { available: false };
      const percent = Number(row[iPct]);
      const st = Number(row[iSt]);
      if (!Number.isFinite(percent)) return { available: false };
      return { available: true, percent, charging: st >= 6 && st <= 9 };
    } catch {
      return { available: false };
    }
  },
};
