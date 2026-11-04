/** D120 CX1: real Core/RPC admission preserves retained transcript bytes and the kept provider-message prefix. */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import { defaults } from "@plur1bus/config-schema";
import { validateResult } from "@plur1bus/rpc-schema";
import { createCore } from "../../src/core.ts";
import { layout } from "../../src/paths.ts";
import { FakeChatProvider, type ChatRequest } from "../../src/session/provider.ts";
import { flatTestInternals } from "../helpers/flat-embedder.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import { connect } from "../helpers/connect.ts";

test("real Core rewind/undo preserves original rows and removes the discarded path before the next provider call", async () => {
  const home = tempDir("p1b-rewind-");
  const config = defaults();
  config.agents.a = {};
  config.engine = { neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false },
    merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false },
    temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false },
    reranker: { enabled: false }, duplicateThreshold: 1.01 };
  writeFileSync(layout(home).configPath, JSON.stringify(config));
  const requests: ChatRequest[] = [];
  const core = createCore({ home, testInternals: flatTestInternals(),
    chatProvider: new FakeChatProvider({ onRequest: request => { requests.push(request); } }),
    discovery: { scheduler: false }, dreams: { scheduler: false } });
  let client: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    await core.start();
    client = await connect({ address: core.address, token: core.token });
    const caller = { channel: "cli", accountId: "host", userId: "alice" };
    const created = await client.call<{ session: { id: string } }>("session.create", { caller, agentId: "a" });
    const sessionId = created.session.id;
    for (const text of ["KEPT_INTERFACE", "DISCARDED_EDIT_ATTEMPT"]) {
      await client.call("session.submit", { caller, sessionId, text, wait: true });
    }
    const before = await client.call<{ messages: unknown[] }>("session.resume", { caller, sessionId });
    const events = await client.call<{ events: unknown[] }>("session.events", { caller, sessionId });
    const prefix = requests.at(-1)!.messages.slice(0, 2);
    const rewound = await client.call<{ rewind: { id: string } }>("session.rewind", {
      caller, sessionId, toSeq: 2, lesson: "Use the inspected interface.",
    });
    assert.deepEqual(validateResult("session.rewind", { sessionId, ...rewound }), { ok: true });
    await client.call("session.submit", { caller, sessionId, text: "CONTINUE_CLEAN", wait: true });
    assert.deepEqual(requests.at(-1)!.messages.slice(0, 2), prefix);
    assert.doesNotMatch(JSON.stringify(requests.at(-1)!.messages), /DISCARDED_EDIT_ATTEMPT/);
    const after = await client.call<{ messages: { rewound?: boolean }[]; rewinds: { id: string }[] }>("session.resume", { caller, sessionId });
    assert.equal(after.messages[2]?.rewound, true, "the actual guarded transcript reader marks the discarded message");
    assert.equal(after.rewinds[0]?.id, rewound.rewind.id);
    const retained = after.messages.slice(0, 4).map(({ rewound: _visible, ...message }) => message);
    assert.deepEqual(retained, before.messages);
    const afterEvents = await client.call<{ events: unknown[] }>("session.events", { caller, sessionId });
    assert.deepEqual(afterEvents.events.slice(0, events.events.length), events.events);
    await client.call("session.rewind", { caller, sessionId, undo: rewound.rewind.id });
    await client.call("session.submit", { caller, sessionId, text: "CONTINUE_RESTORED", wait: true });
    assert.match(JSON.stringify(requests.at(-1)!.messages), /DISCARDED_EDIT_ATTEMPT/);
  } finally {
    await client?.close();
    await core.stop({ budgetMs: 5000 });
  }
});
