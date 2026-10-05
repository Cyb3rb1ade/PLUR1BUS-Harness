// Real-layout source installations per OS (plugin-distribution spec §B.7, gap G12), generated per run instead of
// committed trees. Each layout is the directory tree an OpenClaw and a Hermes install leave in one user's home on
// Linux, macOS or Windows — with a non-ASCII user name — and its configs name paths the way that OS wrote them
// (`/home/jürgen/...`, `/Users/jürgen/...`, `C:\Users\Jürgen\...`). Built on any host, a layout is either read where
// it was "installed" (same OS: the default roots are found through the injected environment) or read as a copy from
// another OS (the configs' paths are rebased onto the copy, or reported unmapped). Two markers must never appear in
// a report: FAKE_TOKEN and CONTENT_MARKER.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { CATALOG } from "../../src/import/catalog.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import { buildM7HermesFixture, buildM7OpenclawFixture, CONTENT_MARKER, E5, FAKE_TOKEN, lanceStore, link, linkDir, type M7HermesFixture, type M7OpenclawFixture, skill, write } from "./fixtures.ts";

export type LayoutOs = "linux" | "macos" | "windows";
export const LAYOUT_OSES: LayoutOs[] = ["linux", "macos", "windows"];
export const USER = "J\u00fcrgen";

/** The host OS a layout was made for, as `process.platform` names it. */
export const platformOf = (os: LayoutOs): NodeJS.Platform => (os === "linux" ? "linux" : os === "macos" ? "darwin" : "win32");

export interface Layout {
  os: LayoutOs;
  base: string;
  /** The user's home on this host (inside `base`). */
  home: string;
  openclawRoot: string;
  hermesRoot: string;
  /** How the source OS names things: its home and its roots, in its own syntax. */
  origin: { home: string; openclawRoot: string; hermesRoot: string; sep: string };
  /** The environment that OS's shell would give a process, pointing at this host's copy of the home. */
  env: NodeJS.ProcessEnv;
  /** A path in the source's config that lies outside the copied roots (in the source's syntax). */
  outsidePath: string;
  /** Whether the layout could create two case-variant names and a Windows-reserved name on this host. */
  created: { caseVariants: boolean; reservedName: boolean };
  /** The long nested file's relative path inside the `deep` skill. */
  deepRel: string;
}

const crlfBom = (t: string) => `\ufeff${t.replaceAll("\n", "\r\n")}`;

/** Builds one OS layout under a fresh temp dir. */
export async function buildLayout(os: LayoutOs): Promise<Layout> {
  const base = tempDir(`p1b-imp-layout-${os}-`);
  const win = os === "windows";
  const home = join(base, win ? "Users" : os === "macos" ? "Users" : "home", USER);
  const lower = USER.toLowerCase();
  const origin = win
    ? { home: `C:\\Users\\${USER}`, openclawRoot: `C:\\Users\\${USER}\\.openclaw`, hermesRoot: `C:\\Users\\${USER}\\AppData\\Local\\hermes`, sep: "\\" }
    : { home: `/${os === "macos" ? "Users" : "home"}/${lower}`, openclawRoot: `/${os === "macos" ? "Users" : "home"}/${lower}/.openclaw`, hermesRoot: `/${os === "macos" ? "Users" : "home"}/${lower}/.hermes`, sep: "/" };
  const openclawRoot = join(home, ".openclaw");
  const hermesRoot = win ? join(home, "AppData", "Local", "hermes") : join(home, ".hermes");
  const o = (...parts: string[]) => [origin.openclawRoot, ...parts].join(origin.sep);
  const h = (...parts: string[]) => [origin.hermesRoot, ...parts].join(origin.sep);
  const outsidePath = [origin.home, "projects", "team-skills"].join(origin.sep);
  const text = (t: string) => (win ? crlfBom(t) : t);

  // OpenClaw: config with the source OS's own absolute paths, a PLUR1BUS store in two embedding identities.
  write(join(openclawRoot, "openclaw.json"), text(`// ${os} layout
{
  meta: { lastTouchedVersion: "2026.9.5" },
  agents: { list: [ { id: "alpha", workspace: ${JSON.stringify(o("ws-alpha"))} }, { id: "beta" } ] },
  skills: { load: { extraDirs: [${JSON.stringify(o("extra-skills"))}, ${JSON.stringify(outsidePath)}] } },
  models: { providers: { "anthropic:default": { apiKey: "${FAKE_TOKEN}" } } },
  plugins: { entries: { "memory-lancedb-namespaced": { enabled: true, config: {
    baseDbPath: ${JSON.stringify(o("memory", "lancedb-namespaced"))},
    embedding: { provider: "local-transformers", local: { model: "${E5}", dimensions: 384, cacheDir: ${JSON.stringify(o("models", "plur1bus"))} } },
  } } } },
}
`));
  const store = join(openclawRoot, "memory", "lancedb-namespaced");
  await lanceStore(join(store, "alpha"), 384, 2);
  await lanceStore(join(store, "beta"), 768, 1);
  write(join(openclawRoot, "models", "plur1bus", ...E5.split("/"), CATALOG[E5]!.revision, "onnx", "model.onnx"), "fake-onnx");
  write(join(openclawRoot, ".env"), `OPENAI_API_KEY=${FAKE_TOKEN}\n`);
  write(join(openclawRoot, "ws-alpha", "SOUL.md"), `${CONTENT_MARKER}\n`);

  // Skills: plain, CRLF+BOM on Windows, a non-ASCII file name, a nested path past 300 characters, a directory link
  // (junction on Windows), a file link when the host allows one, and the hazards the source OS could hold.
  const skills = join(openclawRoot, "ws-alpha", "skills");
  write(join(skills, "notes", "SKILL.md"), text(`---\nname: notes\ndescription: Meeting notes\n---\n# notes\n${CONTENT_MARKER}\n`));
  write(join(skills, "notes", `r\u00e9sum\u00e9-${USER}.md`), text("umlaut file\n"));
  write(join(skills, "notes", "docs", "guide.md"), "guide\n");
  linkDir(join(skills, "notes", "docs"), join(skills, "notes", "docs-link"));
  link(join(skills, "notes", "docs", "guide.md"), join(skills, "notes", "guide-link.md"));
  skill(join(skills, "deep"), "deep", "Deeply nested");
  const segs: string[] = [];
  while (join(skills, "deep", ...segs).length < 320) segs.push("deeply-nested-directory-name");
  const deepRel = [...segs, "leaf.md"].join("/");
  write(join(skills, "deep", ...segs, "leaf.md"), "leaf\n");
  skill(join(openclawRoot, "extra-skills", "extra-one"), "extra-one", "From an extra dir");
  skill(join(openclawRoot, "skills", "conflict"), "conflict", "Clashes with the harness");
  // A POSIX source can hold names a Windows target cannot: created where the host can, never on Windows itself.
  const created = { caseVariants: false, reservedName: false };
  if (!win && process.platform !== "win32") {
    skill(join(skills, "portable-not"), "portable-not", "Holds aux.md");
    write(join(skills, "portable-not", "aux.md"), "device name on Windows\n");
    created.reservedName = true;
    skill(join(skills, "casey"), "casey", "Holds README.md and readme.md");
    write(join(skills, "casey", "README.md"), "A\n");
    try { writeFileSync(join(skills, "casey", "readme.md"), "b\n", { flag: "wx" }); created.caseVariants = true; } catch { /* case-insensitive volume */ }
  }

  // Hermes: root plus a profile, an external skills dir named in the source OS's syntax.
  write(join(hermesRoot, "config.yaml"), text(`_config_version: 45\nmodel:\n  api_key: "${FAKE_TOKEN}"\nskills:\n  external_dirs:\n    - ${h("ext-skills")}\n`));
  write(join(hermesRoot, ".env"), `OPENROUTER_API_KEY=${FAKE_TOKEN}\n`);
  skill(join(hermesRoot, "skills", "productivity", "meeting-notes"), "meeting-notes", "Hermes meeting notes");
  skill(join(hermesRoot, "ext-skills", "ext-one"), "ext-one", "External");
  write(join(hermesRoot, "profiles", "work", "config.yaml"), "_config_version: 45\n");
  skill(join(hermesRoot, "profiles", "work", "skills", "research", "lit-review"), "lit-review", "Literature review");

  const env: NodeJS.ProcessEnv = win ? { USERPROFILE: home, LOCALAPPDATA: join(home, "AppData", "Local") } : { HOME: home };
  return { os, base, home, openclawRoot, hermesRoot, origin, env, outsidePath, created, deepRel };
}

export interface M7Layout {
  os: LayoutOs;
  base: string;
  home: string;
  openclawRoot: string;
  hermesRoot: string;
  origin: { home: string; openclawRoot: string; hermesRoot: string; sep: string };
  env: NodeJS.ProcessEnv;
  openclaw: M7OpenclawFixture;
  hermes: M7HermesFixture;
}

/** Builds an M7 layout containing synthetic OpenClaw and Hermes fixtures with two embedding identities. */
export async function buildM7Layout(os: LayoutOs): Promise<M7Layout> {
  const base = tempDir(`p1b-m7-layout-${os}-`);
  const win = os === "windows";
  const home = join(base, win ? "Users" : os === "macos" ? "Users" : "home", USER);
  const lower = USER.toLowerCase();
  const origin = win
    ? { home: `C:\\Users\\${USER}`, openclawRoot: `C:\\Users\\${USER}\\.openclaw`, hermesRoot: `C:\\Users\\${USER}\\AppData\\Local\\hermes`, sep: "\\" }
    : { home: `/${os === "macos" ? "Users" : "home"}/${lower}`, openclawRoot: `/${os === "macos" ? "Users" : "home"}/${lower}/.openclaw`, hermesRoot: `/${os === "macos" ? "Users" : "home"}/${lower}/.hermes`, sep: "/" };
  const openclawRoot = join(home, ".openclaw");
  const hermesRoot = win ? join(home, "AppData", "Local", "hermes") : join(home, ".hermes");

  const openclaw = await buildM7OpenclawFixture({ base, root: openclawRoot });
  const hermes = await buildM7HermesFixture({ base, root: hermesRoot });

  const env: NodeJS.ProcessEnv = win ? { USERPROFILE: home, LOCALAPPDATA: join(home, "AppData", "Local") } : { HOME: home };
  return { os, base, home, openclawRoot, hermesRoot, origin, env, openclaw, hermes };
}
