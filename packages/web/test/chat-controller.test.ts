// ChatController without a browser (audit b19): a stale answer never replaces a newer one.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { signal } from "@preact/signals";
import type { Api } from "../src/api/index.ts";
import { ChatController } from "../src/pages/chat/controller.ts";

type Resume = { session: unknown; runningTurnId: null; messages: unknown[]; lastEventSeq: number };
const resume = (text: string, lastEventSeq: number): Resume => ({
  session: { id: "s1", agentId: "bernd", title: "", memoryMode: "remember" }, runningTurnId: null, lastEventSeq,
  messages: [{ id: `m_${text}`, seq: 1, role: "user", text, turnId: "t1", createdAt: 1 }],
});

function fakeApi(resumes: Promise<Resume>[]): Api {
  let i = 0;
  return {
    rpc: (method: string) => (method === "session.resume" ? resumes[i++] : Promise.resolve({ events: [] })),
    events: () => ({ status: signal("connecting"), close: () => undefined }),
  } as unknown as Api;
}

describe("chat controller: stale answers", () => {
  test("a slow, older session.resume that lands last does not replace the newer one (Try again)", async () => {
    let older!: (r: Resume) => void;
    const first = new Promise<Resume>((res) => { older = res; });
    const ctl = new ChatController("s1", fakeApi([first, Promise.resolve(resume("new", 9))]));
    const a = ctl.start();
    const b = ctl.start();
    await b;
    older(resume("old", 3));
    await a;
    ctl.stop();
    assert.deepEqual(ctl.tr.value.entries.map((e) => e.text), ["new"]);
    assert.equal(ctl.tr.value.lastSeq, 9);
  });
});
