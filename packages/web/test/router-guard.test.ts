// The router's navigation guard and the hash handling against a fake location (d03 audit). The fake mirrors the browser: assigning
// `location.hash` fires `hashchange` asynchronously, `history.replaceState` does not fire it.
import assert from "node:assert/strict";
import { before, beforeEach, describe, test } from "node:test";

type Listener = () => void;
const listeners = new Map<string, Set<Listener>>();
let hash = "";
const g = globalThis as Record<string, unknown>;
g.location = {
  get hash() { return hash; },
  set hash(v: string) {
    const next = v.startsWith("#") ? v : `#${v}`;
    if (next === hash) return;
    hash = next;
    setTimeout(fire, 0);
  },
  pathname: "/", search: "", protocol: "http:",
};
g.history = { replaceState: (_s: unknown, _t: string, url: string) => { const i = url.indexOf("#"); hash = i < 0 ? "" : url.slice(i); } };
g.addEventListener = (type: string, fn: Listener) => { (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(fn); };
g.removeEventListener = (type: string, fn: Listener) => { listeners.get(type)?.delete(fn); };
function fire(): void { for (const fn of [...(listeners.get("hashchange") ?? [])]) fn(); }
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));
/** What the person does outside our code: a link click, the back button or editing the address bar. */
async function userGoes(to: string): Promise<void> { hash = to; fire(); await tick(); }

let confirmAnswer = true;
let asked: string[] = [];
g.confirm = (m: string) => { asked.push(m); return confirmAnswer; };

type Router = typeof import("../src/router.ts");
let r: Router;
before(async () => { hash = "#/chat"; r = await import("../src/router.ts"); });
beforeEach(() => { confirmAnswer = true; asked = []; });

describe("router: leave guard", () => {
  test("navigate() asks the guards and stays put when one refuses", async () => {
    await userGoes("#/agents"); assert.equal(r.path.value, "/agents");
    const off = r.registerLeaveGuard(() => false);
    assert.equal(r.navigate("/inbox"), false);
    await tick();
    assert.equal(r.path.value, "/agents");
    assert.equal(hash, "#/agents");
    off();
    assert.equal(r.navigate("/inbox"), true);
    await tick();
    assert.equal(r.path.value, "/inbox");
  });

  test("the guard is told where the person is going, query included", async () => {
    await userGoes("#/agents");
    const seen: string[] = [];
    const off = r.registerLeaveGuard((to) => { seen.push(to); return true; });
    r.navigate("/settings/general?focus=core.logLevel"); await tick();
    await userGoes("#/inbox?x=1");
    off();
    assert.deepEqual(seen, ["/settings/general?focus=core.logLevel", "/inbox?x=1"]);
  });

  test("an approved navigate() asks once, not again when its hashchange arrives", async () => {
    await userGoes("#/agents");
    let n = 0;
    const off = r.registerLeaveGuard(() => { n++; return true; });
    r.navigate("/inbox"); await tick();
    off();
    assert.equal(n, 1);
  });

  test("a link click or the back button (hashchange only) is undone when a guard refuses, without moving the route", async () => {
    await userGoes("#/agents");
    const off = r.registerLeaveGuard(() => false);
    await userGoes("#/inbox");
    assert.equal(r.path.value, "/agents");
    assert.equal(hash, "#/agents", "the address bar is put back");
    off();
    await userGoes("#/inbox");
    assert.equal(r.path.value, "/inbox");
  });

  test("a refused undo does not ask twice for the one change", async () => {
    await userGoes("#/agents");
    let n = 0;
    const off = r.registerLeaveGuard(() => { n++; return false; });
    await userGoes("#/inbox");
    off();
    assert.equal(n, 1);
  });

  test("force skips the guards (login redirect after an expired session)", async () => {
    await userGoes("#/agents");
    const off = r.registerLeaveGuard(() => false);
    r.navigate("/login", { replace: true, force: true });
    off();
    assert.equal(r.path.value, "/login");
  });

  test("replace navigation is guarded as well", async () => {
    await userGoes("#/agents");
    const off = r.registerLeaveGuard(() => false);
    assert.equal(r.navigate("/inbox", { replace: true }), false);
    off();
    assert.equal(r.path.value, "/agents");
  });

  test("a throwing guard does not trap the person", async () => {
    await userGoes("#/agents");
    const off = r.registerLeaveGuard(() => { throw new Error("boom"); });
    assert.equal(r.navigate("/inbox"), true);
    await tick();
    off();
    assert.equal(r.path.value, "/inbox");
  });

  test("the disposer removes the guard, and twice is harmless", async () => {
    await userGoes("#/agents");
    const off = r.registerLeaveGuard(() => false);
    off(); off();
    assert.equal(r.navigate("/inbox"), true);
    await tick();
  });
});

describe("router: dirty guard", () => {
  test("asks with the page's message only while dirty", async () => {
    await userGoes("#/agents");
    let dirty = false;
    const off = r.registerDirtyGuard(() => dirty, () => "Discard?");
    assert.equal(r.navigate("/inbox"), true); await tick();
    assert.deepEqual(asked, []);
    dirty = true; confirmAnswer = false;
    assert.equal(r.navigate("/agents"), false);
    assert.deepEqual(asked, ["Discard?"]);
    confirmAnswer = true;
    assert.equal(r.navigate("/agents"), true); await tick();
    off();
  });

  test("browser back with unsaved changes asks and can stay", async () => {
    await userGoes("#/agents");
    const off = r.registerDirtyGuard(() => true, () => "Discard?");
    confirmAnswer = false;
    await userGoes("#/chat");
    assert.equal(r.path.value, "/agents");
    assert.equal(hash, "#/agents");
    off();
  });

  test("beforeunload is armed only while a dirty guard is registered and warns only when dirty", async () => {
    const count = (): number => listeners.get("beforeunload")?.size ?? 0;
    assert.equal(count(), 0);
    let dirty = false;
    const off = r.registerDirtyGuard(() => dirty, () => "x");
    assert.equal(count(), 1);
    const fn = [...listeners.get("beforeunload")!][0] as unknown as (e: Event) => void;
    const ev = { prevented: false, returnValue: undefined as unknown, preventDefault() { this.prevented = true; } };
    fn(ev as unknown as Event); assert.equal(ev.prevented, false);
    dirty = true;
    fn(ev as unknown as Event); assert.equal(ev.prevented, true);
    off(); off();
    assert.equal(count(), 0);
  });
});

describe("router: hash parsing", () => {
  test("a hash of a million slashes is read in linear time", async () => {
    const t0 = performance.now();
    await userGoes(`#/chat${"/".repeat(1_000_000)}x`);
    const ms = performance.now() - t0;
    assert.ok(ms < 1000, `took ${ms.toFixed(0)} ms`);
    await userGoes(`#/chat${"/".repeat(1_000_000)}`);
    assert.equal(r.route.value.kind, "page");
  });

  test("a huge hash neither crashes nor leaves a page route", async () => {
    await userGoes(`#/chat/${"a".repeat(1_000_000)}`);
    assert.equal(r.route.value.kind, "not-found");
    await userGoes("#/chat");
  });

  test("replace navigation normalises the path like a hashchange does", async () => {
    await userGoes("#/agents");
    r.navigate("/chat/", { replace: true });
    assert.equal(r.path.value, "/chat");
    r.navigate("/inbox?x=%3F", { replace: true });
    assert.equal(r.path.value, "/inbox");
    assert.equal(r.query.value.get("x"), "?");
  });

  test("an encoded ? or # inside a name is not taken for the query", async () => {
    await userGoes(`#${r.routePath("skills", "what?#x")}?tab=1`);
    assert.equal(r.query.value.get("tab"), "1");
    const rt = r.route.value;
    assert.equal(rt.kind, "page");
    if (rt.kind === "page") assert.deepEqual(r.subSegments(rt.sub), ["what?#x"]);
  });
});
