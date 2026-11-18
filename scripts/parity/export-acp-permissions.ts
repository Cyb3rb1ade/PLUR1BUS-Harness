// Permission requests of the ACP server (P4-K K8): the agent asks the client, only a matching reply with an offered option
// selects, and everything else (malformed reply, timeout, cancel, close, capacity) cancels. Fail closed.
import { INIT, NEW, ev, ins, line, nf, rq, simple, textPrompt, uuids, type Scenario } from "./export-acp-support.ts";

const S = (name: string, events: unknown[], backend: any, extra: Record<string, unknown> = {}): Scenario => ({ name, backend, events, ids: uuids(100), ...extra });
const hello = [INIT, NEW(2)];
const opt = (optionId: string, kind = "allow_once", name: string | undefined = optionId.toUpperCase()) => ({ optionId, ...(name !== undefined ? { name } : {}), kind });
const OPTS = [opt("a", "allow_once", "Allow"), opt("r", "reject_once", "Reject")];
const askJson = (options: unknown[] = OPTS, toolCall: unknown = { toolCallId: "t1", title: "Run it" }) => JSON.stringify({ toolCall, options });
const perm = (tag: string, options?: unknown[], toolCall?: unknown) => ({ permission: { tag, askJson: askJson(options, toolCall) } });
const spawn = (tag: string, options?: unknown[]) => ({ spawnPermission: { tag, askJson: askJson(options) } });
const pid = (k: number) => `acp-permission-${uuids(k)[k - 1]}`;
const reply = (k: number, result: unknown) => line({ jsonrpc: "2.0", id: pid(k), result });
const pick = (k: number, optionId: unknown) => reply(k, { outcome: { outcome: "selected", optionId } });
const start = (...backendOps: any[]) => [...ins(...hello), ev.in(textPrompt(3, "s1", "go"))].concat(backendOps.length ? [] : []);
const turn = (ops: any[], extra: any = {}) => simple([ops], extra);

export function buildPermissions(): Scenario[] {
  const out: Scenario[] = [];
  const base = start();

  // --- a matching reply
  out.push(S("select-an-offered-option", [...base, ev.in(pick(1, "a"))], turn([perm("p"), { text: "after" }])));
  out.push(S("select-the-reject-option", [...base, ev.in(pick(1, "r"))], turn([perm("p"), { text: "after" }])));
  out.push(S("every-kind-is-accepted", [...base, ev.in(pick(1, "k4")), ev.in(pick(2, "k1")), ev.in(pick(3, "k3")), ev.in(pick(4, "k2"))],
    turn([perm("p1", [opt("k1", "allow_once")]), perm("p2", [opt("k2", "allow_always")]), perm("p3", [opt("k3", "reject_once")]), perm("p4", [opt("k4", "reject_always")])])));
  out.push(S("select-an-option-that-was-not-offered", [...base, ev.in(pick(1, "zzz"))], turn([perm("p"), { text: "after" }])));
  out.push(S("select-an-option-of-another-ask", [...base, ev.in(pick(1, "b"))], turn([perm("p"), { text: "after" }])));
  out.push(S("select-with-the-wrong-case-or-padding", [...base, ev.in(pick(1, "A")), ev.in(pick(2, " a"))], turn([perm("p1"), perm("p2")])));
  out.push(S("a-second-reply-has-no-effect", [...base, ev.in(pick(1, "a")), ev.in(pick(1, "r")), ev.in(pick(1, "a"))], turn([perm("p"), { text: "after" }])));
  out.push(S("a-reply-to-another-id-has-no-effect", [...base, ev.in(line({ jsonrpc: "2.0", id: "acp-permission-nope", result: { outcome: { outcome: "selected", optionId: "a" } } })), ev.in(pick(2, "a")), ev.in(pick(1, "a"))], turn([perm("p"), { text: "after" }])));
  out.push(S("replies-for-ids-never-issued", ins(...hello, textPrompt(3, "s1", "x"), line({ jsonrpc: "2.0", id: "acp-permission-1", result: {} }), line({ jsonrpc: "2.0", id: 1, result: {} }), line({ jsonrpc: "2.0", id: pid(1), result: { outcome: { outcome: "selected", optionId: "a" } } })), turn([{ text: "x" }])));

  // --- malformed replies cancel
  const bad: Array<[string, string]> = [
    ["error-member", line({ jsonrpc: "2.0", id: pid(1), error: { code: -1, message: "no" } })],
    ["error-and-result", line({ jsonrpc: "2.0", id: pid(1), error: { code: -1, message: "no" }, result: { outcome: { outcome: "selected", optionId: "a" } } })],
    ["error-null", line({ jsonrpc: "2.0", id: pid(1), error: null, result: { outcome: { outcome: "selected", optionId: "a" } } })],
    ["no-result", line({ jsonrpc: "2.0", id: pid(1) })],
    ["result-null", line({ jsonrpc: "2.0", id: pid(1), result: null })],
    ["result-array", line({ jsonrpc: "2.0", id: pid(1), result: [{ outcome: "selected", optionId: "a" }] })],
    ["result-string", line({ jsonrpc: "2.0", id: pid(1), result: "selected" })],
    ["outcome-missing", line({ jsonrpc: "2.0", id: pid(1), result: {} })],
    ["outcome-string", line({ jsonrpc: "2.0", id: pid(1), result: { outcome: "selected", optionId: "a" } })],
    ["outcome-array", line({ jsonrpc: "2.0", id: pid(1), result: { outcome: [{ outcome: "selected", optionId: "a" }] } })],
    ["outcome-cancelled", line({ jsonrpc: "2.0", id: pid(1), result: { outcome: { outcome: "cancelled" } } })],
    ["outcome-unknown", line({ jsonrpc: "2.0", id: pid(1), result: { outcome: { outcome: "allow", optionId: "a" } } })],
    ["outcome-wrong-case", line({ jsonrpc: "2.0", id: pid(1), result: { outcome: { outcome: "Selected", optionId: "a" } } })],
    ["option-missing", line({ jsonrpc: "2.0", id: pid(1), result: { outcome: { outcome: "selected" } } })],
    ["option-number", line({ jsonrpc: "2.0", id: pid(1), result: { outcome: { outcome: "selected", optionId: 1 } } })],
    ["option-null", line({ jsonrpc: "2.0", id: pid(1), result: { outcome: { outcome: "selected", optionId: null } } })],
    ["option-array", line({ jsonrpc: "2.0", id: pid(1), result: { outcome: { outcome: "selected", optionId: ["a"] } } })],
    ["option-object", line({ jsonrpc: "2.0", id: pid(1), result: { outcome: { outcome: "selected", optionId: { a: 1 } } } })],
    ["option-empty", line({ jsonrpc: "2.0", id: pid(1), result: { outcome: { outcome: "selected", optionId: "" } } })],
    ["option-name-not-id", line({ jsonrpc: "2.0", id: pid(1), result: { outcome: { outcome: "selected", optionId: "Allow" } } })],
  ];
  for (const [n, l] of bad) out.push(S(`malformed-reply-${n}`, [...base, ev.in(l), ev.in(pick(1, "a"))], turn([perm("p"), { text: "after" }])));
  out.push(S("reply-with-a-method-is-a-request-not-a-reply", [...base, ev.in(line({ jsonrpc: "2.0", id: pid(1), method: "x", result: { outcome: { outcome: "selected", optionId: "a" } } })), ev.in(pick(1, "a"))], turn([perm("p"), { text: "after" }])));
  out.push(S("reply-with-the-wrong-version-is-ignored", [...base, ev.in(line({ jsonrpc: "1.0", id: pid(1), result: { outcome: { outcome: "selected", optionId: "a" } } })), ev.in(line({ id: pid(1), result: { outcome: { outcome: "selected", optionId: "a" } } })), ev.in(line({ jsonrpc: 2, id: pid(1), result: {} })), ev.in(pick(1, "a"))], turn([perm("p"), { text: "after" }])));
  out.push(S("reply-with-a-non-string-id-is-ignored", [...base, ev.in(line({ jsonrpc: "2.0", id: [pid(1)], result: { outcome: { outcome: "selected", optionId: "a" } } })), ev.in(line({ jsonrpc: "2.0", id: { toString: pid(1) }, result: {} })), ev.in(pick(1, "a"))], turn([perm("p"), { text: "after" }])));
  out.push(S("reply-with-extra-members-still-selects", [...base, ev.in(line({ jsonrpc: "2.0", id: pid(1), extra: 1, result: { more: 1, outcome: { outcome: "selected", optionId: "a", x: 1 } } }))], turn([perm("p"), { text: "after" }])));

  // --- the request that is sent
  out.push(S("request-shape-and-option-names", [...base, ev.in(pick(1, "a"))], turn([perm("p", [opt("a", "allow_once", undefined), opt("b", "allow_always", ""), opt("c", "reject_once", "é "), opt("d", "reject_always", "x".repeat(300))])])));
  out.push(S("request-tool-call-forms", [...base, ev.in(pick(1, "a")), ev.in(pick(2, "a")), ev.in(pick(3, "a")), ev.in(pick(4, "a")), ev.in(pick(5, "a"))],
    turn([perm("p1", OPTS, "text"), perm("p2", OPTS, [1, 2]), perm("p3", OPTS, null), perm("p4", OPTS, { z: 1, a: [1.5, 1e21, -0], "2": 1, "1": 2, é: "\u0000퟿" }), perm("p5", OPTS, {})])));
  const o8 = Array.from({ length: 8 }, (_, i) => opt(`o${i}`));
  const invalid: Array<[string, unknown[]]> = [
    ["no-options", []], ["nine-options", [...o8, opt("o8")]], ["eight-options", o8], ["duplicate-ids", [opt("a"), opt("a", "reject_once")]], ["empty-id", [opt("")]],
    ["unknown-kind", [opt("a", "allow")]], ["kind-wrong-case", [opt("a", "Allow_once")]], ["kind-missing", [{ optionId: "a", name: "A" }]], ["kind-number", [{ optionId: "a", kind: 1 }]],
    ["id-missing", [{ name: "A", kind: "allow_once" }]], ["id-null", [{ optionId: null, kind: "allow_once" }]],
    ["ids-differ-by-case", [opt("a"), opt("A")]], ["one-bad-among-good", [opt("a"), opt("b", "nope")]],
  ];
  for (const [n, o] of invalid) out.push(S(`options-${n}`, [...base, ev.in(pick(1, "a")), ev.in(pick(1, "o0"))], turn([perm("p", o), { text: "after" }])));
  out.push(S("ask-needs-no-reply-when-refused", [...base], turn([perm("p", []), perm("q", [opt("a", "x")]), { text: "after" }])));

  // --- timeout, cancel and close
  out.push(S("timeout-after-five-minutes", [...base, ev.adv(299999), ev.in(pick(1, "a"))], turn([perm("p"), { text: "after" }])));
  out.push(S("timeout-fires-at-the-limit", [...base, ev.adv(299999), ev.adv(1), ev.in(pick(1, "a"))], turn([perm("p"), { text: "after" }])));
  out.push(S("timeout-of-a-later-request-counts-from-its-start", [...base, ev.adv(200000), ev.in(pick(1, "a")), ev.adv(200000), ev.adv(100000)], turn([perm("p1"), perm("p2"), { text: "after" }])));
  out.push(S("a-reply-after-the-timeout-has-no-effect", [...base, ev.adv(300000), ev.in(pick(1, "a"))], turn([perm("p"), { text: "after" }])));
  out.push(S("cancel-withdraws-the-pending-request", [...base, ev.in(nf("session/cancel", { sessionId: "s1" })), ev.in(pick(1, "a"))], turn([perm("p"), { awaitCancel: true }, { text: "after" }])));
  out.push(S("cancel-then-a-new-ask-is-refused-at_once", [...base, ev.in(nf("session/cancel", { sessionId: "s1" })), ev.in(pick(1, "a")), ev.in(pick(2, "a"))], turn([perm("p1"), perm("p2"), { text: "after" }])));
  out.push(S("cancel-of-another-session-leaves-the-request", [...ins(INIT, NEW(2), NEW(3)), ev.in(textPrompt(4, "s1", "x")), ev.in(nf("session/cancel", { sessionId: "s2" })), ev.in(pick(1, "a"))], turn([perm("p"), { text: "after" }])));
  out.push(S("cancel-with-two-sessions-withdraws-only-the-one", [...ins(INIT, NEW(2), NEW(3)), ev.in(textPrompt(4, "s1", "x")), ev.in(textPrompt(5, "s2", "y")), ev.in(nf("session/cancel", { sessionId: "s1" })), ev.in(pick(2, "a"))],
    { create: [{ sessionId: "s1" }, { sessionId: "s2" }], prompts: [[perm("p1"), { text: "one" }], [perm("p2"), { text: "two" }]] }));
  out.push(S("end-of-input-cancels-the-pending-request", [...base, ev.end()], turn([perm("p"), { text: "after" }])));
  out.push(S("input-destroyed-cancels-the-pending-request", [...base, ev.close()], turn([perm("p"), { text: "after" }])));
  out.push(S("output-closed-cancels-the-pending-request", [...base, ev.outClosed(), ev.in(pick(1, "a"))], turn([perm("p"), { text: "after" }])));
  out.push(S("a-reply-to-a-finished-turn-is-ignored", [...base, ev.in(pick(1, "a")), ev.in(pick(1, "a"))], turn([perm("p")])));

  // --- capacity
  const many = Array.from({ length: 66 }, (_, i) => spawn(`s${i + 1}`));
  out.push(S("at-most-64-requests-are-open", [...base, ev.in(pick(1, "a")), ev.in(pick(64, "r")), ev.in(pick(65, "a"))], turn([...many, { yield: 2 }])));
  out.push(S("a-freed-slot-can-be-used-again", [...base, ev.in(pick(1, "a")), ev.in(pick(2, "a"))], turn([...Array.from({ length: 64 }, (_, i) => spawn(`a${i + 1}`)), spawn("late1"), { yield: 3 }, spawn("late2"), { yield: 3 }])));
  out.push(S("capacity-is-per-server-not-per-session", [...ins(INIT, NEW(2), NEW(3)), ev.in(textPrompt(4, "s1", "x")), ev.in(textPrompt(5, "s2", "y")), ev.in(nf("session/cancel", { sessionId: "s1" }))],
    { create: [{ sessionId: "s1" }, { sessionId: "s2" }], prompts: [Array.from({ length: 40 }, (_, i) => spawn(`a${i}`)), [...Array.from({ length: 40 }, (_, i) => spawn(`b${i}`)), { yield: 2 }]] }));
  out.push(S("ids-are-issued-in-order-and-never-reused", [...base, ev.in(pick(1, "a")), ev.in(pick(2, "a")), ev.in(pick(1, "a")), ev.in(pick(3, "a"))], turn([perm("p1"), perm("p2"), perm("p3")])));
  return out;
}
