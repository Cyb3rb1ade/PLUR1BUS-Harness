import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CollabError } from "../../src/collab/errors.ts";
import { SCHEMA_VERSION } from "../../src/collab/migrations.ts";
import { CollabStore } from "../../src/collab/store.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import { isCode } from "./helpers.ts";

function mk(): CollabStore { return new CollabStore({ path: ":memory:", clock: (() => { let t = 1000; return () => ++t; })() }); }

describe("project store", () => {
  it("creates a project with owner as lead, members and agents, archive-first", () => {
    const s = mk();
    const p = s.createProject({ name: "  alpha  ", owner: "u-owner" });
    assert.equal(p.name, "alpha");
    assert.equal(p.owner, "u-owner");
    assert.deepEqual(p.members, [{ userId: "u-owner", role: "lead" }]);
    assert.equal(p.archivedAt, null);
    assert.equal(p.settings.maxDepth, 1);
    s.addMember(p.id, "u-mem", "member");
    s.addAgent(p.id, "bernd");
    const got = s.getProject(p.id)!;
    assert.deepEqual(got.members.map((m) => m.userId).sort(), ["u-mem", "u-owner"]);
    assert.deepEqual(got.agents, ["bernd"]);
    assert.throws(() => s.removeMember(p.id, "u-owner"), isCode("conflict"));
    const archived = s.archiveProject(p.id);
    assert.ok(archived.archivedAt !== null);
    assert.equal(s.getProject(p.id)!.archivedAt, archived.archivedAt);
    assert.throws(() => s.addAgent(p.id, "x"), isCode("archived"));
    assert.throws(() => s.removeMember(p.id, "u-mem"), isCode("archived"));
  });

  it("refuses an empty name and a missing project", () => {
    const s = mk();
    assert.throws(() => s.createProject({ name: "  ", owner: "u" }), isCode("invalid"));
    assert.throws(() => s.addMember("nope", "u", "member"), isCode("not-found"));
  });

  it("migrates and refuses a newer schema", () => {
    const dir = tempDir("p1b-collab-");
    const path = join(dir, "c.db");
    const a = new CollabStore({ path });
    a.createProject({ name: "x", owner: "u" });
    a.close();
    const raw = new DatabaseSync(path);
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    raw.close();
    assert.throws(() => new CollabStore({ path }), (e: unknown) => e instanceof CollabError && e.reason === "schema-too-new");
  });
});
