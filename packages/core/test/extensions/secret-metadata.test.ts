/** Secret availability and MCPB mappings are read from approved installed metadata, never server claims (M-A7). */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installedMcpExtensions } from "../../src/mcp/extension-metadata.ts";

async function fixture(remote: boolean | "oauth" = false) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "p1b-A7-meta-")));
  const payload = join(home, "mcp", "example", "1.0.0", "payload");
  await mkdir(join(payload, ".plur1bus"), { recursive: true });
  await mkdir(join(home, "extensions"), { recursive: true });
  const files: Record<string, { sha256: string; size: number }> = {};
  const write = async (name: string, value: unknown) => {
    const bytes = JSON.stringify(value);
    await writeFile(join(payload, name), bytes);
    files[`payload/${name}`] = { sha256: createHash("sha256").update(bytes).digest("hex"),
      size: Buffer.byteLength(bytes) };
  };
  await write("manifest.json", { user_config: { "api-key": { type: "string", sensitive: true, required: true } },
    server: { type: "node", entry_point: "main.mjs", mcp_config: {
      args: ["${__dirname}/main.mjs"], env: { OPAQUE: "${user_config.api-key}" },
    } } });
  await write(".plur1bus/mcpb.json", { format: 1, manifestVersion: "0.4", secretSlots: { "api-key": "TOKEN" } });
  await writeFile(join(payload, "main.mjs"), "process.stdin.resume();");
  const manifest = { id: "local/example", name: "example", version: "1.0.0", kind: "mcp-server",
    capabilities: { network: { mode: "none" }, secrets: [{ slot: "TOKEN", required: true }], tools: [] },
    requires: { runtime: remote ? { type: "none" } : { type: "node", range: ">=24" } }, files,
    ...(remote ? { remote: { url: "https://example.test/mcp", auth: remote === "oauth" ? "oauth" : "header" } } : {}) };
  const approve = async () => {
    const bytes = JSON.stringify(manifest);
    await writeFile(join(payload, "..", "p1x.json"), bytes);
    await writeFile(join(home, "extensions", "state.json"), JSON.stringify({ schemaVersion: 1, items: { example: {
      id: manifest.id, name: manifest.name, version: manifest.version, kind: manifest.kind,
    activeVersion: manifest.version,
      capabilities: manifest.capabilities, manifestSha256: createHash("sha256").update(bytes).digest("hex"),
    } } }));
  };
  await approve();
  return { home, payload, async approveMcpb(value: unknown) { await write("manifest.json", value); await approve(); } };
}

describe("extension secret metadata", () => {
  it("a present declared slot releases local setup without putting values in its registered definition", async () => {
    const f = await fixture();
    try {
      const missing = await installedMcpExtensions(f.home, {}, new Set());
      assert.equal(missing[0]?.overlay, "needs-setup");
      const available = await installedMcpExtensions(f.home, {}, new Set(["ext:example:TOKEN"]));
      assert.equal(available[0]?.definition?.transport.type, "stdio");
      assert.deepEqual(available[0]?.setup?.userConfigSlots, { "api-key": "TOKEN" });
      assert.deepEqual(available[0]?.setup?.env, { OPAQUE: "${user_config.api-key}" });
      const transport = available[0]?.definition?.transport;
      if (transport?.type !== "stdio") assert.fail("stdio definition expected");
      assert.deepEqual(transport.env, {});
    } finally { await rm(f.home, { recursive: true, force: true }); }
  });

  it("a remote header binds the canonical required slot only when it is present", async () => {
    const f = await fixture(true);
    try {
      const [extension] = await installedMcpExtensions(f.home, {}, new Set(["ext:example:TOKEN"]));
      assert.equal(extension?.definition?.authSecret, "ext:example:TOKEN");
      assert.deepEqual(extension?.definition?.transport,
        { type: "http", url: "https://example.test/mcp", headers: {} });
    } finally { await rm(f.home, { recursive: true, force: true }); }
  });

  it("refuses altered secret-slot mapping metadata even when the MCPB manifest remains intact", async () => {
    const f = await fixture();
    try {
      await writeFile(join(f.payload, ".plur1bus", "mcpb.json"), JSON.stringify({ format: 1,
        secretSlots: { "api-key": "OTHER" } }));
      const [extension] = await installedMcpExtensions(f.home, {}, new Set(["ext:example:TOKEN"]));
      assert.equal(extension?.overlay, "error");
      assert.equal(extension?.definition, undefined);
    } finally { await rm(f.home, { recursive: true, force: true }); }
  });

  it("an OAuth endpoint remains auth-required until a real provider is bound by the host", async () => {
    const f = await fixture("oauth");
    try {
      const [missing] = await installedMcpExtensions(f.home, {}, new Set(["ext:example:TOKEN"]));
      assert.equal(missing?.overlay, "error");
      assert.equal(missing?.reason, "auth-required");
      assert.deepEqual(missing?.remote, { url: "https://example.test/mcp", auth: "oauth" });
      const [ready] = await installedMcpExtensions(f.home, { oauthReady: name => name === "example" },
        new Set(["ext:example:TOKEN"]));
      assert.equal(ready?.definition?.transport.type, "http");
      assert.equal(ready?.definition?.authSecret, undefined);
    } finally { await rm(f.home, { recursive: true, force: true }); }
  });

  it("runtime platform overrides replace the whole environment and expand nonsecret multiple defaults", async () => {
    const f = await fixture();
    try {
      await f.approveMcpb({ user_config: {
        "api-key": { type: "string", sensitive: true },
        folders: { type: "directory", multiple: true, default: ["/one", "/two"] },
      }, server: { type: "node", entry_point: "main.mjs", mcp_config: {
        args: ["unused.mjs"], env: { BASE_ONLY: "base" },
        platform_overrides: { [process.platform]: {
          args: ["${__dirname}/main.mjs", "${user_config.folders}"], env: { ONLY: "selected" },
        } },
      } } });
      const [extension] = await installedMcpExtensions(f.home, {}, new Set(["ext:example:TOKEN"]));
      const transport = extension?.definition?.transport;
      if (transport?.type !== "stdio") assert.fail("stdio definition expected");
      assert.deepEqual(transport.args, [join(f.payload, "main.mjs"), "/one", "/two"]);
      assert.deepEqual(extension?.setup?.env, { ONLY: "selected" });
    } finally { await rm(f.home, { recursive: true, force: true }); }
  });

  it("setup reads declared slots for non-MCP records without requiring a package directory", async () => {
    const f = await fixture();
    try {
      await writeFile(join(f.home, "extensions", "state.json"), JSON.stringify({ schemaVersion: 1, items: { module: {
        name: "module", kind: "module", capabilities: { secrets: [{ slot: "KEY", required: false }] },
      } } }));
      const module = await import("../../src/mcp/extension-metadata.ts");
      assert.equal(typeof module.installedExtensionSecretDefinition, "function");
      const definition = await module.installedExtensionSecretDefinition(f.home, "module");
      assert.deepEqual(definition, { name: "module", slots: [{ slot: "KEY", required: false }] });
      assert.deepEqual(await installedMcpExtensions(f.home), []);
    } finally { await rm(f.home, { recursive: true, force: true }); }
  });
});
