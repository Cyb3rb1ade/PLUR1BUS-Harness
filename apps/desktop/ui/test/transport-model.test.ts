import { test } from "node:test";
import assert from "node:assert/strict";
import en from "../src/i18n/en.json" with { type: "json" };
import de from "../src/i18n/de.json" with { type: "json" };
import type { TransportHint, TransportReport } from "../src/ipc.ts";
import { createTransportModel, errorLine, hintLines, noticeLines, originHost, publicLines, tailscaleNotice, type Timers } from "../src/models/transport-model.ts";
import { translate } from "../src/i18n.ts";

const report = (hints: TransportHint[], extra: Partial<TransportReport> = {}): TransportReport => ({ category: "private", addresses: [], hints, tailscale: null, needsPublicAck: false, classifier: "iana-special-2025-10-09", ...extra });
const hint = (code: string, params: Record<string, string> = {}, severity: TransportHint["severity"] = "notice"): TransportHint => ({ code, severity, params });

/** Spec §5.3: every Tailscale state with a hint, and the text it shows. */
const states: [string, string, Record<string, string>][] = [
  ["tailscale-ok", "Reachable through Tailscale: nas.", { peer: "nas" }],
  ["tailscale-self", "This is this computer.", {}],
  ["tailscale-subnet-route", "Reachable through router's subnet route.", { peer: "router" }],
  ["tailscale-not-installed", "Tailscale is not installed on this computer (tailscale.com/download).", {}],
  ["tailscale-check-unavailable", "Tailscale could not be checked.", {}],
  ["tailscale-daemon-down", "Tailscale is not running on this computer. Start the Tailscale app.", {}],
  ["tailscale-needs-login", "Tailscale is not signed in. Sign in in the Tailscale app.", {}],
  ["tailscale-stopped", "Tailscale is disconnected. Connect in the Tailscale app.", {}],
  ["tailscale-peer-unknown", "nas.example is not a device in your tailnet.", { host: "nas.example" }],
  ["tailscale-peer-offline", "nas is in your tailnet but offline right now.", { peer: "nas" }],
  ["tailscale-unreachable", "nas is online but does not answer on port 443.", { peer: "nas", port: "443" }],
  ["tailscale-route-mismatch", "The connection to nas.example does not go through Tailscale. Check subnet routes and other VPNs.", { host: "nas.example" }],
  ["tailscale-not-tailnet-target", "nas.example is not a Tailscale address. Choose “Direct” or enter the Tailscale name (for example computer.tailnet.ts.net).", { host: "nas.example" }],
  ["tailscale-short-name", "HTTPS needs the full name (nas.example.ts.net).", { suggestion: "nas.example.ts.net" }],
];

test("every Tailscale state of spec §5.3 maps to its §7.2 text, variants by note", () => {
  for (const [code, text, params] of states) {
    const lines = hintLines(hint(code, params))!;
    assert.equal(lines.map(line => translate("en", line.key, line.values)).join(" "), text, code);
  }
  assert.deepEqual(hintLines(hint("tailscale-check-unavailable", { note: "flatpak" }))!.map(l => l.key), ["transport.tailscale.check-unavailable.flatpak"]);
  assert.deepEqual(hintLines(hint("tailscale-peer-unknown", { host: "100.70.0.1", note: "cgnat" }))!.map(l => l.key), ["transport.tailscale.peer-unknown", "transport.tailscale.peer-unknown.cgnat"]);
  // `tailscale-peer-online` is a state without a hint: its own neutral line, which claims no reachability.
  const online = report([], { category: "tailnet", tailscale: { state: "tailscale-peer-online", peer: "nas", online: true } });
  assert.deepEqual(noticeLines(online).map(l => translate("en", l.key, l.values)), ["nas is in your tailnet and online; the path was not checked."]);
  assert.deepEqual(noticeLines(online).map(l => translate("de", l.key, l.values)), ["nas ist in deinem Tailnet und online; der Weg wurde nicht geprüft."]);
  // A code this shell does not know is never shown raw.
  assert.equal(hintLines(hint("tailscale-from-the-future")), null);
  assert.deepEqual(noticeLines(report([hint("tailscale-from-the-future")])), []);
});

test("the public banner picks the purpose text, the mixed note and the changed text", () => {
  const params = { host: "harness.example", addresses: "9.9.9.9" };
  const pub = report([hint("target-public", params, "warning")], { category: "public", needsPublicAck: true });
  assert.deepEqual(publicLines(pub, "remote").map(l => l.key), ["transport.public.remote"]);
  assert.deepEqual(publicLines(pub, "ssh").map(l => l.key), ["transport.public.ssh"]);
  assert.deepEqual(publicLines(pub, "ssh-jump").map(l => l.key), ["transport.public.ssh"]);
  const mixed = report([hint("target-mixed", params, "warning")], { category: "public", needsPublicAck: true });
  assert.deepEqual(publicLines(mixed, "remote").map(l => l.key), ["transport.public.remote", "transport.public.mixed"]);
  const changed = report([hint("target-changed-public", params, "warning")], { category: "public", needsPublicAck: true });
  assert.deepEqual(publicLines(changed, "remote").map(l => translate("de", l.key, l.values)), ["Die Adresse von harness.example hat sich geändert und ist jetzt öffentlich. Bestätige das, bevor die App verbindet."]);
  assert.match(translate("en", publicLines(pub, "remote")[0]!.key, params), /^harness\.example points to an address on the public internet \(9\.9\.9\.9\)\./);
  // The public warning is the banner, not a panel notice.
  assert.deepEqual(noticeLines(mixed), []);
});

test("refusals and target notices have texts; Tailscale notices drive the chip", () => {
  assert.equal(translate("en", errorLine("host-invalid", "x")!.key), "This is neither a valid host name nor an IP address.");
  assert.equal(translate("de", errorLine("host-ipv4-noncanonical", "x")!.key), "Schreibe die IPv4-Adresse in der Form a.b.c.d.");
  const unresolved = errorLine("target-unresolved", "nas.corp")!;
  assert.equal(translate("en", unresolved.key, unresolved.values), "nas.corp cannot be resolved. Are you on the right network or VPN?");
  const none = errorLine("target-not-connectable", "0.0.0.0")!;
  assert.equal(translate("en", none.key, none.values), "0.0.0.0 is not a destination address.");
  assert.equal(errorLine("network", "x"), null);
  assert.equal(translate("en", hintLines(hint("target-special", { address: "192.0.2.1" }))![0]!.key, { address: "192.0.2.1" }), "192.0.2.1 is a special-purpose address (for example for documentation or testing) and is not reachable on the internet.");
  assert.equal(tailscaleNotice(report([hint("tailscale-stopped")])), true);
  assert.equal(tailscaleNotice(report([hint("tailscale-ok", {}, "info")])), false);
  assert.equal(tailscaleNotice(null), false);
  assert.equal(originHost("https://[fd7a:115c:a1e0::65]:8443"), "fd7a:115c:a1e0::65");
});

test("every transport key of spec §7.2 is in both catalogues", () => {
  const keys = ["question", "tailscale", "tailscale.help", "direct", "direct.help", "checking", "check", "public.title", "public.remote", "public.ssh", "public.mixed", "public.confirm", "public.changed", "public.alt", "special", "error.target-not-connectable", "error.host-ipv4-noncanonical", "error.host-invalid", "public.session", "unresolved", "dns-timeout", "via-jump", "tailscale.ok", "tailscale.self", "tailscale.subnet-route", "tailscale.not-installed", "tailscale.check-unavailable", "tailscale.check-unavailable.flatpak", "tailscale.daemon-down", "tailscale.needs-login", "tailscale.stopped", "tailscale.peer-unknown", "tailscale.peer-unknown.cgnat", "tailscale.peer-offline", "tailscale.unreachable", "tailscale.route-mismatch", "tailscale.not-tailnet-target", "tailscale.short-name", "range.public", "store.newer", "path.tailscale", "path.direct", "path.public"].map(k => `transport.${k}`);
  for (const key of keys) {
    assert.ok((en as Record<string, string>)[key], `en ${key}`);
    assert.ok((de as Record<string, string>)[key], `de ${key}`);
  }
  assert.equal((de as Record<string, string>)["transport.direct.help"], "Über dein LAN, VPN oder Firmennetz – per SSH oder HTTPS.");
  assert.equal((en as Record<string, string>)["transport.public.session"], "This confirmation lasts only until you quit the app, because path settings cannot be saved right now.");
});

/** Manual timers: `fire()` runs what is due. */
function manualTimers() {
  let next = 0;
  const due = new Map<number, () => void>();
  const timers: Timers = { set: run => { due.set(++next, run); return next; }, clear: handle => { due.delete(handle as number); } };
  return { timers, pending: () => due.size, fire: () => { const runs = [...due.values()]; due.clear(); runs.forEach(run => run()); } };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test("the model checks once after the debounce, supersedes older requests and clears the confirmation on change", async () => {
  const calls: unknown[][] = [];
  const answers: Array<(value: TransportReport) => void> = [];
  const failures: Array<(error: unknown) => void> = [];
  const clock = manualTimers();
  const model = createTransportModel((target, transport, purpose) => { calls.push([target, transport, purpose]); return new Promise((resolve, reject) => { answers.push(resolve); failures.push(reject); }); }, "remote", clock.timers);
  assert.equal(model.ready(), false);
  model.setTarget({ kind: "origin", origin: "https://a.example" }, "a.example");
  assert.equal(clock.pending(), 0, "no check without a path");
  model.setTransport("direct");
  assert.equal(model.state.status, "waiting");
  // Typing on: only the last input is checked.
  model.setTarget({ kind: "origin", origin: "https://ab.example" }, "ab.example");
  assert.equal(clock.pending(), 1);
  clock.fire();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [{ kind: "origin", origin: "https://ab.example" }, "direct", "remote"]);
  assert.equal(model.state.status, "checking");
  // A newer input while the check runs: the late answer of the older one is dropped.
  model.setTarget({ kind: "origin", origin: "https://abc.example" }, "abc.example");
  answers[0]!(report([hint("target-public", {}, "warning")], { category: "public", needsPublicAck: true }));
  await tick();
  assert.equal(model.state.report, null);
  clock.fire();
  assert.equal(calls.length, 2);
  answers[1]!(report([hint("target-public", {}, "warning")], { category: "public", needsPublicAck: true }));
  await tick();
  assert.equal(model.state.status, "done");
  assert.equal(model.confirmMissing(), true);
  assert.equal(model.ready(), false, "a public target waits for the confirmation");
  model.setAck(true);
  assert.equal(model.ready(), true);
  // A path change clears the confirmation, as Rust does.
  model.setTransport("tailscale");
  assert.equal(model.state.ack, false);
  clock.fire();
  // The shell's answer for a superseded check (`transport-check-busy`) is ignored.
  failures[2]!("transport-check-busy");
  await tick();
  assert.equal(model.state.status, "checking");
  model.checkNow();
  clock.fire();
  failures[3]!("host-invalid");
  await tick();
  assert.equal(model.state.status, "error");
  assert.equal(model.state.error, "host-invalid");
  model.reset();
  assert.equal(model.state.transport, null);
  assert.equal(model.ready(), false);
});

test("without a check binding the model still requires a path", () => {
  const model = createTransportModel(undefined, "remote", manualTimers().timers);
  model.setTarget({ kind: "origin", origin: "https://a.example" }, "a.example");
  model.setTransport("direct");
  assert.equal(model.state.status, "idle");
  assert.equal(model.ready(), true);
});
