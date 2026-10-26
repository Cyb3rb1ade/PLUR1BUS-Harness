// The generated fixture is the cross-language contract for RE-14/T1; coverage must grow with the source table.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { CACHE_PROFILE_TABLE } from "../src/cache-profiles.ts";
import { buildCacheProfileVectors } from "../src/cache-profile-vectors.ts";

describe("cache-profile parity vectors", () => {
  it("cover every table row and exercise all declared platforms, including shadowed matches", () => {
    const vectors = buildCacheProfileVectors();
    for (const row of CACHE_PROFILE_TABLE.rows) {
      assert.ok(vectors.profiles.some((v) => v.expected.rowId === row.id), `missing row witness ${row.id}`);
      for (const platform of row.platforms) {
        assert.ok(vectors.profiles.some((v) => v.name.startsWith(`row:${row.id}:`) && v.route.platform === platform),
          `missing witness for ${row.id} on ${platform}`);
      }
    }
  });

  it("cover every alias and OpenRouter slug prefix", () => {
    const { profiles } = buildCacheProfileVectors();
    for (const alias of CACHE_PROFILE_TABLE.aliases) {
      assert.ok(profiles.some((v) => v.model === alias.from && v.expected.ref.id === alias.to));
    }
    for (const prefix of Object.keys(CACHE_PROFILE_TABLE.gateways.openrouter.slugPrefixes)) {
      assert.ok(profiles.some((v) => v.model.startsWith(`${prefix}/`) && v.expected.gateway === "openrouter"));
    }
  });

  it("record platform precedence, gateway overrides, local routes and unknown models", () => {
    const { profiles } = buildCacheProfileVectors();
    const lookup = (name: string) => {
      const vector = profiles.find((v) => v.name === name);
      assert.ok(vector, `missing vector ${name}`);
      return vector.expected;
    };
    assert.deepEqual(lookup("bedrock:us"), {
      ref: { id: "claude-opus-4-7", platform: "bedrock" },
      platform: "bedrock", gateway: "direct", rowId: "anthropic.bedrock.opus-4-7",
    });
    assert.deepEqual(lookup("route:override-platform"), {
      ref: { id: "claude-opus-4-7", platform: "bedrock" },
      platform: "first-party", gateway: "direct", rowId: "anthropic.opus-4-7",
    });
    assert.equal(lookup("route:override-gateway").gateway, "direct");
    assert.equal(lookup("route:local").rowId, "local.kv-prefix");
    assert.equal(lookup("unknown:model").rowId, null);
    assert.equal(lookup("google:dated").ref.platform, "google-managed");
  });

  it("cover every host pattern and distinguish provider hosts from look-alikes", () => {
    const { urls } = buildCacheProfileVectors();
    for (const host of CACHE_PROFILE_TABLE.hosts) {
      assert.ok(urls.some((v) => {
        try {
          return new RegExp(host.pattern, "u").test(new URL(v.url).hostname);
        } catch {
          return false;
        }
      }),
        `missing host witness ${host.pattern}`);
    }
    assert.deepEqual(urls.find((v) => v.url === "https://api.openai.com/v1")?.expected, { vendor: "openai" });
    assert.deepEqual(urls.find((v) => v.url === "https://api.openai.com.evil.example/v1")?.expected, {});
    assert.deepEqual(urls.find((v) => v.url === "not a url")?.expected, {});
  });

  it("keep the committed fixture byte-identical to deterministic generator output", () => {
    const actual = readFileSync(new URL("../fixtures/cache-profile-vectors.json", import.meta.url), "utf8");
    const expected = JSON.stringify(buildCacheProfileVectors(), null, 2) + "\n";
    assert.equal(actual, expected, "run pnpm gen to refresh cache-profile parity vectors");
    assert.deepEqual(buildCacheProfileVectors(), buildCacheProfileVectors());
  });

  it("refuse stale or missing fixtures through a directory symlink without rewriting them", () => {
    const scratch = mkdtempSync(join(tmpdir(), "cache-vectors-"));
    const root = join(scratch, "real");
    const linked = join(scratch, "linked");
    try {
      mkdirSync(root);
      symlinkSync(root, linked, "junction");
      writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
      mkdirSync(join(root, "src"));
      cpSync(new URL("../schema", import.meta.url), join(root, "schema"), { recursive: true });
      for (const file of ["cache-profiles.ts", "cache-profile-vectors.ts"]) {
        cpSync(new URL(`../src/${file}`, import.meta.url), join(root, "src", file));
      }
      const script = join(linked, "src/cache-profile-vectors.ts");
      const run = (...args: string[]) => spawnSync(process.execPath, ["--experimental-strip-types", script, ...args],
        { encoding: "utf8" });
      const missing = run("--check");
      assert.equal(missing.status, 1, missing.stderr);
      assert.match(missing.stderr, /stale:.*cache-profile-vectors/);
      const generated = run();
      assert.equal(generated.status, 0, generated.stderr);
      assert.equal(run("--check").status, 0);
      const fixture = join(root, "fixtures/cache-profile-vectors.json");
      writeFileSync(fixture, "{}\n");
      const stale = run("--check");
      assert.equal(stale.status, 1);
      assert.match(stale.stderr, /stale:.*cache-profile-vectors/);
      assert.equal(readFileSync(fixture, "utf8"), "{}\n");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
