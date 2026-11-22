// Exercise the frozen ChatPromotion with a real session and project board.
import { pathToFileURL } from "node:url";
import { createCollab } from "../../packages/core/src/collab/service.ts";
import { ChatPromotion, type PromotionSelection, type PromotionTarget } from "../../packages/core/src/collab/chat-promotion.ts";
import { SessionStore } from "../../packages/core/src/session/store.ts";
import { deriveUserPrincipal } from "../../packages/core/src/identity/principals.ts";
import { exporterMain } from "./lib.mjs";

const owner = { kind: "person", role: "owner", userId: "owner" } as const;
const other = { ...owner, userId: "other" };
const choice = "Explicit note é";
const started = 1_000;
function record(name: string) {
  let now = started, sessionId = 0;
  const ids = new Map<string, number>();
  const collab = createCollab({ path: ":memory:", clock: () => now, newId(prefix) {
    const n = (ids.get(prefix) ?? 0) + 1; ids.set(prefix, n); return prefix + "_" + n;
  } });
  const sessionStore = new SessionStore({ path: ":memory:", clock: () => now, newId: prefix => prefix + "_" + ++sessionId });
  const audit: Record<string, unknown>[] = [];
  const promo = new ChatPromotion({ path: ":memory:", collab, sessions: () => ({ forSession: () => ({ store: sessionStore }) } as never),
    now: () => now, audit: event => audit.push(event) });
  try {
    const p = collab.createProject(owner, { name: "Existing project" });
    const session = sessionStore.createSession({ kind: "direct", agentId: "sender", owner: deriveUserPrincipal(owner.userId), title: "Private fixture title" });
    const add = (question: string, answer: string) => {
      const begun = sessionStore.beginTurn(session.id, question, 1);
      sessionStore.completeTurn(begun.turn.id, { text: answer, tokens: 1 });
    };
    add("chosen text", "other text");
    const messages = sessionStore.listMessages(session.id);
    const target: PromotionTarget = name === "new project" ? { kind: "new_project", name: "New fixture" }
      : { kind: name === "empty card" ? "card" : "project", projectId: p.id, ...(name === "empty card" ? { title: "Empty card" } : {}) };
    let selection: PromotionSelection = { kind: "none" };
    if (name === "selected" || name === "stale" || name === "foreign commit") selection = { kind: "selected", messageIds: [messages[0]!.id] };
    if (name === "summary" || name === "new project") selection = { kind: "summary", summary: choice };
    if (name === "transcript" || name === "rewind stale") selection = { kind: "transcript" };
    if (name === "foreign message") selection = { kind: "selected", messageIds: ["foreign-fixture"] };
    if (name === "duplicates") selection = { kind: "selected", messageIds: [messages[0]!.id, messages[0]!.id] };
    if (name === "too many bytes") selection = { kind: "summary", summary: "é".repeat(32769) };
    let preview: unknown = null;
    let result: unknown;
    try {
      const picked = promo.preview(name === "foreign source" ? other : owner, { sessionId: session.id, target, selection });
      preview = { selection: picked.selection, content: picked.content, expiresAt: picked.expiresAt };
      if (name === "expired") now += 600_000;
      if (name === "stale") add("later", "answer later");
      if (name === "rewind stale") sessionStore.rewindPath(session.id, { toSeq: 1, lesson: "Fixture lesson", trigger: "user", actor: owner.userId });
      const who = name === "foreign commit" ? other : owner;
      const done = promo.commit(who, picked.previewId);
      const repeated = promo.commit(who, picked.previewId);
      const card = done.cardId ? collab.boardStore.getCard(done.projectId, done.cardId) : null;
      const links = promo.links(who, session.id).links;
      result = { ok: done, repeated, card: card && { title: card.title, description: card.description }, links };
    } catch (e) {
      const problem = e as { error?: string; code?: string; message?: string };
      result = { err: { code: problem.error ?? problem.code, message: problem.message } };
    }
    return { name, preview, result, audit };
  } finally { promo.close(); collab.close(); sessionStore.close(); }
}

export function buildChatPromotionVectors() {
  return { promotion: ["none", "selected", "summary", "transcript", "empty card", "new project", "foreign source", "foreign commit",
    "foreign message", "duplicates", "too many bytes", "expired", "stale", "rewind stale"].map(record) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await exporterMain({ area: "coding", build: buildChatPromotionVectors });
}
