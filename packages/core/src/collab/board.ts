import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import type { Project } from "./types.ts";

export interface BoardActor { kind: "person" | "agent"; id: string }
export interface BoardColumn { id: string; title: string | null; titleKey: string | null; position: number; wipLimit: number | null }
export interface BoardLink { kind: "session" | "job" | "media" | "url"; id: string }
export interface BoardCard {
  id: string; projectId: string; title: string; description: string; columnId: string; position: number;
  labels: string[]; priority: "none" | "low" | "normal" | "high" | "urgent"; dueAt: number | null;
  assignees: BoardActor[]; links: BoardLink[]; createdBy: BoardActor; updatedBy: BoardActor;
  createdAt: number; updatedAt: number; archived: boolean;
}
export interface BoardActivity { id: string; cardId: string; kind: "created" | "updated" | "moved" | "assigned" | "unassigned" | "commented" | "archived" | "unarchived"; actor: BoardActor; at: number; detail: string }
export interface BoardComment { id: string; cardId: string; author: BoardActor; text: string; createdAt: number }
export interface CardInput { title: string; columnId: string; position?: number; description?: string; labels?: string[]; priority?: BoardCard["priority"]; dueAt?: number | null; links?: BoardLink[] }
export interface CardFilter { columnId?: string; assignee?: BoardActor; label?: string; text?: string; archived?: boolean; cursor?: string; limit?: number }
export interface PageInput { cursor?: string; limit?: number }
interface Data { columns: BoardColumn[]; cards: BoardCard[]; activity: BoardActivity[]; comments: BoardComment[] }
export class BoardError extends Error {
  readonly code: "invalid" | "not-found" | "conflict" | "wip" | "archived" | "denied";
  constructor(code: BoardError["code"], message: string) { super(message); this.code = code; }
}
const bad = (message: string): never => { throw new BoardError("invalid", message); };
const same = (a: BoardActor, b: BoardActor): boolean => a.kind === b.kind && a.id === b.id;
const title = (s: string): string => typeof s === "string" && s.trim().length > 0 && s.length <= 256 ? s.trim() : bad("invalid title");
const index = (n: number | undefined, size: number): number => n === undefined ? size : Number.isSafeInteger(n) && n >= 0 ? Math.min(n, size) : bad("invalid position");
const limit = (n = 50): number => Number.isSafeInteger(n) && n > 0 && n <= 100 ? n : bad("invalid limit");
const fingerprint = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function page<T extends { id: string }>(items: T[], input: PageInput, binding: unknown, ordered = false): { items: T[]; nextCursor: string | null } {
  const take = limit(input.limit), hash = fingerprint(binding);
  let after = "";
  if (input.cursor) {
    try {
      const c = JSON.parse(Buffer.from(input.cursor, "base64url").toString()) as { hash: string; after: string };
      if (c.hash !== hash || typeof c.after !== "string" || input.cursor.length > 2048) bad("invalid cursor");
      after = c.after;
      if (ordered && !items.some(i => i.id === after)) bad("invalid cursor");
    } catch { bad("invalid cursor"); }
  }
  const remaining = ordered ? items.slice(after ? items.findIndex(i => i.id === after) + 1 : 0) : items.filter(i => i.id > after).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const selected = remaining.slice(0, take);
  return { items: selected, nextCursor: remaining.length > take ? Buffer.from(JSON.stringify({ hash, after: selected.at(-1)!.id })).toString("base64url") : null };
}

/** Shares the project's SQLite connection. Every mutation, including its history, is one BEGIN IMMEDIATE transaction. */
export class ProjectBoardStore {
  private readonly db: DatabaseSync;
  private readonly project: (id: string) => Project | null;
  private readonly clock: () => number;
  private readonly id: (prefix: string) => string;
  constructor(db: DatabaseSync, project: (id: string) => Project | null, clock: () => number, id: (prefix: string) => string) { this.db = db; this.project = project; this.clock = clock; this.id = id; }
  #read(projectId: string): Data {
    if (!this.project(projectId)) throw new BoardError("not-found", "project not found");
    const r = this.db.prepare("SELECT data FROM project_boards WHERE project_id = ?").get(projectId) as { data: string } | undefined;
    if (!r) throw new BoardError("not-found", "board not found");
    return JSON.parse(r.data) as Data;
  }
  #write<T>(projectId: string, fn: (d: Data) => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const d = this.#read(projectId);
      if (this.project(projectId)!.archivedAt !== null) throw new BoardError("archived", "project archived");
      const result = fn(d);
      this.db.prepare("UPDATE project_boards SET data = ? WHERE project_id = ?").run(JSON.stringify(d), projectId);
      this.db.exec("COMMIT"); return result;
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  #column(d: Data, id: string): BoardColumn { const c = d.columns.find(c => c.id === id); if (!c) throw new BoardError("not-found", "column not found"); return c; }
  #card(d: Data, id: string): BoardCard { const c = d.cards.find(c => c.id === id); if (!c) throw new BoardError("not-found", "card not found"); return c; }
  #wip(d: Data, columnId: string, incoming: number, override = false): void {
    const c = this.#column(d, columnId);
    if (incoming > 0 && !override && c.wipLimit !== null && d.cards.filter(c => c.columnId === columnId && !c.archived).length + incoming > c.wipLimit) throw new BoardError("wip", "project WIP limit exceeded");
  }
  #history(d: Data, c: BoardCard, kind: BoardActivity["kind"], actor: BoardActor, detail = ""): void {
    c.updatedAt = this.clock(); c.updatedBy = { ...actor };
    // Monotonic sequence ids are independent of clocks and UUID lexical order; keyset paging is stable.
    d.activity.push({ id: String(d.activity.length + 1).padStart(16, "0"), cardId: c.id, kind, actor: { ...actor }, at: c.updatedAt, detail });
  }
  #place(d: Data, c: BoardCard, columnId: string, position?: number): void {
    this.#column(d, columnId);
    const old = c.columnId;
    const target = d.cards.filter(x => x.id !== c.id && x.columnId === columnId).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
    target.splice(index(position, target.length), 0, c); c.columnId = columnId;
    target.forEach((x, i) => { x.position = i; });
    if (old !== columnId) d.cards.filter(x => x.columnId === old).sort((a, b) => a.position - b.position).forEach((x, i) => { x.position = i; });
  }
  columns(projectId: string): BoardColumn[] { return this.#read(projectId).columns.sort((a, b) => a.position - b.position); }
  createColumn(projectId: string, input: { title?: string; titleKey?: string; wipLimit?: number | null; position?: number }): BoardColumn {
    return this.#write(projectId, d => {
      if (!input.title && !input.titleKey) bad("title or titleKey required");
      const c: BoardColumn = { id: this.id("col"), title: input.title ? title(input.title) : null, titleKey: input.titleKey ? title(input.titleKey) : null, position: 0, wipLimit: input.wipLimit ?? null };
      this.#validWip(c.wipLimit);
      d.columns.splice(index(input.position, d.columns.length), 0, c); d.columns.forEach((x, i) => { x.position = i; }); return c;
    });
  }
  #validWip(n: number | null): void { if (n !== null && (!Number.isSafeInteger(n) || n < 1)) bad("invalid WIP limit"); }
  updateColumn(projectId: string, id: string, patch: { title?: string; titleKey?: string; wipLimit?: number | null }): BoardColumn {
    return this.#write(projectId, d => {
      const c = this.#column(d, id);
      if (patch.title !== undefined) { c.title = title(patch.title); c.titleKey = null; }
      if (patch.titleKey !== undefined) { c.titleKey = title(patch.titleKey); c.title = null; }
      if (patch.wipLimit !== undefined) { this.#validWip(patch.wipLimit); c.wipLimit = patch.wipLimit; }
      return c;
    });
  }
  moveColumn(projectId: string, id: string, position: number): BoardColumn {
    return this.#write(projectId, d => { const c = this.#column(d, id); d.columns = d.columns.filter(x => x.id !== id); d.columns.splice(index(position, d.columns.length), 0, c); d.columns.forEach((x, i) => { x.position = i; }); return c; });
  }
  deleteColumn(projectId: string, id: string, target: string | undefined, actor: BoardActor, override = false): { deleted: boolean } {
    return this.#write(projectId, d => {
      this.#column(d, id);
      if (target === id) bad("target must differ from deleted column");
      const cards = d.cards.filter(c => c.columnId === id).sort((a, b) => a.position - b.position);
      if (target) { this.#wip(d, target, cards.filter(c => !c.archived).length, override); }
      else if (cards.length) throw new BoardError("conflict", "column must be empty or have target column");
      for (const c of cards) { this.#place(d, c, target!); this.#history(d, c, "moved", actor, JSON.stringify({ from: id, to: target, override })); }
      d.columns = d.columns.filter(c => c.id !== id); d.columns.forEach((c, i) => { c.position = i; }); return { deleted: true };
    });
  }
  getCard(projectId: string, id: string): BoardCard { return this.#card(this.#read(projectId), id); }
  cards(projectId: string, filter: CardFilter): { cards: BoardCard[]; nextCursor: string | null } {
    const d = this.#read(projectId);
    if (filter.columnId) this.#column(d, filter.columnId);
    const items = d.cards.filter(c => c.archived === (filter.archived ?? false) && (!filter.columnId || c.columnId === filter.columnId) && (!filter.assignee || c.assignees.some(a => same(a, filter.assignee!))) && (!filter.label || c.labels.includes(filter.label)) && (!filter.text || `${c.title}\n${c.description}`.toLocaleLowerCase("en").includes(filter.text.toLocaleLowerCase("en"))));
    items.sort((a, b) => this.#column(d, a.columnId).position - this.#column(d, b.columnId).position || a.position - b.position || a.id.localeCompare(b.id));
    const p = page(items, filter, [projectId, filter.columnId, filter.assignee, filter.label, filter.text, filter.archived ?? false, items.map(c => [c.id, c.updatedAt, c.columnId, c.position])], true);
    return { cards: p.items, nextCursor: p.nextCursor };
  }
  #fields(c: BoardCard, patch: Partial<Omit<CardInput, "columnId" | "position">>): void {
    if (patch.title !== undefined) c.title = title(patch.title);
    if (patch.description !== undefined) { if (typeof patch.description !== "string" || patch.description.length > 65536) bad("invalid description"); c.description = patch.description; }
    if (patch.labels !== undefined) { if (patch.labels.length > 32 || patch.labels.some(s => !s || s.length > 64)) bad("invalid labels"); c.labels = [...new Set(patch.labels)]; }
    if (patch.priority !== undefined) { if (!["none", "low", "normal", "high", "urgent"].includes(patch.priority)) bad("invalid priority"); c.priority = patch.priority; }
    if (patch.dueAt !== undefined) { if (patch.dueAt !== null && (!Number.isSafeInteger(patch.dueAt) || patch.dueAt < 0)) bad("invalid dueAt"); c.dueAt = patch.dueAt; }
    if (patch.links !== undefined) { if (patch.links.length > 64 || patch.links.some(l => !["session", "job", "media", "url"].includes(l.kind) || typeof l.id !== "string" || !l.id || l.id.length > 4096)) bad("invalid links"); c.links = patch.links.map(l => ({ ...l })); }
  }
  createCard(projectId: string, input: CardInput, actor: BoardActor, override = false): BoardCard {
    return this.#write(projectId, d => {
      this.#wip(d, input.columnId, 1, override);
      const now = this.clock();
      const c: BoardCard = { id: this.id("card"), projectId, title: title(input.title), description: "", columnId: input.columnId, position: 0, labels: [], priority: "normal", dueAt: null, assignees: [], links: [], createdBy: { ...actor }, updatedBy: { ...actor }, createdAt: now, updatedAt: now, archived: false };
      this.#fields(c, input); d.cards.push(c); this.#place(d, c, input.columnId, input.position); this.#history(d, c, "created", actor, JSON.stringify({ override })); return c;
    });
  }
  updateCard(projectId: string, id: string, patch: Partial<Omit<CardInput, "columnId" | "position">>, actor: BoardActor): BoardCard {
    return this.#write(projectId, d => { const c = this.#card(d, id); this.#fields(c, patch); this.#history(d, c, "updated", actor); return c; });
  }
  moveCard(projectId: string, id: string, columnId: string, position: number | undefined, actor: BoardActor, override = false): BoardCard {
    return this.#write(projectId, d => { const c = this.#card(d, id); if (c.archived) throw new BoardError("archived", "card archived"); const from = c.columnId; if (from !== columnId) this.#wip(d, columnId, 1, override); this.#place(d, c, columnId, position); this.#history(d, c, "moved", actor, JSON.stringify({ from, to: columnId, position: c.position, override })); return c; });
  }
  assign(projectId: string, id: string, assignee: BoardActor, add: boolean, actor: BoardActor): BoardCard {
    return this.#write(projectId, d => {
      const p = this.project(projectId)!;
      if (add && !(assignee.kind === "person" ? p.members.some(m => m.userId === assignee.id) : p.agents.includes(assignee.id))) bad("assignee must belong to project");
      const c = this.#card(d, id), present = c.assignees.some(a => same(a, assignee));
      if (add === present) return c;
      c.assignees = add ? [...c.assignees, { ...assignee }] : c.assignees.filter(a => !same(a, assignee));
      this.#history(d, c, add ? "assigned" : "unassigned", actor, JSON.stringify(assignee)); return c;
    });
  }
  archiveCard(projectId: string, id: string, archived: boolean, actor: BoardActor, override = false): BoardCard {
    return this.#write(projectId, d => { const c = this.#card(d, id); if (c.archived === archived) return c; if (!archived) this.#wip(d, c.columnId, 1, override); c.archived = archived; this.#history(d, c, archived ? "archived" : "unarchived", actor, JSON.stringify({ override })); return c; });
  }
  comment(projectId: string, id: string, text: string, actor: BoardActor): BoardComment {
    return this.#write(projectId, d => { const c = this.#card(d, id); if (typeof text !== "string" || !text.trim() || text.length > 65536) bad("invalid comment"); const comment: BoardComment = { id: String(d.comments.length + 1).padStart(16, "0"), cardId: id, text, author: { ...actor }, createdAt: this.clock() }; d.comments.push(comment); this.#history(d, c, "commented", actor, comment.id); return comment; });
  }
  comments(projectId: string, id: string, input: PageInput): { items: BoardComment[]; nextCursor: string | null } { const d = this.#read(projectId); this.#card(d, id); return page(d.comments.filter(c => c.cardId === id), input, [projectId, id, "comments"]); }
  activity(projectId: string, id: string, input: PageInput): { items: BoardActivity[]; nextCursor: string | null } { const d = this.#read(projectId); this.#card(d, id); return page(d.activity.filter(c => c.cardId === id), input, [projectId, id, "activity"]); }
}
