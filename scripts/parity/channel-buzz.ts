import { BuzzChannel } from "../../packages/channels-buzz/src/index.ts";
import { finalizeEvent, getPublicKey, unwrapEvent, createRumor, createSeal, createWrap } from "../../packages/channels-buzz/src/nostr.ts";

const now = 1_700_000_000;
const relay = "wss://relay.fixture.invalid/";
const own = Buffer.alloc(32, 1);
const peer = Buffer.alloc(32, 2);
const recipient = getPublicKey(own);
const sender = getPublicKey(peer);

function deterministicPeer() {
  const originalRandom = Math.random;
  const originalNow = Date.now;
  const ownMethod = Object.getOwnPropertyDescriptor(crypto, "getRandomValues");
  let draw = 0;
  // The override is synchronous and scoped to the synthetic peer's crypto calls.
  Object.defineProperty(crypto, "getRandomValues", { configurable: true, value: (bytes: Uint8Array) => bytes.fill(++draw) });
  Math.random = () => 0.25;
  Date.now = () => now * 1000;
  try {
    const metadata = finalizeEvent({ kind: 10050, created_at: now, content: "", tags: [["relay", relay]] }, peer);
    const rumor = createRumor({ kind: 14, created_at: now, content: "Grüße vom Fixture", tags: [["p", recipient]] }, peer);
    const wrapped = createWrap(createSeal(rumor, peer, recipient), recipient);
    const repeated = createWrap(createSeal(rumor, peer, recipient), recipient);
    return { metadata, wrapped, repeated };
  } finally {
    if (ownMethod) Object.defineProperty(crypto, "getRandomValues", ownMethod);
    else Reflect.deleteProperty(crypto, "getRandomValues");
    Math.random = originalRandom;
    Date.now = originalNow;
  }
}

export async function buzzRelay() {
  const transfer = deterministicPeer();
  const captured: unknown[][] = [];
  const messages: unknown[] = [];
  let saved: string[] = [];
  let connection: Parameters<NonNullable<ConstructorParameters<typeof BuzzChannel>[1]["connect"]>>[0] | undefined;
  const channel = new BuzzChannel({ relays: [relay], senderAllowlist: [sender] }, {
    secrets: { reveal: async () => own.toString("hex") },
    egress: { decide: async () => ({ allowed: true, host: "relay.fixture.invalid", port: 443, address: "127.0.0.1", family: 4 }) },
    seen: { load: async () => [], save: async (ids) => { saved = [...ids]; } },
    now: () => now * 1000,
    connect: async (c) => {
      connection = c;
      return {
        send: async (value) => {
          const packet = value as [string, Record<string, unknown>];
          captured.push(packet);
          if (packet[0] === "EVENT") await c.onMessage(["OK", packet[1].id, true, ""]);
        },
        close: async () => { c.onClose(); },
      };
    },
  });
  try {
    await channel.start({
      receive: async (m) => { messages.push({ text: m.text, senderId: m.senderId, messageId: m.messageId, persisted: saved.includes(m.messageId!) }); },
      fail: () => {}, log: { info() {}, warn() {}, error() {} },
    });
    for (let i = 0; captured.length < 3 && i < 40; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (!connection || captured.length !== 3) throw new Error("Buzz fixture did not subscribe");
    const info = captured[2]![1] as Record<string, unknown>;
    const input = [
      ["EVENT", "buzz-relays", JSON.parse(JSON.stringify(transfer.metadata))],
      ["EOSE", "buzz-relays"],
      ["EVENT", "buzz-inbox", JSON.parse(JSON.stringify(transfer.wrapped))],
      ["EVENT", "buzz-inbox", JSON.parse(JSON.stringify(transfer.repeated))],
      ["EOSE", "buzz-inbox"],
    ];
    for (const frame of input) {
      await connection.onMessage(frame);
      await channel.idle();
    }
    const auth = ["synthetic challenge", "second challenge", "third challenge", "ignored fourth"];
    for (const challenge of auth) await connection.onMessage(["AUTH", challenge]);
    const authentication = captured.filter((p) => p[0] === "AUTH").map((p) => {
      const { sig: _sig, ...event } = p[1] as Record<string, unknown>;
      return event;
    });
    const response = "Reply from the fixture";
    await channel.send({ chatId: sender, text: response });
    const published = captured.filter((p) => p[0] === "EVENT" && (p[1] as { kind: number }).kind === 1059)
      .map((p) => {
        const e = p[1] as Parameters<typeof unwrapEvent>[0];
        const toPeer = e.tags.some((t) => t[0] === "p" && t[1] === sender);
        const rumor = unwrapEvent(e, toPeer ? peer : own);
        return { toPeer, id: rumor.id, text: rumor.content, kind: rumor.kind, tags: rumor.tags };
      });
    const { sig: _sig, ...announcement } = info;
    const requests = captured.slice(0, 2);
    return { source: "packages/channels-buzz/src/index.ts", transport: "websocket", now, relay, recipient, sender, auth, response,
      exchanges: [{ send: requests, receive: input }],
      requestTexts: requests.map((packet) => JSON.stringify(packet)),
      expected: { messages, saved, authentication, announcement, published },
    };
  } finally {
    await channel.stop();
  }
}
