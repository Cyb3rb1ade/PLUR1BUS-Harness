// The protocol layer of the ACP server (P4-K K8): handshake, sessions, prompts and their streaming updates, cancel, the closing
// of the connection, delivery (steer, follow-up) and modes, over the scripted backend.
import { INIT, NEW, ev, ins, line, nf, rq, simple, textPrompt, type Scenario } from "./export-acp-support.ts";

const S = (name: string, events: unknown[], backend: any = simple(), extra: Record<string, unknown> = {}): Scenario => ({ name, backend, events, ...extra });
const hello = [INIT, NEW(2)];
const MODES = { features: { modes: true } };
const bothModes = (extra: any = {}) => ({ ...MODES, create: [{ sessionId: "s1", modeJson: '"chat"' }, { sessionId: "s2", modeJson: '"coding"' }], mode: [{ modeJson: '"coding"', changed: true }, { modeJson: '"coding"', changed: false }, { modeJson: '"chat"', changed: true }], prompts: [[{ text: "x" }]], ...extra });
const DELIVERY = { features: { steer: true, followUp: true } };
const prompt = (sid: string, text: string, id: unknown = 3) => textPrompt(id, sid, text);

export function buildProtocol(): Scenario[] {
  const out: Scenario[] = [];

  // --- the handshake
  out.push(S("handshake-basic", ins(INIT)));
  out.push(S("handshake-higher-client-version-is-answered-with-one", ins(rq(1, "initialize", { protocolVersion: 2 }), rq(2, "initialize", { protocolVersion: 99 }))));
  out.push(S("handshake-repeated", ins(INIT, INIT, rq(3, "initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true } } }))));
  out.push(S("handshake-with-steering-features", ins(INIT), { features: { steer: true, followUp: true } }));
  out.push(S("handshake-with-one-delivery-feature", ins(INIT), { features: { steer: true } }));
  out.push(S("handshake-with-follow-up-only", ins(INIT), { features: { followUp: true } }));
  out.push(S("handshake-features-without-deliver", ins(INIT), { features: { steer: true, followUp: true }, hasDeliver: false }));
  out.push(S("handshake-with-modes-feature-only", ins(INIT), MODES));
  out.push(S("handshake-custom-agent-info", ins(INIT), simple(), { server: { agentInfo: ["a", "A title", "9.9.9"] } }));
  const versions = ["1", "1.0", "\"1\"", "true", "[1]", "0", "-1", "2", "1e0", "1.5", "1e400", "-1e400", "9007199254740993", "-0", "null", "{}", "1e300", "0.5", "3"];
  out.push(S("handshake-protocol-version-forms", ins(...versions.map((v, i) => `{"jsonrpc":"2.0","id":${i + 1},"method":"initialize","params":{"protocolVersion":${v}}}\n`))));
  out.push(S("handshake-params-forms", ins(rq(1, "initialize"), rq(2, "initialize", []), rq(3, "initialize", "x"), rq(4, "initialize", null), rq(5, "initialize", {}), rq(6, "initialize", [{ protocolVersion: 1 }]))));
  out.push(S("requests-before-the-handshake-are-refused", ins(NEW(1), textPrompt(2, "s1", "hi"), rq(3, "session/set_mode", { sessionId: "s1", modeId: "chat" }), rq(4, "_app.plur1bus/steer", { sessionId: "s1", prompt: [] }), rq(5, "_app.plur1bus/follow_up", {}), nf("session/cancel", { sessionId: "s1" }), rq(6, "session/new"))));
  out.push(S("a-failed-handshake-does-not-count", ins(rq(1, "initialize", { protocolVersion: 0 }), NEW(2), INIT, NEW(3))));

  // --- sessions
  out.push(S("session-new-basic", ins(INIT, NEW(2), NEW(3, "/other"))));
  const cwds = ["/", "/x", "x", "", "./x", "../x", "C:\\x", "C:/x", "c:\\", "C:", "C:x", "1:\\x", "\\\\server\\share", "\\x", "//x", " /x", "/x\n", "file:///x", "~", "é", "/é"];
  out.push(S("session-new-cwd-forms", ins(INIT, ...cwds.map((c, i) => rq(i + 2, "session/new", { cwd: c, mcpServers: [] }))), simple(Array(1).fill([]), { create: cwds.map((_, i) => ({ sessionId: `s${i}` })) })));
  out.push(S("session-new-cwd-not-a-string", ins(INIT, rq(2, "session/new", { cwd: 5 }), rq(3, "session/new", { cwd: null }), rq(4, "session/new", { cwd: ["/x"] }), rq(5, "session/new", {}), rq(6, "session/new", []), rq(7, "session/new", "/x"), rq(8, "session/new", null), rq(9, "session/new"))));
  const servers = ["[]", "[1,2,3]", "null", "{}", "\"x\"", "5", "true", "[[],[]]"];
  out.push(S("session-new-mcp-server-forms", ins(INIT, ...servers.map((m, i) => `{"jsonrpc":"2.0","id":${i + 2},"method":"session/new","params":{"cwd":"/w","mcpServers":${m}}}\n`), rq(20, "session/new", { cwd: "/w" })), simple([[]], { create: Array.from({ length: 12 }, (_, i) => ({ sessionId: `s${i}` })) })));
  const reasons = ["root-not-granted", "coding-unavailable", "unknown-session", "delivery-unavailable", "mode-unavailable", "session-limit"];
  out.push(S("session-new-known-refusals-in-english", ins(INIT, ...reasons.map((_, i) => NEW(i + 2))), { create: reasons.map((fail) => ({ fail })) }));
  out.push(S("session-new-known-refusals-in-german", ins(INIT, ...reasons.map((_, i) => NEW(i + 2))), { create: reasons.map((fail) => ({ fail })) }, { server: { language: "de" } }));
  out.push(S("session-new-unexpected-failures-are-opaque", ins(INIT, NEW(2), NEW(3), NEW(4), NEW(5)), { create: [{ error: "Error" }, { error: "TypeError" }, { errorAnon: true }, { error: "sk-live-0123456789abcdef" }] }));
  out.push(S("session-new-exhausted-script", ins(INIT, NEW(2), NEW(3)), { create: [{ sessionId: "only" }] }));
  out.push(S("session-ids-are-whatever-the-backend-says", ins(INIT, NEW(2), NEW(3), NEW(4)), { create: [{ sessionId: "" }, { sessionId: "é\u2028\"" }, { sessionId: "same" }] }));

  // --- prompts and their updates
  out.push(S("prompt-streams-text-in-order", [...ins(...hello), ev.in(prompt("s1", "hello")), ev.in(rq(4, "nope"))], simple([[{ text: "he" }, { text: "llo " }, { text: "wörld" }, { text: "" }, { text: "😀" }]])));
  out.push(S("prompt-tool-events", [...ins(...hello), ev.in(prompt("s1", "tools"))], simple([[
    { toolCall: { id: "c1", name: "web.search", argsJson: '{"q":"x","n":2,"z":1.50,"a":[1,{"b":null}],"2":0,"1":1,"é":"\\u0000"}' } },
    { toolResult: { id: "c1", output: "found" } },
    { toolCall: { id: "c2", name: "web.search" } },
    { toolCall: { id: "c3", name: "web.search", argsJson: "null" } },
    { toolCall: { id: "c4", name: "file.write", argsJson: '{"path":"a.txt","content":"x"}' } },
    { toolCall: { id: "c5", name: "file.edit", argsJson: '{"path":"a.txt","old":"x","new":"y"}' } },
    { toolCall: { id: "c6", name: "file.read", argsJson: '"just a string"' } },
    { toolCall: { id: "c7", name: "file.write" } },
    { toolCall: { id: "c8", name: "file.write", argsJson: "null" } },
    { toolCall: { id: "c9", name: "file.write", argsJson: "[1,2]" } },
    { toolResult: { id: "c4", output: "{\"isError\":false}" } },
    { toolResult: { id: "unknown", output: "" } },
    { toolCall: { id: "", name: "" } },
  ]])));
  const blocks: any[] = [
    [{ type: "text", text: "a" }], [{ type: "text", text: "a" }, { type: "text", text: "b" }, { type: "text", text: "" }],
    [{ type: "resource_link", uri: "file:///a", name: "a" }], [{ type: "resource_link", uri: "file:///a" }], [{ type: "resource_link", uri: "file:///a", name: "" }],
    [{ type: "resource_link", uri: "file:///a", name: "x  " }], [{ type: "resource_link", uri: "u  ]", name: "n" }], [{ type: "resource_link", uri: "u", name: " \n\u00a0\ufeff" }],
    [{ type: "resource_link", uri: "a ]b ]", name: "n ]" }], [{ type: "resource_link", uri: "", name: "" }], [{ type: "resource_link", uri: 5 }], [{ type: "resource_link", name: "x" }],
    [{ type: "image", data: "", mimeType: "image/png" }], [{ type: "audio" }], [{ type: "resource", resource: {} }], [{ type: "text" }], [{ type: "text", text: 5 }], [{ type: "text", text: null }],
    [{ text: "no type" }], [{ type: 5 }], [{ type: null }], [{ type: ["text"], text: "x" }], ["text"], [null], [5], [[]], [{}], [],
    [{ type: "text", text: " " }], [{ type: "text", text: "\u00a0\u2028\u2029\ufeff\u3000\t\n\u000b\u000c\u000d\u1680\u202f\u205f\u200a" }], [{ type: "text", text: "\u200b" }], [{ type: "text", text: "\u0085" }], [{ type: "text", text: "\u180e" }],
    [{ type: "text", text: "x" }, { type: "tool_use" }], [{ type: "TEXT", text: "x" }], [{ type: "text ", text: "x" }],
    [{ type: "x".repeat(200) }], [{ type: "é".repeat(70) }], [{ type: "a\u0000b\n" }], [{ type: "😀".repeat(40) }], [{ type: "x".repeat(64) }], [{ type: "x".repeat(65) }], [{ type: "" }],
    [{ type: "text", text: "a", extra: { deep: [1, 2, { x: 1 }] } }],
  ];
  out.push(S("prompt-block-forms", [...ins(...hello), ...blocks.map((b, i) => ev.in(rq(i + 3, "session/prompt", { sessionId: "s1", prompt: b })))], simple(Array.from({ length: blocks.length }, () => [{ text: "ok" }]))));
  const params: any[] = [undefined, null, [], "x", 5, {}, { sessionId: "s1" }, { prompt: [] }, { sessionId: 5, prompt: [] }, { sessionId: null, prompt: [] }, { sessionId: "s1", prompt: {} }, { sessionId: "s1", prompt: "text" },
    { sessionId: "s1", prompt: null }, { sessionId: "nope", prompt: [{ type: "text", text: "x" }] }, { sessionId: "", prompt: [{ type: "text", text: "x" }] }, { sessionId: "S1", prompt: [{ type: "text", text: "x" }] }, { sessionId: "s1 ", prompt: [{ type: "text", text: "x" }] }];
  out.push(S("prompt-param-forms", ins(...hello, ...params.map((p, i) => rq(i + 3, "session/prompt", p)))));
  out.push(S("prompt-text-is-never-logged", [...ins(...hello), ev.in(prompt("s1", "sk-live-PROMPT-TEXT-0123456789 password=hunter2")), ev.in(rq(4, "sk-live-METHOD-NAME-0123456789"))], simple([[{ text: "answer sk-live-OUTPUT-0123456789" }, { toolCall: { id: "t", name: "x", argsJson: '{"secret":"sk-live-ARGS-0123"}' } }]])));

  // --- outcomes of a turn
  out.push(S("prompt-outcome-completed-failed-cancelled", [...ins(...hello), ev.in(prompt("s1", "a", 3)), ev.in(prompt("s1", "b", 4)), ev.in(prompt("s1", "c", 5))], simple([[{ return: "completed" }], [{ text: "partial" }, { return: "failed", error: "sk-live-PROVIDER-ERROR-0123" }], [{ return: "cancelled" }]])));
  out.push(S("prompt-backend-throws", [...ins(...hello), ev.in(prompt("s1", "a", 3)), ev.in(prompt("s1", "b", 4)), ev.in(prompt("s1", "c", 5)), ev.in(prompt("s1", "d", 6))], simple([[{ throw: "RpcError" }], [{ throwAnon: true }], [{ text: "x" }, { throw: "TypeError" }], []])));
  out.push(S("prompt-script-exhausted", [...ins(...hello), ev.in(prompt("s1", "a", 3)), ev.in(prompt("s1", "b", 4))], simple([[{ text: "x" }]])));
  out.push(S("prompt-second-prompt-on-a-busy-session-is-refused", [...ins(...hello), ev.in(prompt("s1", "long", 3)), ev.in(prompt("s1", "other", 4)), ev.in(rq(5, "session/new", { cwd: "/w" })), ev.rel("g"), ev.in(prompt("s1", "again", 6))], simple([[{ text: "a" }, { gate: "g" }, { text: "b" }], [{ text: "again" }]], { create: [{ sessionId: "s1" }, { sessionId: "s2" }] })));
  out.push(S("prompt-two-sessions-run-side-by-side", [...ins(INIT, NEW(2), NEW(3)), ev.in(prompt("s1", "one", 4)), ev.in(prompt("s2", "two", 5)), ev.rel("g2"), ev.rel("g1")],
    simple([[{ text: "1a" }, { gate: "g1" }, { text: "1b" }], [{ text: "2a" }, { gate: "g2" }, { text: "2b" }]])));
  out.push(S("prompt-reply-follows-its-last-update", [...ins(...hello), ev.in(prompt("s1", "x")), ev.in(rq(4, "initialize", { protocolVersion: 1 }))], simple([[{ text: "a" }, { yield: 3 }, { text: "b" }]])));

  // --- cancel
  out.push(S("cancel-a-running-turn", [...ins(...hello), ev.in(prompt("s1", "x")), ev.in(nf("session/cancel", { sessionId: "s1" }))], simple([[{ text: "a" }, { awaitCancel: true }, { return: "cancelled" }]])));
  out.push(S("cancel-then-the-turn-completes-anyway", [...ins(...hello), ev.in(prompt("s1", "x")), ev.in(nf("session/cancel", { sessionId: "s1" })), ev.rel("g")], simple([[{ gate: "g" }, { return: "completed" }]])));
  out.push(S("cancel-then-the-turn-fails", [...ins(...hello), ev.in(prompt("s1", "x")), ev.in(nf("session/cancel", { sessionId: "s1" })), ev.rel("g")], simple([[{ gate: "g" }, { return: "failed", error: "e" }]])));
  out.push(S("cancel-then-the-backend-throws", [...ins(...hello), ev.in(prompt("s1", "x")), ev.in(nf("session/cancel", { sessionId: "s1" })), ev.rel("g")], simple([[{ gate: "g" }, { throw: "Error" }]])));
  out.push(S("cancel-twice", [...ins(...hello), ev.in(prompt("s1", "x")), ev.in(nf("session/cancel", { sessionId: "s1" })), ev.in(nf("session/cancel", { sessionId: "s1" })), ev.rel("g")], simple([[{ gate: "g" }]])));
  out.push(S("cancel-forms", [...ins(...hello), ev.in(prompt("s1", "x")), ...ins(nf("session/cancel", { sessionId: "nope" }), nf("session/cancel", { sessionId: "" }), nf("session/cancel", { sessionId: 5 }), nf("session/cancel", { sessionId: ["s1"] }), nf("session/cancel", {}), nf("session/cancel", []), nf("session/cancel", "s1"), nf("session/cancel"), nf("session/cancel", { sessionId: "S1" }), rq(9, "session/cancel", { sessionId: "s1" }), nf("$/cancel_request", { requestId: 3 })), ev.rel("g")], simple([[{ gate: "g" }]])));
  out.push(S("cancel-when-the-backend-cancel-fails", [...ins(...hello), ev.in(prompt("s1", "x")), ev.in(nf("session/cancel", { sessionId: "s1" })), ev.rel("g")], simple([[{ gate: "g" }]], { cancelError: true })));
  out.push(S("cancel-after-the-turn-is-done", [...ins(...hello), ev.in(prompt("s1", "x")), ev.in(nf("session/cancel", { sessionId: "s1" }))], simple([[{ text: "x" }]])));
  out.push(S("cancel-one-session-leaves-the-other", [...ins(INIT, NEW(2), NEW(3)), ev.in(prompt("s1", "one", 4)), ev.in(prompt("s2", "two", 5)), ev.in(nf("session/cancel", { sessionId: "s1" })), ev.rel("g"), ev.rel("h")], simple([[{ gate: "g" }], [{ gate: "h" }]])));

  // --- the end of the connection
  out.push(S("end-of-input-cancels-a-running-turn", [...ins(...hello), ev.in(prompt("s1", "x")), ev.end()], simple([[{ text: "a" }, { awaitCancel: true }, { return: "cancelled" }]])));
  out.push(S("end-of-input-with-a-turn-that-ignores-cancel", [...ins(...hello), ev.in(prompt("s1", "x")), ev.end()], simple([[{ gate: "never" }]])));
  out.push(S("end-of-input-and-the-turn-finishes-later", [...ins(...hello), ev.in(prompt("s1", "x")), ev.end(), ev.rel("g")], simple([[{ gate: "g" }, { text: "late" }]])));
  out.push(S("input-destroyed-cancels-a-running-turn", [...ins(...hello), ev.in(prompt("s1", "x")), ev.close()], simple([[{ awaitCancel: true }]])));
  out.push(S("input-destroyed-does-not-flush-a-partial-line", [...ins(INIT), ev.in(NEW(2).trimEnd()), ev.close()]));
  out.push(S("end-flushes-a-final-prompt-that-then-runs", [...ins(...hello), ev.in(prompt("s1", "last").trimEnd()), ev.end()], simple([[{ text: "x" }, { awaitCancel: true }]])));
  out.push(S("output-closed-during-a-turn", [...ins(...hello), ev.in(prompt("s1", "x")), ev.outClosed(), ev.in(rq(9, "initialize", { protocolVersion: 1 })), ev.rel("g")], simple([[{ text: "a" }, { gate: "g" }, { text: "b" }]])));
  out.push(S("output-closed-with-an-awaiting-turn-cancels-it", [...ins(...hello), ev.in(prompt("s1", "x")), ev.outClosed()], simple([[{ text: "a" }, { awaitCancel: true }, { text: "b" }]])));
  out.push(S("output-closed-before-anything", [ev.outClosed(), ev.in(INIT)]));

  // --- delivery: steering and follow-up
  const dl = (id: unknown, method: string, p: unknown) => rq(id, method, p);
  const dBackend = (extra: any = {}) => ({ ...DELIVERY, create: [{ sessionId: "s1" }], deliver: [{ resultJson: '{"queued":true,"n":1}' }, { resultJson: '"ok"' }, {}, { resultJson: "null" }, { fail: "delivery-unavailable" }, { fail: "unknown-session" }, { error: "Error" }, { errorAnon: true }], prompts: [[{ text: "x" }]], ...extra });
  const steer = (id: unknown, p: unknown) => dl(id, "_app.plur1bus/steer", p);
  const follow = (id: unknown, p: unknown) => dl(id, "_app.plur1bus/follow_up", p);
  const txt = (t: string) => [{ type: "text", text: t }];
  out.push(S("delivery-steer-and-follow-up", ins(...hello, steer(3, { sessionId: "s1", prompt: txt("steer now") }), follow(4, { sessionId: "s1", prompt: txt("later") }), steer(5, { sessionId: "s1", prompt: txt("x") }), follow(6, { sessionId: "s1", prompt: txt("y") }), steer(7, { sessionId: "s1", prompt: txt("z") }), follow(8, { sessionId: "s1", prompt: txt("z") }), steer(9, { sessionId: "s1", prompt: txt("z") }), follow(10, { sessionId: "s1", prompt: txt("z") })), dBackend()));
  out.push(S("delivery-refused-forms", ins(...hello, steer(3, { sessionId: "s1", prompt: [] }), steer(4, { sessionId: "nope", prompt: txt("x") }), steer(5, { sessionId: "s1" }), steer(6, { prompt: txt("x") }), steer(7, null), steer(8, { sessionId: "s1", prompt: "x" }), steer(9, { sessionId: "s1", prompt: [{ type: "image" }] }), follow(10, { sessionId: "s1", prompt: txt("  ") }), steer(11, { sessionId: 5, prompt: txt("x") })), dBackend()));
  out.push(S("delivery-unsupported-is-method-not-found", ins(...hello, steer(3, { sessionId: "s1", prompt: txt("x") }), follow(4, { sessionId: "s1", prompt: txt("x") })), simple()));
  out.push(S("delivery-steer-only", ins(INIT, NEW(2), steer(3, { sessionId: "s1", prompt: txt("x") }), follow(4, { sessionId: "s1", prompt: txt("x") })), dBackend({ features: { steer: true } })));
  out.push(S("delivery-without-the-deliver-function", ins(INIT, NEW(2), steer(3, { sessionId: "s1", prompt: txt("x") })), dBackend({ hasDeliver: false })));
  out.push(S("delivery-after-the-end-of-input-is-refused", [...ins(...hello), ev.in(prompt("s1", "x")), ev.end(), ev.rel("g")], dBackend({ prompts: [[{ gate: "g" }]] })));
  out.push(S("delivery-during-a-turn", [...ins(...hello), ev.in(prompt("s1", "x")), ev.in(steer(4, { sessionId: "s1", prompt: txt("now") })), ev.rel("g")], dBackend({ prompts: [[{ text: "a" }, { gate: "g" }, { text: "b" }]] })));

  // --- modes
  out.push(S("modes-new-session-reports-the-mode", ins(INIT, NEW(2), NEW(3), NEW(4)), { ...MODES, create: [{ sessionId: "s1", modeJson: '"chat"' }, { sessionId: "s2", modeJson: '"coding"' }, { sessionId: "s3", modeJson: '"chat"' }] }));
  out.push(S("modes-new-session-in-german", ins(INIT, NEW(2), NEW(3)), { ...MODES, create: [{ sessionId: "s1", modeJson: '"chat"' }, { sessionId: "s2", modeJson: '"coding"' }] }, { server: { language: "de" } }));
  for (const [n, m] of [["bogus", '"bogus"'], ["number", "5"], ["null", "null"], ["absent", undefined], ["uppercase", '"Chat"'], ["padded", '"chat "'], ["object", '{"id":"chat"}'], ["array", '["chat"]'], ["empty", '""']] as const) {
    out.push(S(`modes-new-session-with-${n}-mode-is-an-internal-error`, ins(INIT, NEW(2), NEW(3)), { ...MODES, create: [{ sessionId: "s1", ...(m !== undefined ? { modeJson: m } : {}) }, { sessionId: "s2", modeJson: '"chat"' }] }));
  }
  out.push(S("modes-reported-but-not-offered", ins(INIT, NEW(2), NEW(3)), { create: [{ sessionId: "s1", modeJson: '"chat"' }, { sessionId: "s2", modeJson: '"bogus"' }] }));
  out.push(S("modes-feature-without-set-mode", ins(INIT, NEW(2), rq(3, "session/set_mode", { sessionId: "s1", modeId: "chat" })), { ...MODES, hasSetMode: false, create: [{ sessionId: "s1", modeJson: '"chat"' }] }));
  out.push(S("modes-set-mode-changes-and-announces", ins(INIT, NEW(2), rq(3, "session/set_mode", { sessionId: "s1", modeId: "coding" }), rq(4, "session/set_mode", { sessionId: "s1", modeId: "coding" }), rq(5, "session/set_mode", { sessionId: "s1", modeId: "chat" })), bothModes()));
  out.push(S("modes-set-mode-announces-in-german", ins(INIT, NEW(2), rq(3, "session/set_mode", { sessionId: "s1", modeId: "coding" })), bothModes(), { server: { language: "de" } }));
  const modeParams: any[] = [undefined, null, [], {}, { sessionId: "s1" }, { modeId: "chat" }, { sessionId: "s1", modeId: "bogus" }, { sessionId: "s1", modeId: "Chat" }, { sessionId: "s1", modeId: "chat " }, { sessionId: "s1", modeId: 5 }, { sessionId: "s1", modeId: null }, { sessionId: "s1", modeId: ["chat"] },
    { sessionId: 5, modeId: "chat" }, { sessionId: "nope", modeId: "chat" }, { sessionId: "", modeId: "chat" }];
  out.push(S("modes-set-mode-param-forms", ins(INIT, NEW(2), ...modeParams.map((p, i) => rq(i + 3, "session/set_mode", p))), bothModes()));
  out.push(S("modes-set-mode-backend-failures", ins(INIT, NEW(2), rq(3, "session/set_mode", { sessionId: "s1", modeId: "coding" }), rq(4, "session/set_mode", { sessionId: "s1", modeId: "coding" }), rq(5, "session/set_mode", { sessionId: "s1", modeId: "coding" }), rq(6, "session/set_mode", { sessionId: "s1", modeId: "coding" })),
    bothModes({ mode: [{ fail: "mode-unavailable" }, { fail: "unknown-session" }, { error: "Error" }, { errorAnon: true }] })));
  out.push(S("modes-set-mode-without-the-feature", ins(INIT, NEW(2), rq(3, "session/set_mode", { sessionId: "s1", modeId: "chat" })), simple()));
  out.push(S("modes-set-mode-reports-the-mode-the-core-says", ins(INIT, NEW(2), rq(3, "session/set_mode", { sessionId: "s1", modeId: "coding" }), rq(4, "session/set_mode", { sessionId: "s1", modeId: "coding" }), rq(5, "session/set_mode", { sessionId: "s1", modeId: "coding" })),
    bothModes({ mode: [{ modeJson: '"chat"', changed: true }, { modeJson: '"whatever"', changed: true }, { modeJson: '{"a":[1,2]}', changed: true }] })));
  out.push(S("modes-do-not-open-the-handshake", ins(rq(1, "session/set_mode", { sessionId: "s1", modeId: "chat" }), INIT), bothModes()));
  return out;
}

// Large scenarios live in their own fixture file so that no vector file passes 1 MiB.
export function buildLimits(): Scenario[] {
  const out: Scenario[] = [];
  const head = (id: number) => `{"jsonrpc":"2.0","id":${id},"method":"session/prompt","params":{"sessionId":"s1","prompt":[{"type":"text","text":"`;
  const tail = `"}]}}\n`;
  const rep = (id: number, unit: string, count: number) => ({ repeat: { prefix: head(id), unit, count, suffix: tail } });
  out.push(S("prompt-length-in-utf16-units", [...ins(...hello), rep(3, "a", 200000), rep(4, "a", 200001), rep(5, "😀", 100001)], simple([[{ text: "1" }]])));
  const big = (n: number) => JSON.stringify({ path: "big.txt", content: "a".repeat(n) });
  out.push(S("prompt-raw-input-size-limit", [...ins(...hello), ev.in(prompt("s1", "files"))], simple([[
    { toolCall: { id: "w1", name: "file.write", argsJson: big(131072 - 33) } },
    { toolCall: { id: "w2", name: "file.write", argsJson: big(131072 - 32) } },
    { toolCall: { id: "w3", name: "file.write", argsJson: big(131072 - 31) } },
  ]])));
  return out;
}
