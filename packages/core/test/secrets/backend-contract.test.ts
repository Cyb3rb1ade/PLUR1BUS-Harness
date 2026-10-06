import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";
import { createFileBackend } from "../../src/secrets/file-backend.ts";
import { createKeyringBackend } from "../../src/secrets/keyring-backend.ts";
import { createMemoryBackend } from "../../src/secrets/memory-backend.ts";
import type { SecretBackend } from "../../src/secrets/types.ts";
import { MARKER, fakeKeyring, secure } from "./helpers.ts";

const backends: [string, () => SecretBackend][] = [
  ["memory", () => createMemoryBackend()],
  ["file", () => createFileBackend({ dir: join(tempDir("p1b-sec-"), "secrets"), secure })],
  ["keyring (fake module)", () => { const k = fakeKeyring(); return createKeyringBackend({ service: "plur1bus:test", load: async () => k }); }],
];

for (const [label, make] of backends) {
  describe(`secret backend contract: ${label}`, () => {
    const t1 = new Date("2026-10-06T10:00:00.000Z"); const t2 = new Date("2026-10-06T11:00:00.000Z");
    it("round-trips a value, including unicode and long values", async () => {
      const b = make();
      assert.deepEqual(await b.probe(), { available: true });
      const long = `${MARKER}-` + "ü€𝄞".repeat(2000);
      for (const v of [MARKER, long, "a"]) {
        await b.put("api.key", v, t1);
        assert.equal(await b.get("api.key"), v);
      }
    });
    it("answers null for an absent name and false for deleting one", async () => {
      const b = make();
      assert.equal(await b.get("nope"), null);
      assert.equal(await b.delete("nope"), false);
    });
    it("lists names with metadata, never values; overwrite keeps createdAt", async () => {
      const b = make();
      await b.put("b", MARKER, t1); await b.put("a", MARKER, t1); await b.put("b", `${MARKER}2`, t2);
      const l = await b.list();
      assert.deepEqual(l.map((m) => m.name), ["a", "b"]);
      assert.equal(l[1]!.createdAt, t1.toISOString()); assert.equal(l[1]!.updatedAt, t2.toISOString());
      assert.ok(!JSON.stringify(l).includes(MARKER));
    });
    it("delete removes the value and the listing", async () => {
      const b = make();
      await b.put("x", MARKER, t1);
      assert.equal(await b.delete("x"), true);
      assert.equal(await b.get("x"), null);
      assert.deepEqual(await b.list(), []);
    });
    it("serialises concurrent writes without losing an entry", async () => {
      const b = make();
      await Promise.all(Array.from({ length: 12 }, (_, i) => b.put(`n${i}`, `${MARKER}${i}`, t1)));
      assert.equal((await b.list()).length, 12);
      assert.equal(await b.get("n7"), `${MARKER}7`);
    });
  });
}
