import type { Duplex } from "node:stream";
import { duplexPair } from "./duplex-pair.ts";
import { ACCOUNT, BOT_UUID } from "./setup.ts";

export interface PeerRequest {
  id: number;
  method: string;
}

/**
 * A minimal signal-cli stand-in on one half of an in-memory duplex pair, for tests that need a daemon which stays
 * connected but stops answering (FakeDaemon always answers). Hand `client` to the channel through the `connect` seam.
 * While `answering` is false every request is recorded in `unanswered` and never replied to, so the caller's read stays
 * pending until the test closes the peer, fires a deadline, or stops the channel.
 */
export class ScriptedPeer {
  readonly client: Duplex;
  /** Every request received, in order. */
  readonly requests: PeerRequest[] = [];
  /** The requests that arrived while `answering` was false. */
  readonly unanswered: PeerRequest[] = [];
  answering = true;
  readonly #server: Duplex;
  #buf = "";
  #ts = 1_700_000_100_000;

  constructor() {
    const [client, server] = duplexPair();
    this.client = client;
    this.#server = server;
    server.on("data", (chunk: Buffer) => this.#onData(chunk.toString("utf8")));
  }

  /** The daemon vanishes: the channel's end sees EOF. */
  close(): void {
    this.#server.destroy();
  }

  #onData(text: string): void {
    this.#buf += text;
    let nl: number;
    while ((nl = this.#buf.indexOf("\n")) >= 0) {
      const line = this.#buf.slice(0, nl);
      this.#buf = this.#buf.slice(nl + 1);
      if (!line.trim()) continue;
      const req = JSON.parse(line) as { id: number; method: string };
      const entry = { id: req.id, method: req.method };
      this.requests.push(entry);
      if (!this.answering) {
        this.unanswered.push(entry);
        continue;
      }
      this.#server.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: this.#resultFor(req.method) }) + "\n");
    }
  }

  #resultFor(method: string): unknown {
    switch (method) {
      case "version":
        return { version: "0.13.0-fake" };
      case "listAccounts":
        return [{ number: ACCOUNT, uuid: BOT_UUID }];
      case "send":
        return { timestamp: this.#ts++ };
      default:
        return {};
    }
  }
}
