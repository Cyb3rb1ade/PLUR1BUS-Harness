import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EmailChannel, MemoryUidStore, parseMessage, type EmailChannelOptions, type EmailConfig } from "../../src/index.ts";
import type { SecretReader } from "../../src/port.ts";
import { FakeImap } from "./fake-imap.ts";
import { FakeSmtp } from "./fake-smtp.ts";

export interface ContractHarness {
  readonly name: string;
  readonly manifest: unknown;
  readonly channel: EmailChannel;
  readonly secretValues: readonly string[];
  readonly logs: unknown[];
  deliverDirect(text: string): Promise<void>;
  deliverGroupMentioned(text: string): Promise<void>;
  deliverGroupUnmentioned(text: string): Promise<void>;
  sentTexts(): string[];
  withMissingSecret(): Promise<EmailChannel>;
  dispose(): Promise<void>;
}

export const BOT = "bot@example.test";
export const ALLOWED = "alice@example.test";
export const STRANGER = "mallory@evil.example";
export const CAROL = "carol@example.test";
const IMAP_SECRET = "EMAIL_IMAP_PASSWORD";
const SMTP_SECRET = "EMAIL_SMTP_PASSWORD";
export const IMAP_PW = "invented-imap-password-9f2c";
export const SMTP_PW = "invented-smtp-password-4b7d";

export interface FixtureMail {
  from: string;
  subject?: string;
  body: string;
  messageId: string;
  extraHeaders?: string[];
  /** Authentication-Results value; defaults to a trusted mx.test pass. null omits the header. */
  auth?: string | null;
}

/** Test-only fixture mail. Lines are CRLF. */
export function fixtureMail(opts: FixtureMail): Buffer {
  const lines = [
    ...(opts.auth === null
      ? []
      : [`Authentication-Results: ${opts.auth ?? "mx.test; spf=pass smtp.mailfrom=sender; dkim=pass header.d=sender; dmarc=pass"}`]),
    `From: ${opts.from}`,
    `To: ${BOT}`,
    `Subject: ${opts.subject ?? "hello"}`,
    `Message-ID: <${opts.messageId}>`,
    "Date: Thu, 08 Oct 2026 10:00:00 +0000",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    ...(opts.extraHeaders ?? []),
    "",
    opts.body,
    "",
  ];
  return Buffer.from(lines.join("\r\n"), "utf8");
}

export type FixtureOverrides = Partial<EmailChannelOptions>;

/** Full fixture for the channel's own tests: fake servers, a harness-driven clock and sleep, and the wired channel. */
export async function makeEmailFixture() {
  const imap = new FakeImap({ user: BOT, password: IMAP_PW, starttls: true, requireTlsBeforeAuth: true });
  const smtp = new FakeSmtp({ user: BOT, password: SMTP_PW, starttls: true, requireTlsBeforeAuth: true });
  await imap.listen();
  await smtp.listen();
  const logs: unknown[] = [];
  const logger = { log: (level: string, event: string, attrs: Record<string, unknown>) => logs.push({ level, event, ...attrs }) };
  const timers = new Set<() => void>();
  const sleep = (_ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      const done = () => {
        timers.delete(done);
        signal.removeEventListener("abort", done);
        resolve();
      };
      timers.add(done);
      signal.addEventListener("abort", done, { once: true });
    });
  /** Released sleeps (IDLE timeouts, poll intervals, retries, backoff) continue. Only the harness releases them. */
  const release = () => {
    for (const t of [...timers]) t();
  };
  let clock = Date.parse("2026-10-08T10:00:00Z");
  const secrets = (missing: boolean): SecretReader => ({
    reveal: async (name) => (missing ? null : name === IMAP_SECRET ? IMAP_PW : name === SMTP_SECRET ? SMTP_PW : null),
  });
  const config: EmailConfig = {
    address: BOT,
    displayName: "Bot",
    imap: {
      host: "127.0.0.1",
      port: imap.port,
      security: "starttls",
      user: BOT,
      passwordSecret: IMAP_SECRET,
      folder: "INBOX",
      idle: true,
      pollIntervalSec: 60,
    },
    smtp: { host: "127.0.0.1", port: smtp.port, security: "starttls", user: BOT, passwordSecret: SMTP_SECRET },
    dmAllowlist: [ALLOWED],
    authServId: "mx.test",
    locale: "en",
  };
  const make = (
    missing: boolean,
    extra: FixtureOverrides & { noAuthServId?: boolean } = {},
    uidStore = new MemoryUidStore(),
  ): EmailChannel => {
    const { noAuthServId, ...rest } = extra;
    const { authServId: _unused, ...withoutAuthServId } = config;
    return new EmailChannel({
      ...(noAuthServId ? withoutAuthServId : config),
      secrets: secrets(missing),
      uidStore,
      logger,
      upgradeTls: async (s) => s,
      sleep,
      random: () => 0.5,
      now: () => clock,
      ...rest,
    });
  };
  const channel = make(false);
  let n = 0;
  const waitProcessed = async (uid: number): Promise<void> => {
    for (let i = 0; i < 5000; i++) {
      if (imap.messages.find((m) => m.uid === uid)?.seen) return;
      release();
      await new Promise((r) => setImmediate(r));
    }
    throw new Error("delivery was not processed");
  };
  /** Appends a raw message to the mailbox and resolves once the channel has processed (marked seen) it. */
  const deliverRaw = async (raw: Buffer): Promise<void> => {
    await waitProcessed(imap.append(raw));
  };
  const deliver = async (from: string, text: string): Promise<void> =>
    deliverRaw(fixtureMail({ from, body: text, messageId: `in-${++n}-${Date.now()}@example.test` }));
  const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../../channel.json", import.meta.url)), "utf8")) as unknown;
  return {
    manifest,
    channel,
    imap,
    smtp,
    config,
    logs,
    secretValues: [IMAP_PW, SMTP_PW],
    release,
    waitProcessed,
    deliverRaw,
    deliver,
    make,
    setClock: (ms: number) => {
      clock = ms;
    },
    now: () => clock,
    dispose: async () => {
      await channel.stop();
      await imap.close();
      await smtp.close();
    },
  };
}

export async function makeContractHarness(): Promise<ContractHarness> {
  const f = await makeEmailFixture();
  return {
    name: "email",
    manifest: f.manifest,
    channel: f.channel,
    secretValues: f.secretValues,
    logs: f.logs,
    deliverDirect: (text) => f.deliver(ALLOWED, text),
    deliverGroupMentioned: (text) => f.deliver(ALLOWED, text),
    deliverGroupUnmentioned: (text) => f.deliver(STRANGER, text),
    sentTexts: () => f.smtp.received.map((r) => parseMessage(r.data).text.trim()),
    withMissingSecret: async () => f.make(true),
    dispose: f.dispose,
  };
}
