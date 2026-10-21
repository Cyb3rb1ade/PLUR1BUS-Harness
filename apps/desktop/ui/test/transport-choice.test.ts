// Transport choice (spec §7, package T4) through the injected test transport: the required path, the check panel, the
// public banner and its confirmation, the confirm-needed open, *Weg ändern…*, the chips, and the a11y bar.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright";
import { withShell } from "./browser-harness.ts";
import { translate } from "../src/i18n.ts";

const remote = (id: string, origin: string, name = "Remote desk") => ({ id, name, kind: "remote", origin, installationId: "synthetic", deviceId: "synthetic", tokenHint: "hint", certPin: null, caPin: null, nextCertPin: null, nextCaPin: null, observedCertPin: null, pairingNeeded: false });
const shell = (page: Page) => ({
  calls: () => page.evaluate(() => (window as any).testShell.transportCalls()) as Promise<unknown[][]>,
  report: (host: string, report: unknown) => page.evaluate(([host, report]) => (window as any).testShell.setTransportReport(host, report), [host, report] as const),
});
const axe = (page: Page) => page.evaluate(async () => (await (window as any).axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } })).violations.map((v: any) => ({ id: v.id, targets: v.nodes.map((n: any) => n.target) })));
const shortTargets = (page: Page) => page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>("input,button")).filter(e => { const r = e.getBoundingClientRect(); return r.width && r.height < 44; }).map(e => e.id || e.textContent));

async function openAdd(page: Page, origin: string) {
  await page.getByRole("button", { name: "View connections" }).click();
  await page.getByRole("button", { name: "Add remote", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Desk");
  await page.getByLabel("Harness origin").fill(origin);
  await page.getByLabel("First four characters").fill("ABCD");
  await page.getByLabel("Last four characters").fill("2345");
}
const submit = (page: Page) => page.getByRole("button", { name: "Pair harness", exact: true });

test("the path is a required choice without preselection; the request carries it", async () => {
  await withShell(async page => {
    await openAdd(page, "https://harness.test");
    const group = page.getByRole("radiogroup", { name: "How do you reach this computer?" });
    await group.waitFor();
    assert.equal(await group.getByRole("radio").count(), 2);
    assert.equal(await page.getByRole("radio", { checked: true }).count(), 0, "no preselection (Q-T1)");
    assert.equal(await submit(page).isDisabled(), true);
    // The help text is the radio's description.
    const tailscale = page.getByRole("radio", { name: "Through Tailscale" });
    assert.equal(await tailscale.getAttribute("aria-describedby"), "pair-transport-tailscale-help");
    assert.equal(await page.locator("#pair-transport-tailscale-help").innerText(), "Both devices are in your tailnet.");
    await page.getByRole("radio", { name: "Direct" }).check();
    // The check runs after the debounce and reports in the live region.
    await page.waitForFunction(() => (window as any).testShell.transportCalls().some((c: unknown[]) => c[0] === "check"));
    assert.equal(await page.locator("#pair-transport-check").getAttribute("aria-live"), "polite");
    const check = (await shell(page).calls()).find(c => c[0] === "check")!;
    assert.deepEqual(check.slice(1), [{ kind: "origin", origin: "https://harness.test" }, "direct", "remote"]);
    await page.waitForFunction(() => !(document.querySelector("form button[type=submit]") as HTMLButtonElement).disabled);
    await submit(page).click();
    await page.getByRole("heading", { name: "Desk" }).waitFor();
    assert.deepEqual((await shell(page).calls()).find(c => c[0] === "pair"), ["pair", "direct", false]);
  });
});

test("a public origin shows the banner once; the confirmation gates submit and travels with the pairing", async () => {
  await withShell(async page => {
    await openAdd(page, "https://public.harness.test");
    await page.getByRole("radio", { name: "Direct" }).check();
    const alert = page.getByRole("alert", { name: "Public address" });
    await alert.waitFor();
    assert.equal(await page.getByRole("alert").count(), 1);
    assert.match(await alert.innerText(), /public\.harness\.test points to an address on the public internet \(9\.9\.9\.9\)\. The harness should never be reachable from the internet\./);
    assert.equal(await submit(page).isDisabled(), true);
    const confirm = page.getByRole("checkbox", { name: "I know this target is on the internet and want to connect directly anyway." });
    await confirm.check();
    assert.equal(await submit(page).isDisabled(), false);
    // A late shell re-render keeps the choice, the confirmation and does not announce the banner again.
    await page.evaluate(() => (window as any).testShell.refreshConnections());
    assert.equal(await page.getByRole("radio", { name: "Direct" }).isChecked(), true);
    assert.equal(await confirm.isChecked(), true);
    assert.equal(await page.getByRole("alert").count(), 0);
    assert.equal(await page.getByRole("region", { name: "Public address" }).count(), 1);
    await submit(page).click();
    await page.getByRole("heading", { name: "Desk" }).waitFor();
    assert.deepEqual((await shell(page).calls()).filter(c => c[0] === "pair"), [["pair", "direct", true]]);
  });
});

test("Rust's refusal of an unconfirmed public pairing keeps the code and leads to the confirmation", async () => {
  await withShell(async page => {
    await openAdd(page, "https://public.harness.test");
    await page.evaluate(() => (window as any).testShell.hold("check"));
    await page.getByRole("radio", { name: "Direct" }).check();
    await submit(page).click();
    await page.getByText("Public address", { exact: true }).first().waitFor();
    assert.equal(await page.getByLabel("First four characters").inputValue(), "ABCD");
    await page.evaluate(() => (window as any).testShell.release("check"));
    await page.getByRole("checkbox", { name: /I know this target/ }).check();
    await submit(page).click();
    await page.getByRole("heading", { name: "Desk" }).waitFor();
    assert.deepEqual((await shell(page).calls()).filter(c => c[0] === "pair").map(c => c[2]), [false, true]);
  });
});

test("the alternative switches to Tailscale; mixed and SSH texts", async () => {
  await withShell(async page => {
    await openAdd(page, "https://mixed.harness.test");
    await page.getByRole("radio", { name: "Direct" }).check();
    const alert = page.getByRole("alert", { name: "Public address" });
    await alert.waitFor();
    assert.match(await alert.innerText(), /mixed\.harness\.test has both private and public addresses, so the app treats it as public\./);
    await page.getByRole("button", { name: "Connect through Tailscale instead", exact: true }).click();
    assert.equal(await page.getByRole("radio", { name: "Through Tailscale" }).isChecked(), true);
    await page.waitForFunction(() => (window as any).testShell.transportCalls().some((c: unknown[]) => c[0] === "check" && c[2] === "tailscale"));
    for (const [purpose, locale, text] of [
      ["ssh", "en", "public.harness.test points to an address on the public internet (9.9.9.9). SSH servers on the internet are attacked all the time."],
      ["ssh-jump", "de", "public.harness.test zeigt auf eine Adresse im öffentlichen Internet (9.9.9.9). SSH-Zugänge im Internet werden ständig angegriffen."],
    ] as const) {
      await page.evaluate(([purpose, locale]) => (window as any).testShell.showTransportChoice(purpose, "public.harness.test", locale), [purpose, locale] as const);
      await page.getByRole("radio", { name: locale === "de" ? "Direkt" : "Direct" }).check();
      await page.getByRole("alert").waitFor();
      assert.ok((await page.getByRole("alert").innerText()).includes(text), purpose);
    }
    // Session-only confirmation while the store cannot persist.
    await page.evaluate(() => (window as any).testShell.showTransportChoice("ssh", "public.harness.test", "en", true));
    await page.getByRole("radio", { name: "Direct" }).check();
    await page.getByText("This confirmation lasts only until you quit the app, because path settings cannot be saved right now.").waitFor();
  });
});

test("Tailscale notices of every state appear in the check panel", async () => {
  await withShell(async page => {
    const states: [string, Record<string, string>][] = [
      ["tailscale-ok", { peer: "nas" }], ["tailscale-self", {}], ["tailscale-subnet-route", { peer: "router" }],
      ["tailscale-not-installed", {}], ["tailscale-check-unavailable", {}], ["tailscale-check-unavailable", { note: "flatpak" }],
      ["tailscale-daemon-down", {}], ["tailscale-needs-login", {}], ["tailscale-stopped", {}],
      ["tailscale-peer-unknown", { host: "100.70.0.1", note: "cgnat" }], ["tailscale-peer-offline", { peer: "nas" }],
      ["tailscale-unreachable", { peer: "nas", port: "22" }], ["tailscale-route-mismatch", { host: "nas.example" }],
      ["tailscale-not-tailnet-target", { host: "nas.example" }], ["tailscale-short-name", { suggestion: "nas.example.ts.net" }],
    ];
    for (const locale of ["en", "de"] as const) for (const [code, params] of states) {
      const severity = ["tailscale-ok", "tailscale-self", "tailscale-short-name"].includes(code) ? "info" : "notice";
      await shell(page).report("ts.harness.test", { category: "tailnet", addresses: ["100.101.102.103"], hints: [{ code, severity, params }], tailscale: { state: code, peer: params.peer ?? null, online: null }, needsPublicAck: false, classifier: "iana-special-2025-10-09" });
      await page.evaluate(locale => (window as any).testShell.showTransportChoice("remote", "ts.harness.test", locale), locale);
      await page.getByRole("radio", { name: locale === "de" ? "Über Tailscale" : "Through Tailscale" }).check();
      const key = code === "tailscale-check-unavailable" && params.note === "flatpak" ? "transport.tailscale.check-unavailable.flatpak" : `transport.${code.replace("tailscale-", "tailscale.")}`;
      const expected = translate(locale, key as any, params);
      await page.getByRole("status").filter({ hasText: expected }).waitFor({ timeout: 5000 });
      if (params.note === "cgnat") await page.getByText(translate(locale, "transport.tailscale.peer-unknown.cgnat")).waitFor();
    }
    // The peer-online state has no hint: a neutral line, no claim of reachability.
    await shell(page).report("ts.harness.test", { category: "tailnet", addresses: ["100.101.102.103"], hints: [], tailscale: { state: "tailscale-peer-online", peer: "nas", online: true }, needsPublicAck: false, classifier: "iana-special-2025-10-09" });
    await page.evaluate(() => (window as any).testShell.showTransportChoice("remote", "ts.harness.test", "en"));
    await page.getByRole("radio", { name: "Through Tailscale" }).check();
    await page.getByText("nas is in your tailnet and online; the path was not checked.").waitFor();
    // A refusal from the check.
    await page.evaluate(() => (window as any).testShell.setTransportCheckError("host-invalid"));
    await page.evaluate(() => (window as any).testShell.showTransportChoice("remote", "bad", "de"));
    await page.getByRole("radio", { name: "Direkt" }).check();
    await page.getByText("Das ist weder ein gültiger Rechnername noch eine IP-Adresse.").waitFor();
  });
});

test("opening a public connection without confirmation shows the reason and confirms explicitly", async () => {
  await withShell(async page => {
    await page.addInitScript(rows => { (window as any).__fixtureBoot = { rows }; }, [remote("pub", "https://public.harness.test")]);
    await page.reload();
    await page.getByRole("button", { name: "View connections" }).click();
    await page.getByRole("heading", { name: "Remote desk" }).waitFor();
    assert.equal(await page.getByText("Path: Direct", { exact: true }).count(), 1);
    await page.getByRole("button", { name: "Open", exact: true }).click();
    const alert = page.getByRole("alert", { name: "Public address" });
    await alert.waitFor();
    await alert.getByText(/public\.harness\.test points to an address on the public internet/).waitFor();
    assert.equal(await page.getByText("Connection verified and selected.", { exact: false }).count(), 0);
    assert.deepEqual((await shell(page).calls()).map(c => c[0]), ["open", "check"]);
    // *Abbrechen* leaves it; *Bestätigen und verbinden* stores the confirmation, then opens.
    await alert.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal(await page.getByRole("alert").count(), 0);
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await page.getByRole("button", { name: "Confirm and connect", exact: true }).click();
    await page.getByText("Connection verified and selected.", { exact: false }).waitFor();
    assert.deepEqual((await shell(page).calls()).filter(c => c[0] === "set"), [["set", "pub", "direct", true]]);
    assert.deepEqual((await shell(page).calls()).filter(c => c[0] === "open").length, 3);
    // Chips with text, warning tone and words: never colour alone.
    await page.getByText("Path: Direct · public, confirmed", { exact: true }).waitFor();
    await page.setViewportSize({ width: 1700, height: 900 });
    const chip = page.locator(".connections-side .chip-warning");
    assert.equal(await chip.innerText(), "Direct · public");
  });
});

test("a reconnect that stopped for a changed address asks again; the store notice and session text", async () => {
  await withShell(async page => {
    await page.addInitScript(rows => { (window as any).__fixtureBoot = { rows }; }, [remote("lan", "https://nas.harness.test")]);
    await page.reload();
    await page.evaluate(() => (window as any).testShell.setTransportStoreReadOnly(true));
    await page.evaluate(() => (window as any).testShell.refreshConnections());
    await page.getByRole("button", { name: "View connections" }).click();
    await page.getByRole("heading", { name: "Remote desk" }).waitFor();
    await page.getByText("Path settings come from a newer app version and are left unchanged.").waitFor();
    await page.evaluate(() => (window as any).testShell.setTransportReport("nas.harness.test", { category: "public", addresses: ["9.9.9.9"], hints: [{ code: "target-changed-public", severity: "warning", params: { host: "nas.harness.test", addresses: "9.9.9.9" } }], tailscale: null, needsPublicAck: true, classifier: "iana-special-2025-10-09" }));
    await page.evaluate(() => (window as any).testShell.fireAttention("lan", "target-changed-public"));
    const alert = page.getByRole("alert", { name: "Public address" });
    await alert.getByText("The address of nas.harness.test has changed and is now public. Confirm this before the app connects.").waitFor();
    await alert.getByText("This confirmation lasts only until you quit the app, because path settings cannot be saved right now.").waitFor();
  });
});

test("Weg ändern… changes the path in a dialog; a Tailscale notice gets a chip and a page notice", async () => {
  await withShell(async page => {
    await page.addInitScript(rows => { (window as any).__fixtureBoot = { rows }; }, [remote("ts", "https://nas.example.ts.net")]);
    await page.reload();
    await page.evaluate(() => (window as any).testShell.setTransportReport("nas.example.ts.net", { category: "tailnet", addresses: ["100.101.102.103"], hints: [{ code: "tailscale-stopped", severity: "notice", params: {} }], tailscale: { state: "tailscale-stopped", peer: null, online: null }, needsPublicAck: false, classifier: "iana-special-2025-10-09" }));
    await page.getByRole("button", { name: "View connections" }).click();
    await page.getByRole("button", { name: "Change path…", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Change path…" });
    await dialog.waitFor();
    assert.equal(await dialog.getByRole("radio", { name: "Direct" }).isChecked(), true, "the current path is preselected in a change");
    await dialog.getByRole("radio", { name: "Through Tailscale" }).check();
    await dialog.getByText("Tailscale is disconnected. Connect in the Tailscale app.").waitFor();
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByText("Path: Tailscale", { exact: true }).waitFor();
    assert.deepEqual((await shell(page).calls()).filter(c => c[0] === "set"), [["set", "ts", "tailscale", false]]);
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await page.getByText("Tailscale is disconnected. Connect in the Tailscale app.").waitFor();
    await page.getByText("Tailscale disconnected", { exact: true }).first().waitFor();
  });
});

test("transport states pass axe, 44 px targets and 400 px in DE/EN light/dark, keyboard only", async () => {
  await withShell(async page => {
    await page.addInitScript(rows => { (window as any).__fixtureBoot = { rows }; }, [remote("pub", "https://public.harness.test")]);
    await page.reload();
    await page.addScriptTag({ url: "/axe.js" });
    for (const theme of ["light", "dark"]) for (const locale of ["en", "de"] as const) {
      const t = (key: string) => translate(locale, key as any);
      await page.evaluate(prefs => (window as any).testShell.setPreferences(prefs), { theme, locale });
      await page.evaluate(() => (window as any).testShell.navigate("connections"));
      await page.setViewportSize({ width: 400, height: 900 });
      // Add form with a public banner, reached by keyboard: Tab into the group, arrows choose, Space ticks.
      await page.getByRole("button", { name: t("pair.add"), exact: true }).click();
      await page.getByLabel(t("pair.name"), { exact: true }).fill("Desk");
      await page.getByLabel(t("pair.origin")).fill("https://public.harness.test");
      await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(() => (document.activeElement as HTMLInputElement).name), "pair-transport-transport");
      await page.keyboard.press("ArrowDown");
      await page.getByRole("alert", { name: t("transport.public.title") }).waitFor();
      assert.equal(await page.getByRole("radio", { name: t("transport.direct") }).isChecked(), true);
      const violations = await axe(page);
      assert.deepEqual(violations, [], `add ${theme}/${locale}`);
      assert.deepEqual(await shortTargets(page), [], `add ${theme}/${locale}`);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
      await page.locator("#pair-transport-public-ack").focus();
      await page.keyboard.press("Space");
      assert.equal(await page.locator("#pair-transport-public-ack").isChecked(), true);
      await page.getByRole("button", { name: t("pair.cancel"), exact: true }).first().click();
      // Confirm-needed state on open.
      await page.getByRole("button", { name: t("connections.open"), exact: true }).click();
      await page.getByRole("button", { name: t("transport.confirm-connect"), exact: true }).waitFor();
      assert.deepEqual(await axe(page), [], `confirm ${theme}/${locale}`);
      assert.deepEqual(await shortTargets(page), [], `confirm ${theme}/${locale}`);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
      // The change dialog.
      await page.getByRole("button", { name: t("transport.change"), exact: true }).first().click();
      await page.getByRole("dialog", { name: t("transport.change") }).waitFor();
      await page.getByRole("dialog").getByText(t("transport.public.title"), { exact: true }).waitFor();
      assert.deepEqual(await axe(page), [], `change ${theme}/${locale}`);
      assert.deepEqual(await shortTargets(page), [], `change ${theme}/${locale}`);
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: t("pair.cancel"), exact: true }).first().click();
    }
  });
});

test("a remote connection is added and opened with each path", async () => {
  for (const [label, path, chipText] of [["Through Tailscale", "tailscale", "Tailscale"], ["Direct", "direct", "Direct"]] as const) {
    await withShell(async page => {
      await openAdd(page, "https://harness.test");
      await page.getByRole("radio", { name: label }).check();
      await page.waitForFunction(() => !(document.querySelector("form button[type=submit]") as HTMLButtonElement).disabled);
      await submit(page).click();
      await page.getByRole("heading", { name: "Desk" }).waitFor();
      await page.getByText(`Path: ${chipText}`, { exact: true }).waitFor();
      await page.getByRole("button", { name: "Open", exact: true }).click();
      await page.getByText("Connection verified and selected.", { exact: false }).waitFor();
      assert.equal(await page.locator(".connections-side .chip", { hasText: chipText }).count(), 1);
      assert.deepEqual((await shell(page).calls()).filter(c => c[0] === "pair" || c[0] === "open").map(c => c[0] === "pair" ? c[1] : "open"), [path, "open"]);
    });
  }
});
