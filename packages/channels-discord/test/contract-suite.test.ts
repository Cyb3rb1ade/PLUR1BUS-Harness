// Shared contract suite: the five wave-2 channels (discord, slack, matrix, signal, email) against the core `Channel` contract.
// Each package supplies `test/helpers/contract.ts`. This suite lives in channels-discord so that its `test` script runs it once;
// it imports the other four packages by relative path (Telegram imports core the same way).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ChannelRouter, validateChannelManifest, type ChannelHost, type InboundMessage } from "../../core/src/channels/index.ts";
import { FakeClock, FakeIdentity, FakeSessions } from "../../core/test/channels/helpers.ts";
import { makeContractHarness as discord } from "./helpers/contract.ts";
import { makeContractHarness as email } from "../../channels-email/test/helpers/contract.ts";
import { makeContractHarness as matrix } from "../../channels-matrix/test/helpers/contract.ts";
import { makeContractHarness as signal } from "../../channels-signal/test/helpers/contract.ts";
import { makeContractHarness as slack } from "../../channels-slack/test/helpers/contract.ts";

// Each package\'s harness has the same shared fields; the suite reads only those, so one harness type covers all five.
type Harness = Awaited<ReturnType<typeof discord>>;
type Factory = () => Promise<Harness>;
const as = (f: () => Promise<unknown>): Factory => f as Factory;
const suites: [string, Factory][] = [["discord", discord], ["email", as(email)], ["matrix", as(matrix)], ["signal", as(signal)], ["slack", as(slack)]];

const silent = { info() {}, warn() {}, error() {} };

function hostFor(received: InboundMessage[], log: unknown[]): ChannelHost {
  const sink = (level: string) => (msg: string, fields?: Record<string, unknown>) => { log.push({ level, msg, fields }); };
  return {
    receive: async (m) => { received.push(m); },
    fail: () => {},
    log: { info: sink("info"), warn: sink("warn"), error: sink("error") },
  };
}

for (const [id, make] of suites) {
  describe(`channel contract: ${id}`, () => {
    it("ships a valid manifest whose name is the channel name", async () => {
      const h = await make();
      try {
        const v = validateChannelManifest(h.manifest);
        assert.ok(v.ok, v.ok ? "" : v.errors.join("; "));
        assert.equal(h.channel.name, id);
        assert.equal(v.ok && v.manifest.kind, "channel");
      } finally { await h.dispose(); }
    });

    it("declares complete, typed capabilities", async () => {
      const h = await make();
      try {
        const c = h.channel.capabilities;
        for (const k of ["threads", "edit", "typing", "attachmentsIn", "attachmentsOut", "reactions", "buttons"] as const) assert.equal(typeof c[k], "boolean", k);
        assert.ok(["buttons", "reactions", "reply-code"].includes(c.approvalMode));
        assert.ok(["native", "converted", "html", "plain"].includes(c.markdown));
        assert.ok(Number.isInteger(c.maxMessageChars) && c.maxMessageChars > 0);
      } finally { await h.dispose(); }
    });

    it("is unhealthy and refuses to send before start", async () => {
      const h = await make();
      try {
        assert.equal((await h.channel.health()).ok, false);
        await assert.rejects(h.channel.send({ chatId: "x", text: "hi" }));
      } finally { await h.dispose(); }
    });

    it("starts idempotently, reports healthy, stops idempotently and restarts", async () => {
      const h = await make();
      try {
        const host = hostFor([], h.logs);
        await Promise.all([h.channel.start(host), h.channel.start(host)]);
        assert.equal((await h.channel.health()).ok, true);
        await h.channel.stop();
        await h.channel.stop();
        assert.equal((await h.channel.health()).ok, false);
        await h.channel.start(host);
        assert.equal((await h.channel.health()).ok, true);
        await h.channel.stop();
      } finally { await h.dispose(); }
    });

    it("hands a direct message to the host as a well-formed InboundMessage", async () => {
      const h = await make();
      try {
        const received: InboundMessage[] = [];
        await h.channel.start(hostFor(received, h.logs));
        await h.deliverDirect("hello contract");
        assert.equal(received.length, 1);
        const m = received[0]!;
        assert.equal(m.channel, id);
        assert.equal(m.chatKind, "direct");
        assert.ok(m.chatId.length > 0 && m.chatId.length <= 256);
        assert.ok(m.senderId.length > 0 && m.senderId.length <= 256);
        assert.ok(m.text.includes("hello contract"));
        await h.channel.stop();
      } finally { await h.dispose(); }
    });

    it("answers unmentioned group traffic not at all, and mentioned traffic once", async () => {
      const h = await make();
      try {
        const received: InboundMessage[] = [];
        await h.channel.start(hostFor(received, h.logs));
        await h.deliverGroupUnmentioned("not for the bot");
        assert.equal(received.length, 0);
        await h.deliverGroupMentioned("for the bot");
        assert.equal(received.length, 1);
        assert.ok(received[0]!.text.includes("for the bot"));
        await h.channel.stop();
      } finally { await h.dispose(); }
    });

    it("round-trips through the real router: a linked sender gets the session reply on the platform", async () => {
      const h = await make();
      try {
        const clock = new FakeClock();
        const identity = new FakeIdentity();
        const sessions = new FakeSessions();
        const router = new ChannelRouter({ identity, sessions, clock, log: silent });
        const host: ChannelHost = {
          receive: (m) => { identity.link(id, m.senderId, "user-1"); return router.handle(m, (out) => h.channel.send(out)); },
          fail() {}, log: silent,
        };
        await h.channel.start(host);
        await h.deliverDirect("ping");
        assert.ok(h.sentTexts().some((t) => t.includes("echo:ping")), JSON.stringify(h.sentTexts()));
        await h.channel.stop();
      } finally { await h.dispose(); }
    });

    it("delivers long outbound text without losing content", async () => {
      const h = await make();
      try {
        const received: InboundMessage[] = [];
        await h.channel.start(hostFor(received, h.logs));
        await h.deliverDirect("seed");
        const chatId = received[0]!.chatId;
        const words = Array.from({ length: 1500 }, (_, i) => `w${i}`);
        await h.channel.send({ chatId, text: words.join(" ") });
        const joined = h.sentTexts().join(" ");
        for (const probe of ["w0", "w700", "w1499"]) assert.ok(joined.includes(probe), probe);
        await h.channel.stop();
      } finally { await h.dispose(); }
    });

    it("rejects start with a missing secret and reports unhealthy", async () => {
      const h = await make();
      try {
        const bad = await h.withMissingSecret();
        await assert.rejects(bad.start(hostFor([], h.logs)));
        assert.equal((await bad.health()).ok, false);
        await bad.stop();
      } finally { await h.dispose(); }
    });

    it("keeps credentials out of every log line", async () => {
      const h = await make();
      try {
        const hostLog: unknown[] = [];
        await h.channel.start(hostFor([], hostLog));
        await h.deliverDirect("log check");
        await h.deliverGroupUnmentioned("noise");
        await h.channel.stop();
        const text = JSON.stringify([...h.logs, ...hostLog]);
        for (const secret of h.secretValues) assert.ok(!text.includes(secret), "secret leaked into logs");
      } finally { await h.dispose(); }
    });
  });
}
