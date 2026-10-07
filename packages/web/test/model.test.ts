import assert from "node:assert/strict";
import { test } from "node:test";
import { ALL_ITEMS, BOTTOM, GROUPS, LANDING } from "../src/nav.ts";
import { PAGES, pageFor } from "../src/pages/registry.ts";
import { PlaceholderPage } from "../src/pages/placeholder.ts";
import { resolve } from "../src/router.ts";

test("nav: groups Workspace, Build, Control with the canvas items; Settings and Help are pinned apart", () => {
  assert.deepEqual(GROUPS.map((g) => g.id), ["workspace", "build", "control"]);
  assert.deepEqual(GROUPS[0]!.items.map((i) => i.id), ["chat", "projects", "agents", "inbox", "memories"]);
  assert.deepEqual(GROUPS[1]!.items.map((i) => i.id), ["library", "skills", "plugins", "models", "switchboard", "recurring"]);
  assert.deepEqual(GROUPS[2]!.items.map((i) => i.id), ["approvals", "usage", "doctor", "logs"]);
  assert.deepEqual(BOTTOM.map((i) => i.id), ["settings", "help"]);
  assert.equal(new Set(ALL_ITEMS.map((i) => i.path)).size, ALL_ITEMS.length);
});

test("router: login, known pages, landing and unknown paths", () => {
  assert.equal(resolve("/login").kind, "login");
  for (const i of ALL_ITEMS) assert.deepEqual(resolve(i.path), { kind: "page", item: i });
  assert.equal(LANDING, "/chat");
  assert.deepEqual(resolve("/nope"), { kind: "not-found", path: "/nope" });
});

test("router: sub-routes keep the path segments after the first (memories/dreams, chat/<id>)", () => {
  const memories = ALL_ITEMS.find((i) => i.id === "memories")!;
  const chat = ALL_ITEMS.find((i) => i.id === "chat")!;
  assert.deepEqual(resolve("/memories/dreams"), { kind: "page", item: memories, sub: "dreams" });
  assert.deepEqual(resolve("/chat/ses_01"), { kind: "page", item: chat, sub: "ses_01" });
  assert.deepEqual(resolve("/chat/a/b"), { kind: "page", item: chat, sub: "a/b" });
  assert.deepEqual(resolve("/chat//"), { kind: "page", item: chat });
  assert.equal("sub" in resolve("/chat"), false);
  assert.deepEqual(resolve("/chatty"), { kind: "not-found", path: "/chatty" });
  assert.deepEqual(resolve("/"), { kind: "not-found", path: "/" });
});

test("router: the new pages live under their groups with the agreed paths", () => {
  assert.equal(ALL_ITEMS.find((i) => i.id === "models")?.path, "/models");
  assert.equal(ALL_ITEMS.find((i) => i.id === "doctor")?.path, "/doctor");
  assert.equal(ALL_ITEMS.find((i) => i.id === "usage")?.path, "/usage");
  assert.equal(ALL_ITEMS.find((i) => i.id === "memories")?.path, "/memories");
});

test("registry: every nav item has an entry, nothing else does, and an unknown id falls back to the placeholder", () => {
  assert.deepEqual(Object.keys(PAGES).sort(), ALL_ITEMS.map((i) => i.id).sort());
  for (const i of ALL_ITEMS) assert.equal(typeof pageFor(i.id), "function", i.id);
  assert.equal(pageFor("no-such-page"), PlaceholderPage);
});
