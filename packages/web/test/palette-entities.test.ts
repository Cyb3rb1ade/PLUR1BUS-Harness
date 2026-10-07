// Role filtering, actions, entity entries and coverage of the Settings page's fields in the palette index. Pure, no browser.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { META, fieldId } from "../src/pages/settings/config/meta.ts";
import { ROLE_PRESETS } from "../src/pages/common/load.ts";
import { agentEntries, buildIndex, logSearchEntries, sessionEntries } from "../src/palette/index-build.ts";
import { search } from "../src/palette/match.ts";
import { SETTINGS } from "../src/palette/settings-index.ts";
import { sectionOf, settingsHref } from "../src/settings-sections.ts";

const ids = (role: string | undefined, q: string): string[] => search(buildIndex({ lang: "en", role }), q).map((h) => h.entry.id);
const ADMINS = ["owner", "admin"];

describe("actions", () => {
  test("a blank query lists navigation first, then the actions, in index order", () => {
    const hits = search(buildIndex({ lang: "en", role: "owner" }), "");
    const groups = hits.map((h) => h.entry.group);
    assert.ok(!groups.includes("setting"));
    assert.equal(groups.indexOf("action") > groups.lastIndexOf("nav"), true);
  });
  test("actions route to existing pages and are found in both languages", () => {
    const to = (q: string): string | undefined => search(buildIndex({ lang: "en", role: "owner" }), q).find((h) => h.entry.group === "action")?.entry.to;
    assert.equal(to("create agent"), "/agents/new");
    assert.equal(to("run setup"), "/setup");
    assert.equal(to("new chat"), "/chat/new");
    assert.equal(to("open logs"), "/logs");
    assert.equal(to("verify audit"), "/logs/activity");
    assert.equal(search(buildIndex({ lang: "de", role: "owner" }), "audit-kette")[0]?.entry.to, "/logs/activity");
    assert.equal(search(buildIndex({ lang: "en", role: "owner" }), "einrichtung")[0]?.entry.to, "/setup");
  });
});

describe("role filtering (docs/rbac.md)", () => {
  const sees = (role: string, id: string): boolean => buildIndex({ lang: "en", role }).some((e) => e.id === id);
  const table: Record<string, string[]> = {
    "nav:logs": [...ADMINS, "operator", "viewer"],
    "nav:/settings/users": ADMINS, "nav:/settings/secrets": ADMINS, "nav:/settings/devices": ADMINS,
    "setting:secrets.fileFallback.enabled": ADMINS,
    "action:create-agent": ADMINS, "action:run-setup": ADMINS, "action:verify-audit": ADMINS,
    "action:open-logs": [...ADMINS, "operator", "viewer"],
    "action:new-chat": [...ROLE_PRESETS], "nav:chat": [...ROLE_PRESETS], "nav:agents": [...ROLE_PRESETS], "setting:egress.allowLoopback": [...ROLE_PRESETS], "nav:/settings/network": [...ROLE_PRESETS],
  };
  for (const role of ROLE_PRESETS) {
    test(`${role}: sees exactly the entries its role may use`, () => {
      for (const [id, roles] of Object.entries(table)) assert.equal(sees(role, id), roles.includes(role), `${role} ${id}`);
    });
  }
  test("a Member finds no Users, Secrets or Logs entry by any of their names, in either language", () => {
    for (const q of ["users", "benutzer", "secrets", "geheimnisse", "logs", "audit", "secrets.fileFallback"]) {
      const hit = search(buildIndex({ lang: "de", role: "member" }), q).filter((h) => /^\/(logs|settings\/(users|secrets|devices))/.test(h.entry.to));
      assert.deepEqual(hit.map((h) => h.entry.id), [], q);
    }
  });
  test("log-search actions are Owner/Admin only and never built for a blank query", () => {
    for (const role of ROLE_PRESETS) assert.equal(logSearchEntries("boom", "en", role).length > 0, ADMINS.includes(role), role);
    assert.deepEqual(logSearchEntries("   ", "en", "owner"), []);
  });
  test("an unknown role or no role is let through: the server decides", () => {
    assert.ok(sees("auditor", "nav:/settings/users"));
    assert.ok(buildIndex({ lang: "en" }).some((e) => e.id === "nav:logs"));
  });
});

describe("log search entries", () => {
  test("free text goes to /logs?q=, a trace-shaped query additionally to /logs?trace=; both localised and encoded", () => {
    const [free, ...rest] = logSearchEntries("disk full & slow", "en", "owner");
    assert.equal(free?.label, "Search logs for “disk full & slow”");
    assert.equal(free?.to, "/logs?q=disk%20full%20%26%20slow");
    assert.deepEqual(rest, []);
    const t = logSearchEntries("0af7651916cd43dd8448eb211c80319c", "de", "admin");
    assert.deepEqual(t.map((e) => e.to), ["/logs?q=0af7651916cd43dd8448eb211c80319c", "/logs?trace=0af7651916cd43dd8448eb211c80319c"]);
    assert.equal(t[0]?.label, "Logs nach „0af7651916cd43dd8448eb211c80319c“ durchsuchen");
  });
  test("long input is truncated", () => {
    assert.ok((logSearchEntries("x".repeat(500), "en", "owner")[0]?.label.length ?? 0) < 200);
  });
});

describe("entity entries", () => {
  test("agents link to /agents/<id>; sessions to /chat/<id>; ids are encoded", () => {
    const a = agentEntries([{ id: "bernd", name: "Bernd" }, { id: "a b", name: "a b" }]);
    assert.deepEqual(a.map((e) => e.to), ["/agents/bernd", "/agents/a%20b"]);
    assert.equal(search(a, "bernd").length, 1);
    const s = sessionEntries([{ id: "ses_1", title: "Plan", agentId: "bernd" }, { id: "ses_2", title: "", agentId: "x" }]);
    assert.deepEqual(s.map((e) => [e.label, e.to, e.meta]), [["Plan", "/chat/ses_1", "bernd"], ["ses_2", "/chat/ses_2", "x"]]);
  });
});

describe("settings page fields are covered", () => {
  test("every key the Settings sections edit (cfg-<key> anchors) has a palette entry that deep-links into its section", () => {
    const index = buildIndex({ lang: "en", role: "owner" });
    for (const m of META) {
      assert.ok(SETTINGS.some((s) => s.key === m.key), `${m.key} missing from the catalogue`);
      const e = index.find((x) => x.id === `setting:${m.key}`);
      assert.ok(e, m.key);
      assert.equal(e.to, settingsHref(m.key));
      assert.ok(sectionOf(m.key), `${m.key} has a section`);
      assert.match(fieldId(m.key), /^cfg-[a-zA-Z0-9-]+$/);
    }
  });
});
