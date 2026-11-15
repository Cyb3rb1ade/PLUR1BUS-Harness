// P4-20 flip A: the redaction feed (`legacy.redaction.changes`), the journal between this core's registry and the front
// door's mirror of it. Values here are plain words built at run time, never credential-shaped.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSecretRedaction } from "../../src/secrets/redaction.ts";
import { MAX_UNSENT_CHANGES, createRedactionFeed } from "../../src/secrets/redaction-feed.ts";

const word = (n: number): string => `plain value number ${String(n).padStart(4, "0")}`;
const MB = 1024 * 1024;
const ask = (epoch: string, after: number, waitMs = 0, maxBytes = MB) => ({ epoch, after, waitMs, maxBytes });

describe("redaction feed (P4-20 flip A)", () => {
  it("the first call starts an epoch with the whole registry, pinned values first", async () => {
    const redaction = createSecretRedaction();
    redaction.register(word(1));
    redaction.register(word(2), "api");
    redaction.replaceGroup(Symbol("config"), [word(3)]);
    redaction.register("short");
    const feed = createRedactionFeed({ redaction });
    assert.deepEqual(await feed.changes(ask("", 0, 5000)), { epoch: "1", next: 3, more: false, secrets: [
      { secret: word(2), pinned: true }, { secret: word(3), pinned: true }, { secret: word(1), pinned: false }] });
    // Nothing new: an immediate answer without a wait, the same numbers.
    assert.deepEqual(await feed.changes(ask("1", 3)), { epoch: "1", next: 3, more: false, secrets: [] });
  });

  it("a waiting call is answered by the next change; a rotation retires the old value and pins the new one", async () => {
    const redaction = createSecretRedaction();
    redaction.register(word(1), "api");
    const feed = createRedactionFeed({ redaction });
    assert.equal((await feed.changes(ask("", 0))).next, 1);
    const waiting = feed.changes(ask("1", 1, 5000));
    let answered = false;
    void waiting.then(() => { answered = true; });
    await new Promise(r => setTimeout(r, 30));
    assert.equal(answered, false, "nothing changed yet");
    redaction.register(word(2), "api");
    const started = Date.now();
    const got = await waiting;
    assert.ok(Date.now() - started < 1000, "the change did not end the wait");
    // Both changes of the rotation were journalled before the call resumed.
    assert.deepEqual(got, { epoch: "1", next: 3, more: false, secrets: [{ secret: word(1), pinned: false }, { secret: word(2), pinned: true }] });
    // Unacknowledged changes are sent again; acknowledged ones are forgotten.
    assert.deepEqual((await feed.changes(ask("1", 1))).secrets.length, 2);
    assert.deepEqual((await feed.changes(ask("1", 2))).secrets, [{ secret: word(2), pinned: true }]);
    assert.deepEqual(await feed.changes(ask("1", 3)), { epoch: "1", next: 3, more: false, secrets: [] });
    // An acknowledgement that is behind what was already forgotten changes nothing.
    assert.deepEqual(await feed.changes(ask("1", 1)), { epoch: "1", next: 3, more: false, secrets: [] });
  });

  it("with nothing new a call waits its time and no longer, also on an empty registry; a stop ends the wait", async () => {
    const stop = new AbortController();
    const feed = createRedactionFeed({ redaction: createSecretRedaction(), signal: stop.signal });
    // The first answer is immediate even though there is nothing: the caller must learn the epoch.
    let started = Date.now();
    assert.deepEqual(await feed.changes(ask("", 0, 5000)), { epoch: "1", next: 0, more: false, secrets: [] });
    assert.ok(Date.now() - started < 1000);
    started = Date.now();
    assert.deepEqual(await feed.changes(ask("1", 0, 80)), { epoch: "1", next: 0, more: false, secrets: [] });
    const took = Date.now() - started;
    assert.ok(took >= 70 && took < 3000, `waited ${took} ms`);
    started = Date.now();
    const waiting = feed.changes(ask("1", 0, 20000));
    setTimeout(() => stop.abort(), 20);
    assert.deepEqual(await waiting, { epoch: "1", next: 0, more: false, secrets: [] });
    assert.ok(Date.now() - started < 3000, "the stop did not end the wait");
    // After the stop nothing waits any more.
    started = Date.now();
    await feed.changes(ask("1", 0, 20000));
    assert.ok(Date.now() - started < 1000);
  });

  it("an epoch the feed does not know, and an acknowledgement beyond what was sent, start a new epoch from the whole registry", async () => {
    const redaction = createSecretRedaction();
    redaction.register(word(1), "api");
    const feed = createRedactionFeed({ redaction });
    assert.equal((await feed.changes(ask("", 0))).epoch, "1");
    redaction.register(word(2));
    const whole = [{ secret: word(1), pinned: true }, { secret: word(2), pinned: false }];
    assert.deepEqual(await feed.changes(ask("7", 5, 5000)), { epoch: "2", next: 2, more: false, secrets: whole });
    assert.deepEqual(await feed.changes(ask("2", 9, 5000)), { epoch: "3", next: 2, more: false, secrets: whole });
    assert.deepEqual(await feed.changes(ask("", 0, 5000)), { epoch: "4", next: 2, more: false, secrets: whole });
    // The old subscriptions are gone: one change is journalled once.
    redaction.register(word(3));
    assert.deepEqual((await feed.changes(ask("4", 2))).secrets, [{ secret: word(3), pinned: false }]);
  });

  it("an answer stays under maxBytes of values, carries at least one change, and says when more are waiting", async () => {
    const redaction = createSecretRedaction();
    const big = "a long value in plain words ".repeat(100); // 2800 bytes, more than the smallest maxBytes
    const values = [big, word(1), word(2), word(3)];
    redaction.replaceGroup(Symbol("many"), values);
    const feed = createRedactionFeed({ redaction });
    const first = await feed.changes(ask("", 0, 0, 1024));
    assert.deepEqual([first.secrets.map(c => c.secret), first.next, first.more], [[big], 1, true]);
    const got = [...first.secrets];
    let after = first.next;
    for (;;) {
      const page = await feed.changes(ask("1", after, 5000, 1024));
      got.push(...page.secrets);
      after = page.next;
      if (!page.more) break;
    }
    assert.deepEqual(got.map(c => c.secret), values);
    assert.equal(after, 4);
    // A character outside ASCII counts by its bytes in the answer, an escaped one by its escape.
    const odd = createSecretRedaction();
    odd.replaceGroup(Symbol("odd"), [String.fromCodePoint(0x1f600).repeat(200), String.fromCodePoint(1).repeat(160), word(1)]);
    const pages = createRedactionFeed({ redaction: odd });
    assert.deepEqual((await pages.changes(ask("", 0, 0, 1024))).secrets.length, 1, "800 bytes of emoji leave no room for 960 bytes of escapes");
  });

  it("a journal nobody empties is dropped, and the next call starts a new epoch", async () => {
    assert.ok(MAX_UNSENT_CHANGES >= 1024);
    const redaction = createSecretRedaction();
    for (let n = 1; n <= 5; n++) redaction.register(word(n), `name-${n}`);
    const feed = createRedactionFeed({ redaction, maxUnsent: 3 });
    // The replay of an epoch is not bounded: five values, though only three more may wait beside it.
    assert.equal((await feed.changes(ask("", 0))).secrets.length, 5);
    for (let n = 6; n <= 8; n++) redaction.register(word(n), `name-${n}`);
    assert.equal((await feed.changes(ask("1", 0))).secrets.length, 8, "full, and still whole");
    redaction.register(word(9), "name-9");
    // The ninth did not fit and nobody had acknowledged anything: the journal is gone, and so is the epoch.
    const again = await feed.changes(ask("1", 8, 5000));
    assert.equal(again.epoch, "2");
    assert.deepEqual(again.secrets.map(c => c.secret), [1, 2, 3, 4, 5, 6, 7, 8, 9].map(word));
    assert.ok(again.secrets.every(c => c.pinned) && again.next === 9 && !again.more);
    // The same while a call waits: it wakes with the new epoch.
    const waiting = feed.changes(ask("2", 9, 5000));
    await new Promise(r => setTimeout(r, 10));
    for (let n = 10; n <= 22; n++) redaction.register(word(n), `name-${n}`);
    const woken = await waiting;
    assert.deepEqual([woken.epoch, woken.secrets.length, woken.next], ["3", 22, 22]);
  });

  it("two calls with the same acknowledgement both get the change, and a closed feed answers nobody", async () => {
    const redaction = createSecretRedaction();
    const feed = createRedactionFeed({ redaction });
    await feed.changes(ask("", 0));
    const both = [feed.changes(ask("1", 0, 5000)), feed.changes(ask("1", 0, 5000))];
    redaction.register(word(1));
    for (const got of await Promise.all(both)) assert.deepEqual(got, { epoch: "1", next: 1, more: false, secrets: [{ secret: word(1), pinned: false }] });
    const waiting = feed.changes(ask("1", 1, 5000));
    feed.close();
    await assert.rejects(waiting, /closed/);
    await assert.rejects(feed.changes(ask("1", 1)), /closed/);
    // The subscription ended with it.
    redaction.register(word(2));
  });
});
