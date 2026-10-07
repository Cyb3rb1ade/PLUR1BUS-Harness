import { which } from "./context.ts";
import { HostFailure, requireString } from "./errors.ts";
import { runCaptured } from "./exec.ts";
import { asObject, type HostContext, type HostTool } from "./types.ts";

export const MANAGERS = ["brew", "apt", "dnf", "pacman", "winget", "choco", "scoop"] as const;
export type Manager = (typeof MANAGERS)[number];

const BINS: Record<Manager, readonly string[]> = {
  brew: ["brew"],
  apt: ["apt-get", "apt"],
  dnf: ["dnf"],
  pacman: ["pacman"],
  winget: ["winget"],
  choco: ["choco"],
  scoop: ["scoop"],
};

async function detect(ctx: HostContext): Promise<Manager[]> {
  const found: Manager[] = [];
  for (const m of MANAGERS) {
    for (const bin of BINS[m]) {
      if (await which(ctx, bin)) { found.push(m); break; }
    }
  }
  return found;
}

async function pick(ctx: HostContext, requested?: string): Promise<{ manager: Manager; bin: string }> {
  const found = await detect(ctx);
  const manager = requested
    ? MANAGERS.find((m) => m === requested)
    : found[0];
  if (!manager) throw new HostFailure("not_found", requested ? `package manager ${requested} is not available` : "no package manager was found");
  if (requested && !found.includes(manager)) throw new HostFailure("not_found", `package manager ${manager} is not available`);
  let bin: string | null = null;
  for (const b of BINS[manager]) { bin = await which(ctx, b); if (bin) break; }
  if (!bin) throw new HostFailure("not_found", `package manager ${manager} is not available`);
  return { manager, bin: BINS[manager][0]! };
}

function parseLines(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith("="));
}

export const pkgDetectTool: HostTool = {
  name: "pkg.detect", capability: "sys.read", riskClass: "low",
  description: "Which of brew/apt/dnf/pacman/winget/choco/scoop are on PATH.",
  schema: {
    input: { type: "object", additionalProperties: false, properties: {} },
    output: { type: "object", required: ["managers"], properties: { managers: { type: "array", items: { type: "string" } } } },
  },
  async run(_input, ctx) { asObject(_input); return { managers: await detect(ctx) }; },
};

export const pkgSearchTool: HostTool = {
  name: "pkg.search", capability: "sys.read", riskClass: "low",
  description: "Search a detected package manager (read-only).",
  schema: {
    input: {
      type: "object", additionalProperties: false, required: ["query"],
      properties: { query: { type: "string" }, manager: { type: "string" } },
    },
    output: { type: "object", required: ["results"], properties: { results: { type: "array" } } },
  },
  async run(input, ctx) {
    const o = asObject(input);
    const query = requireString(o.query, "query", 1, 256);
    const { manager, bin } = await pick(ctx, typeof o.manager === "string" ? o.manager : undefined);
    const args =
      manager === "brew" ? ["search", query]
      : manager === "apt" ? ["search", query]
      : manager === "dnf" ? ["search", query]
      : manager === "pacman" ? ["-Ss", query]
      : manager === "winget" ? ["search", query]
      : manager === "choco" ? ["search", query, "--limit-output"]
      : ["search", query];
    const prog = manager === "apt" ? "apt-cache" : bin;
    const r = await runCaptured(ctx, { program: prog, args });
    const results = parseLines(r.stdout).map((line) => {
      const name = line.split(/\s+/)[0] ?? line;
      return { name, line };
    });
    return { manager, results };
  },
};

export const pkgListTool: HostTool = {
  name: "pkg.list-installed", capability: "sys.read", riskClass: "low",
  description: "List installed packages (read-only).",
  schema: {
    input: { type: "object", additionalProperties: false, properties: { manager: { type: "string" } } },
    output: { type: "object", required: ["packages"], properties: { packages: { type: "array" } } },
  },
  async run(input, ctx) {
    const o = asObject(input);
    const { manager, bin } = await pick(ctx, typeof o.manager === "string" ? o.manager : undefined);
    const spec =
      manager === "brew" ? { program: bin, args: ["list", "--versions"] }
      : manager === "apt" ? { program: "dpkg-query", args: ["-W", "-f=${Package}\\t${Version}\\n"] }
      : manager === "dnf" ? { program: bin, args: ["list", "installed"] }
      : manager === "pacman" ? { program: bin, args: ["-Q"] }
      : manager === "winget" ? { program: bin, args: ["list"] }
      : manager === "choco" ? { program: bin, args: ["list", "--local-only", "--limit-output"] }
      : { program: bin, args: ["list"] };
    const r = await runCaptured(ctx, spec);
    const packages = parseLines(r.stdout).map((line) => {
      const [name, version] = line.split(/[\s\t]+/);
      return { name: name ?? line, ...(version ? { version } : {}) };
    }).filter((p) => p.name !== "Package" && !/^===/.test(p.name));
    return { manager, packages };
  },
};

export const pkgInfoTool: HostTool = {
  name: "pkg.info", capability: "sys.read", riskClass: "low",
  description: "Show package metadata (read-only).",
  schema: {
    input: {
      type: "object", additionalProperties: false, required: ["name"],
      properties: { name: { type: "string" }, manager: { type: "string" } },
    },
    output: { type: "object", required: ["name"], properties: { name: { type: "string" }, detail: { type: "string" } } },
  },
  async run(input, ctx) {
    const o = asObject(input);
    const name = requireString(o.name, "name", 1, 256);
    const { manager, bin } = await pick(ctx, typeof o.manager === "string" ? o.manager : undefined);
    const spec =
      manager === "brew" ? { program: bin, args: ["info", name] }
      : manager === "apt" ? { program: "apt-cache", args: ["show", name] }
      : manager === "dnf" ? { program: bin, args: ["info", name] }
      : manager === "pacman" ? { program: bin, args: ["-Si", name] }
      : manager === "winget" ? { program: bin, args: ["show", name] }
      : manager === "choco" ? { program: bin, args: ["info", name] }
      : { program: bin, args: ["info", name] };
    const r = await runCaptured(ctx, spec);
    return { manager, name, detail: r.stdout.slice(0, 16_384) };
  },
};

function planOf(manager: Manager, action: "install" | "remove", name: string): { program: string; args: string[] } {
  if (action === "install") {
    if (manager === "pacman") return { program: "pacman", args: ["-S", name] };
    if (manager === "apt") return { program: "apt-get", args: ["install", name] };
    return { program: manager === "brew" ? "brew" : manager, args: ["install", name] };
  }
  if (manager === "pacman") return { program: "pacman", args: ["-R", name] };
  if (manager === "apt") return { program: "apt-get", args: ["remove", name] };
  if (manager === "brew") return { program: "brew", args: ["uninstall", name] };
  if (manager === "winget") return { program: "winget", args: ["uninstall", name] };
  return { program: manager, args: ["uninstall", name] };
}

function changePlan(action: "install" | "remove"): HostTool {
  return {
    name: action === "install" ? "pkg.install" : "pkg.remove",
    capability: "pkg.change", riskClass: "high",
    description: action === "install"
      ? "Return the exact install command and its risk; does not execute it (D109 follow-up)."
      : "Return the exact remove command and its risk; does not execute it (D109 follow-up).",
    schema: {
      input: {
        type: "object", additionalProperties: false, required: ["name"],
        properties: { name: { type: "string" }, manager: { type: "string" } },
      },
      output: { type: "object", required: ["plan"], properties: { plan: { type: "object" } } },
    },
    async run(input, ctx) {
      const o = asObject(input);
      const name = requireString(o.name, "name", 1, 256);
      const { manager } = await pick(ctx, typeof o.manager === "string" ? o.manager : undefined);
      const cmd = planOf(manager, action, name);
      return {
        plan: {
          manager, ...cmd, capability: "pkg.change", riskClass: "high",
          executed: false,
          note: "Execution is a D109 approval follow-up; this tool only returns the plan.",
        },
      };
    },
  };
}

export const pkgInstallTool = changePlan("install");
export const pkgRemoveTool = changePlan("remove");
