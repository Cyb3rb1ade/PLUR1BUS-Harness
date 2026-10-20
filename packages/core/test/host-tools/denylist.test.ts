import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalisePath } from "../../src/policy/paths-index.ts";
import { invalidDenyEntry } from "../../src/policy/paths.ts";
import { denyEntriesFor, looksLikeSecret, redactSecrets, redactText } from "../../src/host-tools/index.ts";
import { runHostTool } from "../../src/host-tools/index.ts";
import { makeCtx } from "./helpers.ts";

describe("credential deny-list", () => {
  it("covers keychain, ssh, gnupg, cloud CLIs, dotenv names and D110 stores", () => {
    const posix = denyEntriesFor("/Users/alice", {}, "darwin");
    const names = posix.filter((e) => "name" in e).map((e) => e.name).sort();
    const paths = posix.filter((e) => "path" in e).map((e) => e.path);
    assert.ok(names.includes(".env"));
    assert.ok(names.includes(".ssh"));
    assert.ok(names.includes(".gnupg"));
    assert.ok(names.includes("auth.json"));
    assert.ok(names.includes("credentials"));
    assert.ok(paths.some((p) => p.includes("/.ssh")));
    assert.ok(paths.some((p) => p.includes("/.gnupg")));
    assert.ok(paths.some((p) => p.includes("/Library/Keychains")));
    assert.ok(paths.some((p) => p.includes("/.aws")));
    assert.ok(paths.some((p) => p.includes("/.codex")));
    assert.ok(paths.some((p) => p.includes("/.hermes")));
    assert.ok(paths.some((p) => /\/\.[oO].*claw/.test(p) || p.includes("penclaw")), "other-host credential dir");
  });

  it("expands CODEX_HOME, HERMES_HOME and Windows LocalAppData", () => {
    const win = denyEntriesFor("C:\\Users\\alice", {
      CODEX_HOME: "C:\\codex-home",
      HERMES_HOME: "C:\\hermes-home",
      LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local",
    }, "win32");
    const paths = win.filter((e) => "path" in e).map((e) => e.path);
    assert.ok(paths.some((p) => p.includes("codex-home")));
    assert.ok(paths.some((p) => p.includes("hermes-home")));
    assert.ok(paths.some((p) => /AppData/i.test(p) && /hermes/i.test(p)));
  });

  it("redacts token-shaped process arguments and deny-listed paths", () => {
    assert.equal(looksLikeSecret("sk-live-abcdefghijklmnopqrstuv"), true);
    assert.equal(looksLikeSecret("ghp_abcdefghijklmnopqrstuvwxyz123456"), true);
    assert.equal(looksLikeSecret("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaa.bbb"), true);
    assert.equal(looksLikeSecret("node"), false);
    const line = redactSecrets("/usr/bin/node --token=sk-live-abcdefghijklmnopqrstuv /Users/alice/.ssh/id_ed25519", denyEntriesFor("/Users/alice", {}, "darwin"));
    assert.ok(!line.includes("sk-live"));
    assert.ok(!line.includes("id_ed25519") || line.includes("[redacted]"));
    assert.match(line, /\[redacted\]/);
  });

  it("redactText never returns the original secret", () => {
    assert.equal(redactText("pre ghp_abcdefghijklmnopqrstuvwxyz123456 post").includes("ghp_"), false);
  });

  it("apps.open of a deny-listed file is denied_by_denylist", async () => {
    const { ctx } = makeCtx("darwin");
    const r = await runHostTool("apps.open", { target: "/Users/alice/.ssh/id_ed25519", kind: "file" }, ctx);
    assert.equal(r.isError, true);
    if (r.isError) assert.equal(r.error.code, "denied_by_denylist");
  });
});

for (const platform of ["darwin", "linux", "win32"] as const) {
  it(`D110: every foreign CLI credential root and override is denied on ${platform}`, async () => {
    const { denyHit } = await import("../../src/host-tools/denylist.ts");
    const { joinPath } = await import("../../src/host-tools/types.ts");
    const home = platform === "win32" ? "C:\\Users\\alice" : "/home/alice";
    const p = (...parts: string[]) => joinPath(platform, ...parts);
    const oc = String.fromCharCode(111) + "penclaw";
    const env: Record<string, string> = {};
    for (const key of ["CODEX_HOME", "HERMES_HOME", "CLAUDE_CONFIG_DIR", "GEMINI_CLI_HOME", "AGY_HOME", "ANTIGRAVITY_HOME", oc.toUpperCase() + "_HOME", oc.toUpperCase() + "_STATE_DIR"]) env[key] = p(home, "overrides", key.toLowerCase());
    const deny = denyEntriesFor(home, env, platform);
    for (const root of [".codex", ".hermes", "." + oc, ".claude", ".gemini", ".agy"]) {
      for (const file of ["auth.json", "credentials.json", "oauth_creds.json", "agents/main/agent/auth-profiles.json", "agents/main/agent/source.sqlite"]) {
        assert.equal(denyHit(p(home, root, ...file.split("/")), deny), true, `${platform}: ${root}/${file}`);
      }
      assert.equal(denyHit(p(home, root.toUpperCase(), "arbitrary-registration-record"), deny), true);
    }
    for (const root of Object.values(env)) assert.equal(denyHit(p(root, "nested", "registration"), deny), true);
    assert.equal(denyHit(p(home, "workspace", "report.md"), deny), false);
    assert.equal(denyHit(p(home, ".codex-not-a-credential-root", "notes.md"), deny), false);
  });
}

describe("deny-list entries from environment overrides are canonical", () => {
  const pathsOf = (home: string, env: Record<string, string>, platform: "linux" | "win32") =>
    denyEntriesFor(home, env, platform).filter((e): e is { path: string } => "path" in e).map((e) => e.path);

  it("a '..' or '.' segment in an override is collapsed, so the entry can match a canonical path", () => {
    const p = pathsOf("/home/u", { CLAUDE_CONFIG_DIR: "/srv/agents/../claude", CODEX_HOME: "/srv/./codex/x/..", XDG_CONFIG_HOME: "/srv/cfg/../xdg" }, "linux");
    assert.ok(p.includes("/srv/claude"), p.join("\n"));
    assert.ok(p.includes("/srv/codex"));
    assert.ok(p.includes("/srv/codex/auth.json"));
    assert.ok(p.includes("/srv/xdg/gcloud"));
    assert.ok(p.every((x) => !x.split("/").some((s) => s === ".." || s === ".")), "no entry keeps a dot segment");
    const win = pathsOf("C:\\Users\\u", { HERMES_HOME: "C:\\agents\\..\\hermes" }, "win32");
    assert.ok(win.includes("C:\\hermes"), win.join("\n"));
    assert.ok(win.includes("C:\\hermes\\auth.json"));
  });

  it("every entry the list yields is one the path layer accepts, and the collapsed override protects the directory it names", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "p1b-denyenv-")));
    try {
      await mkdir(join(base, "agents"), { recursive: true });
      await mkdir(join(base, "claude"), { recursive: true });
      await mkdir(join(base, "root"), { recursive: true });
      await writeFile(join(base, "claude", "settings.json"), "{}");
      await writeFile(join(base, "root", "a.txt"), "a");
      const deny = denyEntriesFor("/nonexistent-home", { CLAUDE_CONFIG_DIR: `${base}/agents/../claude` }, "linux");
      assert.equal(invalidDenyEntry(deny), null);
      const roots = [{ id: "ws", path: base }];
      const hit = await canonicalisePath(join(base, "claude", "settings.json"), { roots, deny, requireRoot: false, home: "/nonexistent-home" });
      assert.equal(hit.ok, false);
      if (!hit.ok) assert.equal(hit.reason, "deny-listed");
      const ok = await canonicalisePath(join(base, "root", "a.txt"), { roots, deny, requireRoot: false, home: "/nonexistent-home" });
      assert.equal(ok.ok, true);
    } finally { await rm(base, { recursive: true, force: true }); }
  });

  it("a relative override stays as it is and is refused downstream (unchanged)", () => {
    assert.ok(pathsOf("/home/u", { CLAUDE_CONFIG_DIR: "rel/../x" }, "linux").includes("rel/../x"));
    assert.match(invalidDenyEntry(denyEntriesFor("/home/u", { CLAUDE_CONFIG_DIR: "rel/x" }, "linux")) ?? "", /not absolute/);
  });
});
