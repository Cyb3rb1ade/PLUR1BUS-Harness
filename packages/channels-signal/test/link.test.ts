import assert from "node:assert/strict";
import { test } from "node:test";
import { DM, GROUP, STRANGER, push, rig } from "./helpers/setup.ts";
import { textEnvelope } from "./helpers/fake-daemon.ts";
import { ACCOUNT } from "./helpers/setup.ts";

const CODE = "PAIR-7Q2K-ZZ";

function pairing(ok: boolean) {
  const claims: unknown[] = [];
  return {
    claims,
    pairing: {
      claim: (p: unknown) => {
        claims.push(p);
        if (!ok) throw new Error("no such code");
        return { pairingId: "p1", state: "awaiting-confirmation" as const, confirmBy: 0 };
      },
    } as never,
  };
}

test("link: /link in a DM claims the code with channel, bot account and the sender identity", async () => {
  const p = pairing(true);
  const r = await rig({ pairing: p.pairing });
  try {
    await push(r, textEnvelope({ message: `/link ${CODE}` }));
    assert.deepEqual(p.claims, [{ code: CODE, identity: { channel: "signal", accountId: ACCOUNT, userId: DM } }]);
    assert.equal(r.daemon.sent().at(-1)!.message, "Pairing claimed. Pairing ID: p1. Confirm this link in My identities. Run: plur1bus identity approve p1");
    assert.equal(r.received.length, 0, "commands are not forwarded as text");
  } finally {
    await r.close();
  }
});

test("link: failure gets the same uniform reply as the fail path and no detail", async () => {
  const p = pairing(false);
  const r = await rig({ pairing: p.pairing });
  try {
    await push(r, textEnvelope({ message: `/link ${CODE}` }));
    assert.equal(r.daemon.sent().at(-1)!.message, "Pairing failed. Request a new code in My identities.");
  } finally {
    await r.close();
  }
});

test("link: the code never appears in logs, RPC errors or any outbound text other than the fixed reply", async () => {
  const p = pairing(false);
  const r = await rig({ pairing: p.pairing });
  try {
    await push(r, textEnvelope({ message: `/link ${CODE}` }));
    assert.ok(!JSON.stringify(r.logs).includes(CODE));
    assert.ok(!r.daemon.sent().some((s) => String(s.message).includes(CODE)));
  } finally {
    await r.close();
  }
});

test("link: without a pairing port the command is not claimed and replies with the failure text", async () => {
  const r = await rig();
  try {
    await push(r, textEnvelope({ message: `/link ${CODE}` }));
    assert.equal(r.daemon.sent().at(-1)!.message, "Pairing failed. Request a new code in My identities.");
  } finally {
    await r.close();
  }
});

test("link: /link in a group is not a pairing command", async () => {
  const p = pairing(true);
  const r = await rig({ pairing: p.pairing, replyPolicy: "always" });
  try {
    await push(r, textEnvelope({ message: `/link ${CODE}`, groupId: GROUP }));
    assert.equal(p.claims.length, 0);
  } finally {
    await r.close();
  }
});

test("link: a stranger's /link is dropped by the DM gate, no claim, no reply", async () => {
  const p = pairing(true);
  const r = await rig({ pairing: p.pairing });
  try {
    await push(r, textEnvelope({ number: STRANGER, message: `/link ${CODE}` }));
    assert.equal(p.claims.length, 0);
    assert.equal(r.daemon.callsOf("send").length, 0);
  } finally {
    await r.close();
  }
});

test("link: /help replies locally with the command list", async () => {
  const r = await rig();
  try {
    await push(r, textEnvelope({ message: "/help" }));
    assert.match(String(r.daemon.sent().at(-1)!.message), /\/link <code>/);
    assert.equal(r.received.length, 0);
  } finally {
    await r.close();
  }
});

test("link: German locale uses the German strings", async () => {
  const p = pairing(true);
  const r = await rig({ pairing: p.pairing, locale: "de" });
  try {
    await push(r, textEnvelope({ message: `/link ${CODE}` }));
    assert.equal(r.daemon.sent().at(-1)!.message, "Kopplung angenommen. ID: p1. Bestätige die Verknüpfung unter Meine Identitäten. Freigabe: plur1bus identity approve p1");
  } finally {
    await r.close();
  }
});
