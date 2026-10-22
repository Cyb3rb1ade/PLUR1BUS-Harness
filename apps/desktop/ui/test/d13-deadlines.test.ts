// D13 gap: a native call that never answers (pair_code, connections_list, harness_logs_tail) must not keep its view
// loading for good. The UI stops waiting after a deadline, shows a failure state and offers a retry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withShell } from "./browser-harness.ts";
import { TIMEOUT, isTimeout, withDeadline } from "../src/models/deadline.ts";
import { DEADLINES, INTERACTIVE_DEADLINE_MS, withDeadlines, type DesktopTransport } from "../src/ipc.ts";
import { pairingFailure } from "../src/models/pairing-model.ts";

const never = <T>() => new Promise<T>(() => {});

test("withDeadline passes results and errors through and rejects with the timeout code once the deadline passes", async () => {
  assert.equal(await withDeadline(async () => "ok", 50), "ok");
  await assert.rejects(withDeadline(async () => { throw "denied"; }, 50), (error: unknown) => error === "denied" && !isTimeout(error));
  await assert.rejects(withDeadline(() => never<string>(), 20), (error: unknown) => error === TIMEOUT && isTimeout(error));
  // A late answer after the deadline is dropped silently: no second settle, no unhandled rejection.
  let finish: (value: string) => void = () => {};
  const late = withDeadline(() => new Promise<string>(resolve => { finish = resolve; }), 10);
  await assert.rejects(late, isTimeout);
  finish("too late");
  await new Promise(resolve => setTimeout(resolve, 20));
});

test("withDeadlines bounds exactly the three calls that can hang and leaves every other call untouched", async () => {
  const base = { connectionsList: () => never(), pairCode: () => never(), harnessLogsTail: () => never<string>(), settingsGet: async () => ({ theme: "dark", locale: "de" }) } as unknown as DesktopTransport;
  const bounded = withDeadlines(base, { connectionsList: 15, pairCode: 15, harnessLogsTail: 15 });
  for (const call of [() => bounded.connectionsList(), () => bounded.pairCode({ name: "n", origin: "https://harness.test", code: "ABCD-2345", repairId: null }), () => bounded.harnessLogsTail!()]) await assert.rejects(call(), isTimeout);
  assert.equal(bounded.settingsGet, base.settingsGet);
  const { harnessLogsTail: _absent, ...withoutLogs } = base;
  assert.equal(withDeadlines(withoutLogs as DesktopTransport, DEADLINES).harnessLogsTail, undefined, "an absent call stays absent");
});

test("a call that waits for a person (pair_code: OS credential prompt, network) gets 120 s; non-interactive calls keep short deadlines", () => {
  assert.equal(INTERACTIVE_DEADLINE_MS, 120_000);
  assert.equal(DEADLINES.pairCode, 120_000);
  assert.ok(DEADLINES.connectionsList <= 30_000 && DEADLINES.harnessLogsTail <= 30_000, "non-interactive invokes stay short");
  assert.ok(DEADLINES.pairCode > DEADLINES.connectionsList && DEADLINES.pairCode > DEADLINES.harnessLogsTail);
});

test("a pair_code that is still waiting after the old 45 s deadline is not timed out", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let answer: (value: string) => void = () => {};
  const base = { pairCode: () => new Promise<string>(resolve => { answer = resolve; }) } as unknown as DesktopTransport;
  const pending = withDeadlines(base).pairCode({ name: "n", origin: "https://harness.test", code: "ABCD-2345", repairId: null }) as unknown as Promise<string>;
  let settled = false;
  pending.then(() => { settled = true; }, () => { settled = true; });
  t.mock.timers.tick(45_001);
  await Promise.resolve();
  assert.equal(settled, false, "the person is still answering the prompt");
  answer("paired");
  assert.equal(await pending, "paired");
  const late = withDeadlines(base).pairCode({ name: "n", origin: "https://harness.test", code: "ABCD-2345", repairId: null }) as unknown as Promise<string>;
  const rejected = assert.rejects(late, isTimeout);
  t.mock.timers.tick(120_000);
  await rejected;
});

test("a timeout is a pairing failure of its own that can be retried", () => {
  assert.deepEqual(pairingFailure(TIMEOUT), { phase: "error", error: "timeout", retry: "retry" });
});

test("a connections_list that never answers ends in an error state with a retry, and a late answer changes nothing", async () => {
  await withShell(async page => {
    await page.addInitScript(() => { (window as any).__fixtureBoot = { deferConnections: true, deadlineMs: 300 }; });
    await page.reload();
    await page.getByRole("button", { name: "View connections" }).waitFor();
    assert.equal(await page.locator(".top-status").innerText(), "Loading connections…");
    await page.waitForFunction(() => document.querySelector(".top-status")?.textContent === "Loading connections took too long.", undefined, { timeout: 3000 });
    await page.getByRole("button", { name: "View connections" }).click();
    await page.getByRole("alert").getByText("Loading connections took too long.").waitFor();
    assert.equal(await page.getByRole("heading", { name: "No connections yet" }).count(), 0, "a timeout never claims an empty list");
    await page.evaluate(() => (window as any).testShell.releaseConnections());
    await page.waitForTimeout(100);
    assert.equal(await page.getByRole("alert").getByText("Loading connections took too long.").count(), 1, "the late answer of the first call is dropped");
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await page.getByRole("heading", { name: "No connections yet" }).waitFor();
    assert.equal(await page.getByRole("alert").count(), 0);
  });
});

test("a pair_code that never answers unlocks the form with a timeout message and a cleared code; the retry works", async () => {
  await withShell(async page => {
    await page.addInitScript(() => { (window as any).__fixtureBoot = { deadlineMs: 300 }; });
    await page.reload();
    await page.getByRole("button", { name: "View connections" }).click();
    await page.getByRole("button", { name: "Add remote", exact: true }).click();
    await page.getByLabel("Name", { exact: true }).fill("Desk");
    await page.getByLabel("Harness origin").fill("https://harness.test");
    await page.getByLabel("First four characters").fill("ABCD");
    await page.getByLabel("Last four characters").fill("2345");
    await page.evaluate(() => (window as any).testShell.hold("pair"));
    const submit = page.getByRole("button", { name: "Pair harness", exact: true });
    await submit.click();
    await page.waitForFunction(() => (window as any).testShell.calls.pair === 1);
    assert.equal(await submit.isDisabled(), true, "locked while the call is pending");
    await page.locator(".pair-status").getByText("The harness took too long to answer", { exact: false }).waitFor({ timeout: 3000 });
    assert.equal(await submit.isDisabled(), false, "the form is usable again");
    assert.equal(await page.getByLabel("First four characters").inputValue(), "", "the possibly used one-time code is not offered again");
    // The first call answers late: it must not switch the view or pair a second time behind the person's back.
    await page.evaluate(() => (window as any).testShell.release("pair"));
    await page.waitForTimeout(100);
    assert.equal(await page.getByRole("heading", { name: "Desk" }).count(), 0);
    assert.equal(await page.evaluate(() => (window as any).testShell.calls.pair), 1);
    await page.getByLabel("First four characters").fill("EFGH");
    await page.getByLabel("Last four characters").fill("2345");
    await submit.click();
    await page.getByRole("heading", { name: "Desk" }).waitFor();
    assert.equal(await page.evaluate(() => (window as any).testShell.calls.pair), 2);
  });
});

test("a harness_logs_tail that never answers shows a loading state, then a timeout with a retry, and never freezes the runtime controls", async () => {
  await withShell(async page => {
    await page.addInitScript(() => { (window as any).__fixtureBoot = { bundled: true, deadlineMs: 400, runtimeLog: "container says hello" }; });
    await page.reload();
    await page.waitForTimeout(300);
    await page.evaluate(() => { const s = (window as any).testShell; s.navigate("settings", "runtime"); s.hold("logs"); });
    await page.getByRole("button", { name: "Show redacted logs" }).click();
    await page.getByRole("status").getByText("Loading logs…").waitFor();
    assert.equal(await page.getByRole("button", { name: "Recheck runtimes" }).isDisabled(), false, "other runtime controls stay usable while the tail is pending");
    await page.getByRole("alert").getByText("The logs took too long to load.").waitFor({ timeout: 3000 });
    assert.equal(await page.getByRole("status").getByText("Loading logs…").count(), 0);
    assert.equal(await page.getByRole("alert").getByText("The operation failed").count() + await page.getByText("The operation failed").count(), 0, "a slow tail is not reported as a harness state");
    await page.evaluate(() => (window as any).testShell.release("logs"));
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await page.locator(".runtime-log").getByText("container says hello").waitFor();
    assert.equal(await page.getByRole("alert").count(), 0);
  });
});
