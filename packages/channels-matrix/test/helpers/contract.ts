import { readFileSync } from "node:fs";
import { MatrixChannel, MemorySyncTokenStore } from "../../src/index.ts";
import { ALICE, BOT, CAROL, DM, FakeMatrix, ROOM, textMessage } from "./fake-matrix.ts";
import { FAKE_TOKEN } from "./fake-matrix.ts";
import { newFake } from "./rig.ts";

/** Shape the lead's shared contract suite (packages/channels-discord/test/contract.test.ts) relies on. */
export interface ContractHarness {
  readonly name: string;
  readonly manifest: unknown;
  readonly channel: MatrixChannel;
  readonly secretValues: readonly string[];
  readonly logs: unknown[];
  deliverDirect(text: string): Promise<void>;
  deliverGroupMentioned(text: string): Promise<void>;
  deliverGroupUnmentioned(text: string): Promise<void>;
  sentTexts(): string[];
  withMissingSecret(): Promise<MatrixChannel>;
  dispose(): Promise<void>;
}

const MANIFEST = JSON.parse(readFileSync(new URL("../../channel.json", import.meta.url), "utf8")) as unknown;
const SECRET = "matrix/bot-token";

export async function makeContractHarness(): Promise<ContractHarness> {
  const fake: FakeMatrix = await newFake();
  fake.addRoom(DM, { members: 2 });
  fake.direct = { [ALICE]: [DM] };
  const logs: unknown[] = [];
  const logger = { log: (level: string, event: string, attrs: unknown) => void logs.push({ level, event, attrs }) };
  const base = {
    homeserverUrl: fake.baseUrl,
    userId: BOT,
    accessTokenSecret: SECRET,
    allowlist: [ROOM],
    dmAllowlist: [ALICE],
    replyPolicy: "mention" as const,
    syncStore: new MemorySyncTokenStore(),
    logger,
    sleep: async () => {},
    random: () => 0.5,
    syncTimeoutMs: 5000,
  };
  const channel = new MatrixChannel({ ...base, secrets: { reveal: async (n: string) => (n === SECRET ? FAKE_TOKEN : null) } });
  const withMissingSecret = async () =>
    new MatrixChannel({ ...base, syncStore: new MemorySyncTokenStore(), secrets: { reveal: async () => null } });
  return {
    name: "matrix",
    manifest: MANIFEST,
    channel,
    secretValues: [FAKE_TOKEN],
    logs,
    deliverDirect: (text) => fake.deliver(DM, [fake.message(DM, ALICE, textMessage(text))]),
    deliverGroupMentioned: (text) =>
      fake.deliver(ROOM, [fake.message(ROOM, CAROL, textMessage(`${BOT} ${text}`, { "m.mentions": { user_ids: [BOT] } }))]),
    deliverGroupUnmentioned: (text) => fake.deliver(ROOM, [fake.message(ROOM, CAROL, textMessage(text))]),
    sentTexts: () =>
      fake.sent.filter((s) => s.type === "m.room.message" && typeof s.content.body === "string").map((s) => s.content.body as string),
    withMissingSecret,
    dispose: () => fake.close(),
  };
}
