// The Core-backed backend of the ACP server (P4-K K8): `CoreSessionBackend` over a scripted Core (`session.*`, `code.*`,
// `approval.*`), the approval relay that turns Core approvals into permission requests, and the file-change presentation.
import { INIT, NEW, ev, ins, line, nf, rq, textPrompt, uuids, type Scenario } from "./export-acp-support.ts";
import { type Rpc, E, okj, page, rec, PLAIN, CODE, QUEUE, APPR, pid, pick, rpcOf } from "./export-acp-core-support.ts";

const S = (name: string, events: unknown[], rpc: Rpc, extra: Record<string, unknown> = {}): Scenario => ({ name, rpc, events, ids: uuids(8), ...extra });
const go = (id = 3, text = "hi") => ev.in(textPrompt(id, "c1", text));
const base = ins(INIT, NEW(2));

export function buildCore(): Scenario[] {
  const out: Scenario[] = [];
  const turn = (name: string, pages: unknown[], extra: Partial<Rpc> = {}, more: unknown[] = []) => out.push(S(name, [...base, go(), ...more], rpcOf({ pages, ...extra })));

  // --- one turn over the persisted event stream
  turn("turn-streams-text-and-tools", [page([E(1, "delta", { text: "he" }), E(2, "delta", { text: "llo" }), E(3, "tool.call", { id: "k1", name: "web.search", args: { q: "x" } }), E(4, "tool.result", { id: "k1", output: "found" }), E(5, "turn.completed", {})])]);
  turn("turn-skips-events-of-other-turns", [page([E(1, "delta", { text: "old" }, "t0"), E(2, "delta", { text: "mine" }), E(3, "delta", { text: "null-turn" }, null), E(4, "turn.completed", {}, "t9"), E(5, "turn.completed", {})])]);
  turn("turn-polls-until-the-end", [page([], true), page([E(1, "delta", { text: "a" })], true), page([], true), page([E(2, "turn.completed", {})], false)]);
  turn("turn-ends-without-an-event", [page([], false)]);
  turn("turn-ends-without-an-event-after-others", [page([E(1, "delta", { text: "a" })], true), page([], false)]);
  turn("turn-failed-forms", [page([E(1, "turn.failed", { error: "provider said no" })])]);
  turn("turn-failed-without-error", [page([E(1, "turn.failed", {})])]);
  turn("turn-failed-with-a-non-string-error", [page([E(1, "turn.failed", { error: 5 })])]);
  turn("turn-failed-as-cancelled", [page([E(1, "turn.failed", { error: "cancelled" })])]);
  turn("turn-failed-as-cancelled-in-another-case", [page([E(1, "turn.failed", { error: "Cancelled" })])]);
  turn("turn-events-after-the-end-are-not-read", [page([E(1, "turn.completed", {}), E(2, "delta", { text: "late" })])]);
  turn("turn-delta-forms", [page([E(1, "delta", { text: 5 }), E(2, "delta", {}), E(3, "delta", { text: "" }), E(4, "delta", { text: "ok" }), E(5, "delta", { text: ["x"] }), E(6, "unknown.type", { text: "z" }), E(7, "turn.completed", {})])]);
  turn("turn-tool-event-forms", [page([
    E(1, "tool.call", { id: 5, name: 6 }), E(2, "tool.call", {}), E(3, "tool.call", { id: null, name: null }), E(4, "tool.call", { id: ["a", "b"], name: { x: 1 } }), E(5, "tool.call", { id: "k", name: "n", args: null }),
    E(6, "tool.call", { id: "k2", name: "n", args: "str" }), E(7, "tool.call", { id: "k3", name: "n", args: [1, { a: 2 }] }),
    E(8, "tool.result", { id: "k", output: 5 }), E(9, "tool.result", { id: "k", output: null }), E(10, "tool.result", { id: "k" }), E(11, "tool.result", { id: "k", output: { a: 1 } }), E(12, "tool.result", { id: "k", output: ["x", 2] }), E(13, "tool.result", { output: "no id" }),
    E(14, "tool.result", { id: "k", output: true }), E(15, "tool.result", { id: "k", output: 1.5e300 }), E(16, "turn.completed", {}),
  ])]);
  turn("turn-event-sequence-numbers-need-not-rise", [page([E(5, "delta", { text: "a" }), E(2, "delta", { text: "b" }), E(7, "turn.completed", {})]), page([], true)]);
  turn("turn-event-forms-without-data", [page([{ seq: 1, turnId: "t1", type: "delta", data: {} }, { seq: 2, turnId: "t1", type: "turn.completed", data: {} }])]);
  const full = (from: number, n: number, turnId = "t0") => Array.from({ length: n }, (_, i) => E(from + i, "delta", { text: String(from + i) }, turnId));
  turn("turn-reads-pages-of-500-without-sleeping", [page(full(1, 500), true), page(full(501, 499), true), page([E(1000, "turn.completed", {})])]);
  turn("turn-cursor-follows-the-last-event", [page([E(3, "delta", { text: "a" })]), page([E(4, "delta", { text: "b" }, "t0")]), page([E(9, "turn.completed", {})])]);
  turn("turn-cursor-of-an-empty-page-stays", [page([E(3, "delta", { text: "a" })]), page([], true), page([E(9, "turn.completed", {})])]);
  out.push(S("two-turns-keep-one-cursor-per-session", [...base, go(3, "one"), go(4, "two")], rpcOf({ pages: [page([E(2, "delta", { text: "a" }), E(3, "turn.completed", {})]), page([E(5, "turn.completed", {})], false)], submit: [okj({ turnId: "t1" }), okj({ turnId: "t2" })] })));
  out.push(S("a-session-is-unknown-until-created", ins(INIT, textPrompt(3, "nope", "x")), rpcOf({ pages: [] })));
  out.push(S("a-turn-without-a-session-id-from-core", [...base, go(3)], rpcOf({ create: [okj({ session: { id: "c1" } })], pages: [page([E(1, "turn.completed", {})])] })));

  // --- failures of the Core
  const named = (name: string, code?: string) => ({ err: { name, ...(code !== undefined ? { code } : {}) } });
  out.push(S("submit-fails-before-a-turn-exists", [...base, go()], rpcOf({ submit: [named("RpcError", "E_BUSY")], pages: [] })));
  out.push(S("submit-fails-anonymously", [...base, go()], rpcOf({ submit: [{ err: { code: "E_X" } }], pages: [] })));
  out.push(S("events-fail-after-the-turn-started-and-cancel-is-called", [...base, go()], rpcOf({ pages: [named("RpcError", "E_GONE")] })));
  out.push(S("events-fail-and-cancel-fails-too", [...base, go()], rpcOf({ pages: [named("RpcError", "E_GONE")], cancel: [named("RpcError", "E_X")] })));
  out.push(S("events-fail-with-a-secret-in-the-error", [...base, go()], rpcOf({ pages: [named("Error", "sk-live-0123456789abcdef")] })));
  out.push(S("create-fails", [...base], rpcOf({ create: [named("RpcError", "E_LIMIT")], pages: [] })));
  out.push(S("create-answers-without-a-session", [...base], rpcOf({ create: [okj({})], pages: [] })));
  out.push(S("create-answers-with-null", [...base], rpcOf({ create: [{}], pages: [] })));
  out.push(S("submit-answers-without-a-turn-id", [...base, go()], rpcOf({ submit: [okj({})], pages: [page([E(1, "turn.completed", {}, null)])] })));
  out.push(S("create-passes-title-kind-and-agent", [...base], rpcOf({ pages: [] }), { core: { agentId: "other-agent" } }));
  out.push(S("session-limit-after-1024-sessions", [...ins(INIT), ...Array.from({ length: 1026 }, (_, i) => ev.in(NEW(i + 2)))], rpcOf({ create: Array.from({ length: 1030 }, (_, i) => okj({ session: { id: `c${i}` } })), pages: [] })));

  // --- cancel
  out.push(S("cancel-during-the-turn-reaches-the-core", [...base, go(), ev.in(nf("session/cancel", { sessionId: "c1" })), ev.rel("g")], rpcOf({ pages: [{ gate: "g", ...okj(page([E(1, "turn.failed", { error: "cancelled" })])) }] })));
  out.push(S("cancel-before-the-turn-exists", [...base, go(), ev.in(nf("session/cancel", { sessionId: "c1" })), ev.rel("s")], rpcOf({ submit: [{ gate: "s", ...okj({ turnId: "t1" }) }], pages: [page([E(1, "turn.failed", { error: "cancelled" })])] })));
  out.push(S("cancel-before-the-turn-exists-and-cancel-fails", [...base, go(), ev.in(nf("session/cancel", { sessionId: "c1" })), ev.rel("s")], rpcOf({ submit: [{ gate: "s", ...okj({ turnId: "t1" }) }], cancel: [named("RpcError", "E_X")], pages: [page([E(1, "turn.completed", {})])] })));
  out.push(S("cancel-while-the-core-cancel-fails", [...base, go(), ev.in(nf("session/cancel", { sessionId: "c1" })), ev.rel("g")], rpcOf({ cancel: [named("RpcError", "E_X")], pages: [{ gate: "g", ...okj(page([E(1, "turn.completed", {})])) }] })));
  out.push(S("cancel-of-an-idle-session-is-nothing", [...base, ev.in(nf("session/cancel", { sessionId: "c1" }))], rpcOf({ pages: [] })));
  out.push(S("end-of-input-cancels-the-turn", [...base, go(), ev.end(), ev.rel("g")], rpcOf({ pages: [{ gate: "g", ...okj(page([E(1, "turn.failed", { error: "cancelled" })])) }] })));

  // --- modes and the bound root
  const code = { methods: CODE };
  out.push(S("modes-session-opens-a-root-and-sets-the-mode", [...base, go()], rpcOf({ ...code, pages: [page([E(1, "turn.completed", {})])] })));
  out.push(S("modes-initial-coding-mode", [...base], rpcOf({ ...code, mode: [okj({ mode: "coding", changed: true })], pages: [] }), { core: { initialMode: "coding" } }));
  out.push(S("modes-initial-coding-without-the-feature", [...base], rpcOf({ pages: [] }), { core: { initialMode: "coding" } }));
  out.push(S("modes-feature-needs-both-methods", [...base], rpcOf({ methods: [...PLAIN, "code.session.open"], pages: [] })));
  out.push(S("modes-feature-needs-both-methods-the-other-way", [...base], rpcOf({ methods: [...PLAIN, "code.session.mode"], pages: [] })));
  out.push(S("modes-new-session-needs-a-cwd", ins(INIT, rq(2, "session/new", { cwd: "", mcpServers: [] }), rq(3, "session/new", { mcpServers: [] })), rpcOf({ ...code, pages: [] })));
  out.push(S("modes-root-not-open", [...base], rpcOf({ ...code, open: [okj({ state: "denied", root: "/work" })], pages: [] })));
  out.push(S("modes-root-open-state-forms", ins(INIT, NEW(2), NEW(3), NEW(4), NEW(5)), rpcOf({ ...code, create: ["a", "b", "c", "d"].map((i) => okj({ session: { id: i } })), open: [okj({ state: "OPEN", root: "/w" }), okj({ root: "/w" }), okj({ state: ["open"], root: "/w" }), okj({ state: "open", root: "/w" })], mode: [okj({ mode: "chat", changed: false })], pages: [] })));
  out.push(S("modes-approval-required-becomes-root-not-granted", [...base], rpcOf({ ...code, open: [{ err: { code: "E_APPROVAL_REQUIRED" } }], pages: [] })));
  out.push(S("modes-approval-required-as-an-error-object", [...base], rpcOf({ ...code, open: [named("RpcError", "E_APPROVAL_REQUIRED")], pages: [] })));
  out.push(S("modes-other-open-errors-stay-internal", ins(INIT, NEW(2), NEW(3), NEW(4)), rpcOf({ ...code, create: ["a", "b", "c"].map((i) => okj({ session: { id: i } })), open: [named("RpcError", "E_OTHER"), { err: { code: "E_approval_required" } }, { err: { code: 5 } }], pages: [] })));
  out.push(S("modes-archive-failure-is-ignored", [...base], rpcOf({ ...code, open: [okj({ state: "no", root: "/w" })], archive: [named("RpcError", "E_X")], pages: [] })));
  out.push(S("modes-mode-call-fails-and-the-session-is-archived", [...base], rpcOf({ ...code, mode: [named("RpcError", "E_MODE")], pages: [] })));
  out.push(S("modes-set-mode-through-the-core", [...base, ev.in(rq(3, "session/set_mode", { sessionId: "c1", modeId: "coding" })), ev.in(rq(4, "session/set_mode", { sessionId: "c1", modeId: "chat" }))], rpcOf({ ...code, mode: [okj({ mode: "chat", changed: false }), okj({ mode: "coding", changed: true }), okj({ mode: "chat", changed: true })], pages: [] })));
  out.push(S("modes-set-mode-on-an-unknown-session", [...base, ev.in(rq(3, "session/set_mode", { sessionId: "zz", modeId: "coding" }))], rpcOf({ ...code, pages: [] })));
  out.push(S("modes-set-mode-answers-with-an-unknown-mode", [...base, ev.in(rq(3, "session/set_mode", { sessionId: "c1", modeId: "coding" }))], rpcOf({ ...code, mode: [okj({ mode: "chat", changed: false }), okj({ mode: "bogus", changed: true })], pages: [] })));
  out.push(S("modes-set-mode-answers-without-a-changed-flag", [...base, ev.in(rq(3, "session/set_mode", { sessionId: "c1", modeId: "coding" })), ev.in(rq(4, "session/set_mode", { sessionId: "c1", modeId: "coding" }))], rpcOf({ ...code, mode: [okj({ mode: "chat", changed: false }), okj({ mode: "coding" }), okj({ mode: "coding", changed: "yes" })], pages: [] })));
  out.push(S("modes-set-mode-in-german", [...base, ev.in(rq(3, "session/set_mode", { sessionId: "c1", modeId: "coding" }))], rpcOf({ ...code, mode: [okj({ mode: "chat", changed: false }), okj({ mode: "coding", changed: true })], pages: [] }), { server: { language: "de" } }));
  out.push(S("modes-set-mode-without-the-feature", [...base, ev.in(rq(3, "session/set_mode", { sessionId: "c1", modeId: "coding" }))], rpcOf({ pages: [] })));

  // --- delivery
  const q = { methods: QUEUE };
  const dv = (id: number, method: string, text = "later") => ev.in(rq(id, method, { sessionId: "c1", prompt: [{ type: "text", text }] }));
  out.push(S("delivery-steer-and-queue-reach-submit", [...base, dv(3, "_app.plur1bus/steer", "now"), dv(4, "_app.plur1bus/follow_up", "after")], rpcOf({ ...q, submit: [okj({ queued: true }), okj({ n: 1 })], pages: [] })));
  out.push(S("delivery-needs-both-methods", [...base, dv(3, "_app.plur1bus/steer")], rpcOf({ methods: [...PLAIN, "session.queue.list"].filter((m) => m !== "session.submit"), pages: [] })));
  out.push(S("delivery-needs-the-queue-method", [...base, dv(3, "_app.plur1bus/steer")], rpcOf({ pages: [] })));
  out.push(S("delivery-on-an-unknown-session", ins(INIT, rq(2, "_app.plur1bus/steer", { sessionId: "zz", prompt: [{ type: "text", text: "x" }] })), rpcOf({ ...q, pages: [] })));
  out.push(S("delivery-core-errors", [...base, dv(3, "_app.plur1bus/steer"), dv(4, "_app.plur1bus/follow_up")], rpcOf({ ...q, submit: [named("RpcError", "E_FULL"), { err: { code: "E_X" } }], pages: [] })));
  out.push(S("delivery-answers-are-passed-through", [...base, dv(3, "_app.plur1bus/steer"), dv(4, "_app.plur1bus/steer"), dv(5, "_app.plur1bus/steer"), dv(6, "_app.plur1bus/steer")], rpcOf({ ...q, submit: [okj(null), okj(0), okj({ a: [1, 2, { b: null }], "2": 1, "1": 2 }), {}], pages: [] })));

  out.push(...buildRelay());
  return out;
}

// --- the approval relay
function buildRelay(): Scenario[] {
  const out: Scenario[] = [];
  const server = (language?: string) => (language ? { server: { language } } : {});
  /** A turn that stays open until `g` is released, with the Core's approval answers scripted. */
  const relay = (name: string, { list = [okj({ approvals: [rec()] })], get = [okj(rec())], decide = [okj({})], cancel = [okj({})], more = [] as unknown[], pages, language, extra = {} }: any) => {
    out.push(S(name, [...ins(INIT, NEW(2)), ev.in(textPrompt(3, "c1", "hi")), ...more, ev.rel("g")],
      rpcOf({ methods: [...PLAIN, ...APPR], approvals: { list, get, decide, cancel }, pages: pages ?? [page([], true), { gate: "g", ...okj(page([E(1, "turn.completed", {})])) }] }), { ...server(language), ...extra }));
  };
  relay("relay-allow-once", { more: [ev.in(pick(1, "allow-once"))] });
  relay("relay-allow-session", { more: [ev.in(pick(1, "allow-session"))] });
  relay("relay-deny", { more: [ev.in(pick(1, "deny"))] });
  relay("relay-allow-in-german", { more: [ev.in(pick(1, "allow-once"))], language: "de" });
  relay("relay-unknown-option-is-refused-by-the-server", { more: [ev.in(pick(1, "allow-always"))] });
  relay("relay-option-the-client-invents", { more: [ev.in(pick(1, "allow-task"))] });
  relay("relay-client-cancels-the-choice", { more: [ev.in(line({ jsonrpc: "2.0", id: pid(1), result: { outcome: { outcome: "cancelled" } } }))] });
  relay("relay-client-answers-with-an-error", { more: [ev.in(line({ jsonrpc: "2.0", id: pid(1), error: { code: -1, message: "no" } }))] });
  relay("relay-client-never-answers", { more: [] });
  relay("relay-client-answers-twice", { more: [ev.in(pick(1, "allow-once")), ev.in(pick(1, "deny"))] });
  relay("relay-session-cancel-withdraws-the-choice", { more: [ev.in(nf("session/cancel", { sessionId: "c1" })), ev.in(pick(1, "allow-once"))] });
  relay("relay-end-of-input-withdraws-the-choice", { more: [ev.end()] });
  relay("relay-late-answer-after-the-turn-ended", { pages: [page([], true), { gate: "g", ...okj(page([E(1, "turn.completed", {})])) }], more: [] });
  relay("relay-allow-once-needs-an-attestation-above-surface-one", { list: [okj({ approvals: [rec({ requiredSurface: 2 })] })], get: [okj(rec({ requiredSurface: 2 }))], more: [ev.in(pick(1, "allow-once"))] });
  relay("relay-attest-from-the-option-surface", { list: [okj({ approvals: [rec({ grantOptions: [{ scope: "once", requiredSurface: 2 }] })] })], get: [okj(rec({ grantOptions: [{ scope: "once", requiredSurface: 2 }] }))], more: [ev.in(pick(1, "allow-once"))] });
  relay("relay-attest-surface-forms", { list: [okj({ approvals: [rec({ requiredSurface: undefined, grantOptions: [{ scope: "once", requiredSurface: 1 }] })] })], get: [okj(rec({ requiredSurface: undefined, grantOptions: [{ scope: "once", requiredSurface: 1 }] }))], more: [ev.in(pick(1, "allow-once"))] });
  const opts = (grantOptions: unknown[], over: any = {}) => ({ list: [okj({ approvals: [rec({ grantOptions, ...over })] })], get: [okj(rec({ grantOptions, ...over }))] });
  relay("relay-offers-never-reach-above-surface-two", { ...opts([{ scope: "once", requiredSurface: 3 }, { scope: "session", requiredSurface: 2 }]), more: [ev.in(pick(1, "allow-session"))] });
  relay("relay-record-surface-above-two-offers-nothing-but-deny", { ...opts([{ scope: "once", requiredSurface: 1 }], { requiredSurface: 3 }), more: [ev.in(pick(1, "deny"))] });
  relay("relay-always-is-never-offered", { ...opts([{ scope: "always", requiredSurface: 1 }, { scope: "once", requiredSurface: 1 }]), more: [ev.in(pick(1, "allow-always"))] });
  relay("relay-task-scope-needs-a-task-id", { ...opts([{ scope: "task", requiredSurface: 1 }, { scope: "once", requiredSurface: 1 }]) });
  relay("relay-task-scope-with-a-task-id", { ...opts([{ scope: "task", requiredSurface: 1 }], { taskId: "task1" }), more: [ev.in(pick(1, "allow-task"))] });
  relay("relay-session-scope-needs-a-session-id", { ...opts([{ scope: "session", requiredSurface: 1 }, { scope: "once", requiredSurface: 1 }]) });
  relay("relay-unknown-scopes-get-no-name", { ...opts([{ scope: "forever", requiredSurface: 1 }, { scope: "once", requiredSurface: 1 }, { scope: "once", requiredSurface: 1 }]) });
  relay("relay-no-grant-options-only-deny", { ...opts([]), more: [ev.in(pick(1, "deny"))] });
  relay("relay-grant-options-absent", { ...opts(undefined as any), more: [ev.in(pick(1, "deny"))] });
  relay("relay-grant-option-surface-missing", { ...opts([{ scope: "once" }, { scope: "session", requiredSurface: "2" }]), more: [ev.in(pick(1, "allow-once"))] });
  // Which approvals belong to this turn.
  const mine = rec();
  const foreign = (over: any) => ({ list: [okj({ approvals: [rec({ id: "x1", ...over }), mine] })] });
  relay("relay-other-session-is-skipped", { ...foreign({ sessionId: "other" }), more: [ev.in(pick(1, "deny"))] });
  relay("relay-other-turn-is-skipped", { ...foreign({ turnId: "other" }), more: [ev.in(pick(1, "deny"))] });
  relay("relay-other-agent-is-skipped", { ...foreign({ subject: { kind: "agent", id: "other" } }), more: [ev.in(pick(1, "deny"))] });
  relay("relay-user-subject-is-skipped", { ...foreign({ subject: { kind: "user", id: "bernd" } }), more: [ev.in(pick(1, "deny"))] });
  relay("relay-not-pending-is-skipped", { ...foreign({ status: "approved" }), more: [ev.in(pick(1, "deny"))] });
  relay("relay-subject-with-extra-members", { ...foreign({ subject: { kind: "agent", id: "bernd", more: 1 } }), more: [ev.in(pick(1, "deny")), ev.in(pick(2, "deny"))] });
  relay("relay-missing-subject-fails-the-turn", { list: [okj({ approvals: [rec({ subject: undefined })] })] });
  relay("relay-null-subject-fails-the-turn", { list: [okj({ approvals: [rec({ subject: null })] })] });
  relay("relay-subject-of-the-wrong-type", { list: [okj({ approvals: [rec({ subject: "agent" }), rec({ id: "x2", subject: 5 }), rec({ id: "x3", subject: [] })] })], more: [] });
  relay("relay-session-id-compared-as-a-string-not-a-structure", { list: [okj({ approvals: [rec({ sessionId: ["c1"] }), rec({ id: "x2", turnId: ["t1"] }), rec({ id: "x3", subject: { kind: "agent", id: ["bernd"] } })] })] });
  relay("relay-record-without-an-id", { list: [okj({ approvals: [rec({ id: undefined }), rec({ id: null }), rec({ id: 5 })] })], get: [okj(rec({ id: undefined }))] });
  relay("relay-list-without-approvals-fails-the-turn", { list: [okj({})] });
  relay("relay-list-answers-null-fails-the-turn", { list: [{}] });
  relay("relay-list-error-fails-the-turn", { list: [{ err: { name: "RpcError", code: "E_LIST" } }] });
  relay("relay-same-record-twice-in-one-page", { list: [okj({ approvals: [rec(), rec()] })], more: [ev.in(pick(1, "deny")), ev.in(pick(2, "deny"))] });
  relay("relay-two-records-two-requests", { list: [okj({ approvals: [rec(), rec({ id: "ap2", actionHash: "h2", summary: "Second" })] })], get: [okj(rec()), okj(rec({ id: "ap2", actionHash: "h2", summary: "Second" }))], more: [ev.in(pick(2, "allow-session")), ev.in(pick(1, "deny"))] });
  relay("relay-pending-is-asked-once-across-polls", { list: [okj({ approvals: [rec()] }), okj({ approvals: [rec()] })], pages: [page([], true), page([], true), { gate: "g", ...okj(page([E(1, "turn.completed", {})])) }], more: [ev.in(pick(1, "deny"))] });
  // What the fresh record must still say.
  const stale = (fresh: any, ...more: unknown[]) => relay(`relay-fresh-record-${fresh.__name}`, { get: [okj(rec(fresh.over))], more: more.length ? more : [ev.in(pick(1, "allow-once"))] });
  stale({ __name: "is-no-longer-pending", over: { status: "approved" } });
  stale({ __name: "has-another-session", over: { sessionId: "other" } });
  stale({ __name: "has-another-turn", over: { turnId: "other" } });
  stale({ __name: "has-another-subject", over: { subject: { kind: "agent", id: "other" } } });
  stale({ __name: "has-another-action-hash", over: { actionHash: "changed" } });
  stale({ __name: "has-no-action-hash", over: { actionHash: undefined } });
  stale({ __name: "has-another-capability", over: { capability: "fs.read" } });
  stale({ __name: "has-another-id", over: { id: "ap9" } });
  stale({ __name: "has-lost-the-scope", over: { grantOptions: [{ scope: "session", requiredSurface: 1 }] } });
  stale({ __name: "has-changed-the-scope-surface", over: { grantOptions: [{ scope: "once", requiredSurface: 2 }, { scope: "session", requiredSurface: 1 }] } });
  stale({ __name: "has-a-higher-record-surface", over: { requiredSurface: 3 } });
  stale({ __name: "has-lost-its-subject", over: { subject: undefined } });
  stale({ __name: "answer-denies-regardless", over: { actionHash: "changed" } }, ev.in(pick(1, "deny")));
  stale({ __name: "denies-even-when-the-scope-vanished", over: { grantOptions: [] } }, ev.in(pick(1, "deny")));
  relay("relay-fresh-lookup-fails", { get: [{ err: { name: "RpcError", code: "E_GET" } }], more: [ev.in(pick(1, "allow-once"))] });
  relay("relay-fresh-lookup-fails-then-cancel-fails", { get: [{ err: { name: "RpcError", code: "E_GET" } }], cancel: [{ err: { name: "RpcError", code: "E_X" } }], more: [ev.in(pick(1, "allow-once"))] });
  relay("relay-decide-fails-is-a-refusal", { decide: [{ err: { name: "RpcError", code: "E_NEEDS_OS" } }], more: [ev.in(pick(1, "allow-once"))] });
  relay("relay-decide-fails-and-cancel-fails", { decide: [{ err: { name: "RpcError", code: "E_X" } }], cancel: [{ err: { name: "RpcError", code: "E_Y" } }], more: [ev.in(pick(1, "allow-session"))] });
  relay("relay-deny-fails", { decide: [{ err: { name: "RpcError", code: "E_X" } }], more: [ev.in(pick(1, "deny"))] });
  relay("relay-deny-fails-in-german", { decide: [{ err: { name: "RpcError", code: "E_X" } }], more: [ev.in(pick(1, "deny"))], language: "de" });
  // What the editor is shown.
  const shown = (name: string, over: any, language?: string) => relay(`relay-question-${name}`, { list: [okj({ approvals: [rec(over)] })], get: [okj(rec(over))], more: [ev.in(pick(1, "deny"))], language });
  shown("fs-read", { capability: "fs.read", tool: "file.read" });
  shown("fs-write", { capability: "fs.write", tool: "file.write", targets: ["a.txt", "b.txt"], risk: "overwrites", agentReason: "needs it", diff: "--- a\n+++ b" });
  shown("no-tool-title-is-the-capability", { tool: undefined, capability: "net.fetch" });
  shown("tool-title-empty-string", { tool: "", capability: "net.fetch" });
  shown("no-summary-no-details", { summary: undefined });
  shown("empty-summary", { summary: "", targets: [""], risk: "", agentReason: "", diff: "" });
  shown("details-in-german", { targets: ["t"], risk: "high", agentReason: "because", diff: "d" }, "de");
  for (const cap of ["toString", "constructor", "hasOwnProperty", "valueOf", "__proto__", "isPrototypeOf", "fs.Write", "FS.read", ""]) shown(`capability-${cap || "empty"}`, { capability: cap });
  shown("targets-as-a-string-are-spread", { targets: "abc" });
  shown("targets-with-odd-members", { targets: [1, null, "", "x", {}, [2, 3], false, true, 0, "é"] });
  shown("targets-not-iterable-fail-the-turn", { targets: 5 });
  shown("targets-an-object-fails-the-turn", { targets: { a: 1 } });
  shown("targets-null-or-absent", { targets: null });
  shown("risk-and-reason-of-the-wrong-type", { risk: 5, agentReason: ["x"], diff: { a: 1 } });
  shown("details-with-line-breaks-and-unicode", { summary: "line1\nline2   é😀", targets: ["a\tb"], diff: "x\r\ny" });
  shown("summary-not-a-string", { summary: 5, targets: [] });
  shown("long-details", { summary: "s".repeat(5000), targets: Array.from({ length: 50 }, (_, i) => `target-${i}`) });
  shown("record-id-forms", { id: "id with spaces \"quotes\" é" });
  out.push(...relayPaging());
  return out;
}

function relayPaging(): Scenario[] {
  const out: Scenario[] = [];
  const turnPages = (n: number) => [...Array.from({ length: n }, () => page([], true)), { gate: "g", ...okj(page([E(1, "turn.completed", {})])) }];
  const mk = (name: string, a: any, more: unknown[], pages = turnPages(4)) => out.push(S(name, [...ins(INIT, NEW(2)), ev.in(textPrompt(3, "c1", "hi")), ...more, ev.rel("g")], rpcOf({ methods: [...PLAIN, ...APPR], approvals: a, pages })));
  mk("relay-pages-follow-the-cursor", { list: [okj({ approvals: [rec({ id: "p1" })], nextCursor: "c-2" }), okj({ approvals: [rec({ id: "p2" })] }), okj({ approvals: [] })], get: [okj(rec({ id: "p1" })), okj(rec({ id: "p2" }))], decide: [okj({})], cancel: [okj({})] }, [ev.in(pick(1, "deny")), ev.in(pick(2, "deny"))]);
  mk("relay-empty-cursor-ends-the-scan", { list: [okj({ approvals: [], nextCursor: "" }), okj({ approvals: [] })] }, []);
  mk("relay-withdrawn-record-clears-the-choice", { list: [okj({ approvals: [rec()] }), okj({ approvals: [] })], get: [okj(rec({ status: "approved" }))] }, [ev.in(pick(1, "allow-once"))]);
  mk("relay-withdrawn-record-still-pending-stays", { list: [okj({ approvals: [rec()] }), okj({ approvals: [] })], get: [okj(rec()), okj(rec())] }, [ev.in(pick(1, "deny"))]);
  mk("relay-withdrawn-record-moved-to-another-turn", { list: [okj({ approvals: [rec()] }), okj({ approvals: [] })], get: [okj(rec({ turnId: "other" }))] }, []);
  mk("relay-withdrawal-check-fails-the-turn", { list: [okj({ approvals: [rec()] }), okj({ approvals: [] })], get: [{ err: { name: "RpcError", code: "E_GET" } }] }, []);
  mk("relay-withdrawal-check-with-a-record-without-subject", { list: [okj({ approvals: [rec()] }), okj({ approvals: [] })], get: [okj(rec({ subject: undefined }))] }, []);
  mk("relay-withdrawal-only-after-a-complete-scan", { list: [okj({ approvals: [rec()], nextCursor: "c2" }), okj({ approvals: [] , nextCursor: "c3" }), okj({ approvals: [rec()] })], get: [okj(rec())] }, [ev.in(pick(1, "deny"))]);
  mk("relay-an-answered-record-stays-seen", { list: [okj({ approvals: [rec()] }), okj({ approvals: [rec()] }), okj({ approvals: [rec()] })], get: [okj(rec())], decide: [okj({})] }, [ev.in(pick(1, "deny"))]);
  mk("relay-cursor-is-sent-only-when-set", { list: [okj({ approvals: [], nextCursor: "abc" }), okj({ approvals: [], nextCursor: "abc" }), okj({ approvals: [] }), okj({ approvals: [] })] }, []);
  mk("relay-list-parameters-carry-the-agent", { list: [okj({ approvals: [] })] }, []);
  mk("relay-poll-runs-only-when-all-four-methods-exist", { list: [okj({ approvals: [] })] }, []);
  out.push(S("relay-is-off-without-all-four-methods", [...ins(INIT, NEW(2)), ev.in(textPrompt(3, "c1", "hi"))], rpcOf({ methods: [...PLAIN, "approval.list", "approval.get", "approval.decide"], pages: [page([E(1, "turn.completed", {})])] })));
  out.push(S("relay-is-off-without-approval-list", [...ins(INIT, NEW(2)), ev.in(textPrompt(3, "c1", "hi"))], rpcOf({ methods: [...PLAIN, "approval.get", "approval.decide", "approval.cancel"], pages: [page([E(1, "turn.completed", {})])] })));
  out.push(S("relay-polls-after-each-page", [...ins(INIT, NEW(2)), ev.in(textPrompt(3, "c1", "hi"))], rpcOf({ methods: [...PLAIN, ...APPR], approvals: { list: [okj({ approvals: [] }), okj({ approvals: [] })] }, pages: [page([E(1, "delta", { text: "a" })], true), page([E(2, "delta", { text: "b" })], true), page([E(3, "turn.completed", {})])] })));
  out.push(S("relay-is-closed-when-the-turn-ends", [...ins(INIT, NEW(2)), ev.in(textPrompt(3, "c1", "hi")), ev.in(pick(1, "allow-once"))], rpcOf({ methods: [...PLAIN, ...APPR], approvals: { list: [okj({ approvals: [rec()] })], get: [okj(rec())], decide: [okj({})] }, pages: [page([E(1, "delta", { text: "a" })], true), page([E(2, "turn.completed", {})])] })));
  void uuids;
  return out;
}
