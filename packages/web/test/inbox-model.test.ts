// Inbox logic without a browser: where an entry leads, how params are shown, how the list changes after an action, and the
// unread count behind the sidebar badge (inbox.count, with a fake api).
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { setApiForTests } from "../src/api/shared.ts";
import type { Api } from "../src/api/client.ts";
import { inboxUnread, refreshInboxCount } from "../src/pages/inbox/count.ts";
import { appendPage, dismissLocal, displayParams, linkFor, markReadLocal, matches } from "../src/pages/inbox/model.ts";
import type { InboxEntry } from "../src/pages/inbox/rpc-types.ts";
import { sessionState, type SessionState } from "../src/session.ts";

function e(id: string, over: Partial<InboxEntry> = {}): InboxEntry {
  return { id, kind: "approval", severity: "warning", titleKey: "inbox.approval.requested", params: {}, ref: null, createdAt: 1, readAt: null, dismissedAt: null, ...over };
}

describe("linkFor: where an entry leads", () => {
  test("an approval links to its detail; other routes are linked bare", () => {
    assert.deepEqual(linkFor(e("a", { ref: { route: "/approvals", objectId: "apr_1" } })), { href: "#/approvals/apr_1" });
    assert.deepEqual(linkFor(e("b", { kind: "job-failed", ref: { route: "/recurring", objectId: "run_9" } })), { href: "#/recurring" });
  });

  test("the object id is encoded, so it cannot change the path", () => {
    assert.deepEqual(linkFor(e("c", { ref: { route: "/approvals", objectId: "a/../../x y" } })), { href: "#/approvals/a%2F..%2F..%2Fx%20y" });
  });

  test("no link for a missing ref, the inbox itself, or a route this UI does not know", () => {
    assert.equal(linkFor(e("d")), null);
    assert.equal(linkFor(e("f", { kind: "breakglass", ref: { route: "/inbox", objectId: "bg" } })), null);
    assert.equal(linkFor(e("g", { ref: { route: "https://example.test/x" } })), null);
    assert.equal(linkFor(e("h", { ref: { route: "/no-such-page" } })), null);
  });
});

describe("displayParams", () => {
  test("millisecond timestamps (expiresAt, *At) are formatted, other values become text", () => {
    const out = displayParams({ holderUserId: "usr_1", expiresAt: 1000, count: 3, flag: true }, (ms) => `@${ms}`);
    assert.deepEqual(out, { holderUserId: "usr_1", expiresAt: "@1000", count: "3", flag: "true" });
  });
});

describe("list changes after an action", () => {
  test("appendPage keeps the order and does not show an entry twice", () => {
    const merged = appendPage([e("a"), e("b")], [e("b"), e("c")]);
    assert.deepEqual(merged.map((x) => x.id), ["a", "b", "c"]);
  });

  test("markReadLocal marks the given ids, or every unread entry for 'all', and keeps read times as they were", () => {
    const list = [e("a"), e("b", { readAt: 5 })];
    assert.deepEqual(markReadLocal(list, ["a"], 9).map((x) => x.readAt), [9, 5]);
    assert.deepEqual(markReadLocal(list, "all", 9).map((x) => x.readAt), [9, 5]);
  });

  test("dismissLocal removes the entries", () => {
    assert.deepEqual(dismissLocal([e("a"), e("b")], ["a"]).map((x) => x.id), ["b"]);
  });

  test("matches: the kind filter and the unread filter", () => {
    const read = e("r", { kind: "pairing", readAt: 1 });
    assert.equal(matches(read, { kinds: [], unreadOnly: false }), true);
    assert.equal(matches(read, { kinds: ["approval"], unreadOnly: false }), false);
    assert.equal(matches(read, { kinds: [], unreadOnly: true }), false);
    assert.equal(matches(e("u", { kind: "pairing" }), { kinds: ["pairing"], unreadOnly: true }), true);
  });
});

describe("the sidebar count (inbox.count)", () => {
  afterEach(() => {
    setApiForTests(undefined);
    sessionState.value = { status: "checking" };
    inboxUnread.value = null;
  });

  const signedIn = (): void => {
    sessionState.value = { status: "authenticated", user: { id: "usr_1", role: "owner" } } as unknown as SessionState;
  };
  const fakeApi = (answer: () => unknown): Api => ({
    rpc: async (method: string) => {
      assert.equal(method, "inbox.count");
      return answer();
    },
  }) as unknown as Api;

  test("the badge is the sum of the unread counts over all kinds, not the total of visible entries", async () => {
    signedIn();
    setApiForTests(fakeApi(() => ({ unread: { breakglass: 1, approval: 2, "job-failed": 0, update: 0, "media-index": 0, pairing: 1, channel: 0, system: 0 }, total: 9 })));
    await refreshInboxCount();
    assert.equal(inboxUnread.value, 4);
  });

  test("a failed count shows no badge rather than a wrong one", async () => {
    signedIn();
    setApiForTests(fakeApi(() => { throw new Error("nope"); }));
    inboxUnread.value = 7;
    await refreshInboxCount();
    assert.equal(inboxUnread.value, null);
  });

  test("not signed in: no count is asked for and the badge is cleared", async () => {
    let asked = false;
    setApiForTests(fakeApi(() => { asked = true; return { unread: {}, total: 0 }; }));
    inboxUnread.value = 3;
    await refreshInboxCount();
    assert.equal(asked, false);
    assert.equal(inboxUnread.value, null);
  });
});
