import { MatrixChannel, MemorySyncTokenStore, type MatrixChannelOptions, type RichInbound, type SyncTokenStore } from "../../src/index.ts";
import { ALICE, BOT, FAKE_TOKEN, FakeMatrix, ROOM } from "./fake-matrix.ts";

export const SECRET_NAME = "matrix/bot-token";

export interface HostLog {
  info(msg: string, f?: Record<string, unknown>): void;
  warn(msg: string, f?: Record<string, unknown>): void;
  error(msg: string, f?: Record<string, unknown>): void;
}

/** Everything a test needs: a fresh fake homeserver, a channel wired to it, and capture of every log line and host call. */
export class Rig {
  readonly fake: FakeMatrix;
  readonly logs: string[] = [];
  readonly sleeps: number[] = [];
  readonly received: { text: string; chatId: string; senderId: string }[] = [];
  readonly rich: RichInbound[] = [];
  readonly failures: unknown[] = [];
  readonly host;
  readonly store: SyncTokenStore;
  ch: MatrixChannel;
  #opts: MatrixChannelOptions;

  constructor(fake: FakeMatrix, over: Partial<MatrixChannelOptions> = {}, store?: SyncTokenStore) {
    this.fake = fake;
    this.store = store ?? new MemorySyncTokenStore();
    const log = (level: string) => (msg: string, f?: Record<string, unknown>) => {
      this.logs.push(JSON.stringify({ level, msg, f }));
    };
    this.host = {
      receive: async (m: { text: string; chatId: string; senderId: string }) => {
        this.received.push({ text: m.text, chatId: m.chatId, senderId: m.senderId });
      },
      fail: (e: unknown) => void this.failures.push(e),
      log: { info: log("info"), warn: log("warn"), error: log("error") } as HostLog,
    };
    this.#opts = {
      homeserverUrl: fake.baseUrl,
      userId: BOT,
      accessTokenSecret: SECRET_NAME,
      allowlist: [ROOM],
      dmAllowlist: [ALICE],
      replyPolicy: "mention",
      secrets: { reveal: async (n: string) => (n === SECRET_NAME ? FAKE_TOKEN : null) },
      syncStore: this.store,
      logger: { log: (level, event, attrs) => void this.logs.push(JSON.stringify({ level, event, attrs })) },
      sleep: async (ms) => void this.sleeps.push(ms),
      random: () => 0.5,
      syncTimeoutMs: 5000,
      ...over,
    };
    this.ch = new MatrixChannel(this.#opts);
  }

  /** Re-create the channel with the same store and fake (restart). */
  recreate(over: Partial<MatrixChannelOptions> = {}): void {
    this.ch = new MatrixChannel({ ...this.#opts, ...over });
  }

  async start(): Promise<void> {
    await this.ch.start(this.host as never);
    await this.fake.waitIdle();
  }

  onMessage(): void {
    this.ch.onMessage((m) => void this.rich.push(m));
  }

  /** Every log line as a string, for secret and content scans. */
  allLogText(): string {
    return this.logs.join("\n");
  }

  async close(): Promise<void> {
    await this.ch.stop().catch(() => {});
    await this.fake.close();
  }
}

export async function newFake(): Promise<FakeMatrix> {
  const fake = new FakeMatrix();
  await fake.listen();
  fake.addRoom(ROOM, { members: 3 });
  return fake;
}

export const textOf = (r: Rig) => r.received.map((m) => m.text);
