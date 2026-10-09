import { denyEntriesFor, denyHit } from "./denylist.ts";
import { which } from "./context.ts";
import { HostFailure, requireString } from "./errors.ts";
import { runCaptured } from "./exec.ts";
import { asObject, joinPath, type HostContext, type HostTool } from "./types.ts";

const URL_SCHEMES = new Set(["http:", "https:", "mailto:"]);

interface AppRow { name: string; path?: string; version?: string }

async function listDarwin(ctx: HostContext): Promise<AppRow[]> {
  const roots = ["/Applications", "/System/Applications"];
  const apps: AppRow[] = [];
  for (const root of roots) {
    let names: string[] = [];
    try { names = await ctx.fs.readdir(root); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith(".app")) continue;
      const path = `${root}/${n}`;
      const row: AppRow = { name: n.slice(0, -4), path };
      try {
        const md = await runCaptured(ctx, { program: "mdls", args: ["-name", "kMDItemDisplayName", "-name", "kMDItemVersion", path] });
        const dn = md.stdout.match(/kMDItemDisplayName\s*=\s*"([^"]+)"/);
        const ver = md.stdout.match(/kMDItemVersion\s*=\s*"([^"]+)"/);
        if (dn?.[1]) row.name = dn[1];
        if (ver?.[1]) row.version = ver[1];
      } catch { /* folder name is enough */ }
      apps.push(row);
    }
  }
  return apps;
}

function parseDesktop(text: string, path: string): AppRow | null {
  if (/^Hidden\s*=\s*true/im.test(text) || /^NoDisplay\s*=\s*true/im.test(text)) return null;
  const name = text.match(/^Name\s*=\s*(.+)$/m)?.[1]?.trim();
  if (!name) return null;
  const exec = text.match(/^Exec\s*=\s*(.+)$/m)?.[1]?.trim();
  return { name, path: exec ?? path };
}

async function listLinux(ctx: HostContext): Promise<AppRow[]> {
  const roots = ["/usr/share/applications", "/usr/local/share/applications", joinPath("linux", ctx.homedir, ".local", "share", "applications")];
  const apps: AppRow[] = [];
  for (const root of roots) {
    let names: string[] = [];
    try { names = await ctx.fs.readdir(root); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith(".desktop")) continue;
      try {
        const row = parseDesktop(await ctx.fs.readFile(`${root}/${n}`), `${root}/${n}`);
        if (row) apps.push(row);
      } catch { /* skip unreadable */ }
    }
  }
  return apps;
}

async function listWindows(ctx: HostContext): Promise<AppRow[]> {
  const apps: AppRow[] = [];
  const keys = [
    "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  ];
  for (const key of keys) {
    try {
      const r = await runCaptured(ctx, { program: "reg", args: ["query", key, "/s", "/v", "DisplayName"] });
      for (const m of r.stdout.matchAll(/DisplayName\s+REG_SZ\s+(.+)/g)) {
        const name = m[1]!.trim();
        if (name) apps.push({ name });
      }
    } catch { /* key missing */ }
  }
  const menus = [
    "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs",
    joinPath("win32", ctx.homedir, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs"),
  ];
  for (const root of menus) {
    let names: string[] = [];
    try { names = await ctx.fs.readdir(root); } catch { continue; }
    for (const n of names) {
      if (!/\.(lnk|url)$/i.test(n)) continue;
      apps.push({ name: n.replace(/\.(lnk|url)$/i, ""), path: joinPath("win32", root, n) });
    }
  }
  const seen = new Set<string>();
  return apps.filter((a) => { const k = a.name.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

export const appsListTool: HostTool = {
  name: "apps.list", capability: "sys.read", riskClass: "low",
  description: "Installed applications: /Applications on macOS, Start Menu/Uninstall keys on Windows, .desktop files on Linux.",
  schema: {
    input: { type: "object", additionalProperties: false, properties: {} },
    output: { type: "object", required: ["apps"], properties: { apps: { type: "array" } } },
  },
  async run(_input, ctx) {
    asObject(_input);
    const apps = ctx.platform === "darwin" ? await listDarwin(ctx)
      : ctx.platform === "win32" ? await listWindows(ctx)
      : await listLinux(ctx);
    return { apps };
  },
};

function classify(target: string, kind: unknown): "app" | "file" | "url" {
  if (kind === "app" || kind === "file" || kind === "url") return kind;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return "url";
  return "file";
}

export const appsOpenTool: HostTool = {
  name: "apps.open", capability: "sys.read", riskClass: "low",
  description: "Open an application, file or URL. URL schemes are limited to http, https and mailto.",
  schema: {
    input: {
      type: "object", additionalProperties: false, required: ["target"],
      properties: { target: { type: "string" }, kind: { type: "string", enum: ["app", "file", "url"] } },
    },
    output: { type: "object", required: ["opened"], properties: { opened: { type: "boolean" }, target: { type: "string" } } },
  },
  async run(input, ctx) {
    const o = asObject(input);
    const target = requireString(o.target, "target", 1, 4096);
    const kind = classify(target, o.kind);
    const deny = denyEntriesFor(ctx.homedir, ctx.env, ctx.platform);
    if (kind === "url") {
      let url: URL;
      try { url = new URL(target); } catch { throw new HostFailure("invalid_input", "target is not a URL"); }
      if (!URL_SCHEMES.has(url.protocol)) throw new HostFailure("denied_by_denylist", `URL scheme ${url.protocol} is not allowed`);
    } else if (denyHit(target, deny)) {
      throw new HostFailure("denied_by_denylist", "the target matches the credential deny-list");
    }
    if (ctx.platform === "darwin") {
      const args = kind === "app" ? ["-a", target] : [target];
      await runCaptured(ctx, { program: "open", args });
    } else if (ctx.platform === "win32") {
      await runCaptured(ctx, { program: "explorer.exe", args: [target] });
    } else {
      const bin = (await which(ctx, "xdg-open")) ?? "xdg-open";
      await runCaptured(ctx, { program: "xdg-open", args: [target] });
      void bin;
    }
    return { opened: true, target, kind };
  },
};

export const appsRunningTool: HostTool = {
  name: "apps.running", capability: "sys.read", riskClass: "low",
  description: "Running GUI applications, where the platform exposes them.",
  schema: {
    input: { type: "object", additionalProperties: false, properties: {} },
    output: { type: "object", required: ["apps"], properties: { apps: { type: "array" } } },
  },
  async run(_input, ctx) {
    asObject(_input);
    if (ctx.platform === "darwin") {
      const r = await runCaptured(ctx, {
        program: "osascript",
        args: ["-e", "tell application \"System Events\" to get name of every process whose background only is false"],
      });
      const apps = r.stdout.split(/,\s*/).map((n) => n.trim()).filter(Boolean).map((name) => ({ name }));
      return { apps };
    }
    if (ctx.platform === "linux") {
      if (!(await which(ctx, "wmctrl"))) return { apps: [], available: false };
      const r = await runCaptured(ctx, { program: "wmctrl", args: ["-l"] });
      const apps = r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((line) => {
        const parts = line.split(/\s+/);
        return { name: parts.slice(3).join(" ") || parts[0] || line, path: undefined };
      });
      return { apps };
    }
    const r = await runCaptured(ctx, { program: "tasklist", args: ["/FO", "CSV", "/V"] });
    const lines = r.stdout.split(/\r?\n/).filter(Boolean);
    const header = (lines[0] ?? "").split(",").map((h) => h.replaceAll('"', "").trim().toLowerCase());
    const iName = header.findIndex((h) => h === "image name");
    const iTitle = header.findIndex((h) => h === "window title");
    const iSess = header.findIndex((h) => h === "session name");
    const apps: Array<{ name: string }> = [];
    for (const line of lines.slice(1)) {
      const cols: string[] = [];
      let cur = "", q = false;
      for (const ch of line) {
        if (ch === '"') q = !q;
        else if (ch === "," && !q) { cols.push(cur); cur = ""; }
        else cur += ch;
      }
      cols.push(cur);
      const title = cols[iTitle] ?? "N/A";
      const sess = cols[iSess] ?? "";
      if (/^N\/A$/i.test(title) && !/console/i.test(sess)) continue;
      if (/console/i.test(sess) || (title && title !== "N/A")) {
        const name = (cols[iName] ?? "").replace(/\.exe$/i, "");
        if (name && name !== "System Idle Process") apps.push({ name });
      }
    }
    return { apps };
  },
};
