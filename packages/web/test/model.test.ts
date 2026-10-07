import assert from "node:assert/strict";
import { test } from "node:test";
import { ALL_ITEMS, BOTTOM, GROUPS, LANDING } from "../src/nav.ts";
import { resolve } from "../src/router.ts";

test("nav: groups Workspace, Build, Control with the canvas items; Settings and Help are pinned apart", () => {
  assert.deepEqual(GROUPS.map((g) => g.id), ["workspace", "build", "control"]);
  assert.deepEqual(GROUPS[0]!.items.map((i) => i.id), ["chat", "projects", "agents", "inbox", "memories"]);
  assert.deepEqual(GROUPS[1]!.items.map((i) => i.id), ["library", "skills", "plugins", "switchboard", "recurring"]);
  assert.deepEqual(GROUPS[2]!.items.map((i) => i.id), ["approvals", "usage", "logs"]);
  assert.deepEqual(BOTTOM.map((i) => i.id), ["settings", "help"]);
  assert.equal(new Set(ALL_ITEMS.map((i) => i.path)).size, ALL_ITEMS.length);
});

test("router: login, known pages, landing and unknown paths", () => {
  assert.equal(resolve("/login").kind, "login");
  for (const i of ALL_ITEMS) assert.deepEqual(resolve(i.path), { kind: "page", item: i });
  assert.equal(LANDING, "/chat");
  assert.deepEqual(resolve("/nope"), { kind: "not-found", path: "/nope" });
});
