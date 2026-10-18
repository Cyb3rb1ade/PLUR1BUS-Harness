import { createHash, randomUUID } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { SessionService } from '../session/service.ts';
import type { Principal } from '../rbac/types.ts';
import { authorize } from '../rbac/authorize.ts';
import { authenticatedPrincipal } from '../rbac/guard.ts';
import { deriveUserPrincipal } from '../identity/principals.ts';
import { mapSessionError } from '../session/methods.ts';
import type { Handler } from '../rpc/server.ts';
import { surfaceError } from '../rpc/surface-errors.ts';
import { CollabError } from './errors.ts';
import { BoardError } from './board.ts';
import { RpcError } from '../rpc/errors.ts';
import type { Collab } from './service.ts';
export interface PromotionTarget { kind: 'card' | 'project' | 'new_project'; projectId?: string; name?: string; title?: string; columnId?: string }
export interface PromotionSelection { kind: 'none' | 'summary' | 'selected' | 'transcript'; summary?: string; messageIds?: string[] }
interface PromotionOptions { sessions: () => SessionService; collab: Collab; now: () => number; audit: (event: Record<string, unknown>) => void }
interface Preview { id: string; person: string; sessionId: string; sourceHash: string; target: PromotionTarget; selection: PromotionSelection; content: string; expiresAt: number }
export interface PromotionResult { projectId: string; cardId: string | null; transferredMessages: number; selection: PromotionSelection['kind'] }
export class ChatPromotion {
  readonly #db: DatabaseSync; readonly #previews = new Map<string, Preview>();
  readonly #options: PromotionOptions;
  constructor(o: PromotionOptions & { path: string }) {
    this.#options = o; this.#db = new DatabaseSync(o.path); if (o.path !== ':memory:' && process.platform !== 'win32') chmodSync(o.path, 0o600);
    this.#db.exec('CREATE TABLE IF NOT EXISTS chat_promotions(id TEXT PRIMARY KEY, person TEXT NOT NULL, source_session TEXT NOT NULL, result TEXT NOT NULL);');
  }
  close() { this.#previews.clear(); this.#db.close(); }
  #source(person: Principal, sessionId: string) {
    if (person.kind !== 'person') throw new RpcError('E_DENIED', 'a person is required');
    const runtime = this.#options.sessions().forSession(sessionId), session = runtime.store.getOwned(sessionId, deriveUserPrincipal(person.userId));
    if (session.kind !== 'direct') throw new RpcError('E_NOT_FOUND', 'direct chat not found');
    const { tokenScopes: _scopes, ...role } = person;
    if (authorize(role, 'agent.use', { kind: 'agent', agentId: session.agentId }).effect !== 'allow') throw new RpcError('E_DENIED', 'agent right required');
    const raw = runtime.store.listMessages(sessionId, { limit: 10001 });
    const messages = raw.filter(m => m.role !== 'system');
    const sourceHash = createHash('sha256').update(JSON.stringify([session.id, session.owner, session.agentId, messages])).digest('hex');
    return { session, messages, sourceHash, tooMany: raw.length > 10000 };
  }
  #target(person: Principal, target: PromotionTarget): void {
    const { tokenScopes: _scopes, ...role } = person;
    if (target.kind === 'new_project') {
      if (!target.name?.trim() || target.name.length > 160 || target.projectId || target.columnId) throw new RpcError('E_INVALID_PARAMS', 'new project needs a name');
      if (authorize(role, 'project.write', { kind: 'project', projectId: 'new' }).effect !== 'allow') throw new RpcError('E_DENIED', 'project creation not permitted');
    } else {
      if (!target.projectId || target.name) throw new RpcError('E_INVALID_PARAMS', 'existing project required');
      const project = this.#options.collab.getProject(role, target.projectId);
      const membership = project.members.find(m => m.userId === person.userId);
      const actor = { ...role, projectRights: membership ? { [project.id]: membership.role } : {} };
      if (project.archivedAt !== null || (!membership && person.role !== 'owner' && person.role !== 'admin') || authorize(actor, 'project.write', { kind: 'project', projectId: project.id }).effect !== 'allow') throw new RpcError('E_DENIED', 'project write required');
      if (target.columnId && !this.#options.collab.boardStore.columns(project.id).some(c => c.id === target.columnId)) throw new RpcError('E_NOT_FOUND', 'column not found');
    }
    if (target.title !== undefined && (!target.title.trim() || target.title.length > 256)) throw new RpcError('E_INVALID_PARAMS', 'invalid destination title');
  }
  preview(person: Principal, input: { sessionId: string; target: PromotionTarget; selection?: PromotionSelection }) {
    const source = this.#source(person, input.sessionId); this.#target(person, input.target);
    const selection: PromotionSelection = structuredClone(input.selection ?? { kind: 'none' });
    const target = structuredClone(input.target);
    let content = '';
    if (selection.kind === 'summary') { if (!selection.summary?.trim() || selection.messageIds) throw new RpcError('E_INVALID_PARAMS', 'explicit summary required'); content = selection.summary; }
    else if (selection.kind === 'selected') {
      const ids = selection.messageIds;
      if (!ids?.length || new Set(ids).size !== ids.length || ids.some(id => !source.messages.some(m => m.id === id)) || selection.summary) throw new RpcError('E_INVALID_PARAMS', 'select existing messages from this chat');
      content = source.messages.filter(m => ids.includes(m.id)).map(m => `${m.role}: ${m.text}`).join('\n\n');
    } else if (selection.kind === 'transcript') { if (source.tooMany) throw new RpcError('E_INVALID_PARAMS', 'transcript is too large; choose a summary or selected messages'); if (selection.summary || selection.messageIds) throw new RpcError('E_INVALID_PARAMS', 'transcript has no extra selection'); content = source.messages.map(m => `${m.role}: ${m.text}`).join('\n\n'); }
    else if (selection.kind !== 'none' || selection.summary || selection.messageIds) throw new RpcError('E_INVALID_PARAMS', 'invalid content selection');
    if (Buffer.byteLength(content) > 65536) throw new RpcError('E_INVALID_PARAMS', 'selection is too large; choose a summary or fewer messages');
    for (const [id, p] of this.#previews) if (p.expiresAt <= this.#options.now()) this.#previews.delete(id);
    if (this.#previews.size >= 256) throw new RpcError('E_NOT_AVAILABLE', 'promotion preview capacity reached');
    const preview: Preview = { id: randomUUID(), person: person.userId, sessionId: input.sessionId, sourceHash: source.sourceHash, target, selection, content, expiresAt: this.#options.now() + 600000 };
    this.#previews.set(preview.id, preview);
    return { previewId: preview.id, content, target: structuredClone(target), selection: selection.kind, expiresAt: preview.expiresAt };
  }
  links(person: Principal, sessionId: string) {
    this.#source(person, sessionId);
    const { tokenScopes: _s, ...role } = person;
    const rows = this.#db.prepare('SELECT result FROM chat_promotions WHERE person=? AND source_session=? ORDER BY rowid').all(person.userId, sessionId) as { result: string }[];
    return { links: rows.flatMap(row => { const result = JSON.parse(row.result) as PromotionResult; try { const project = this.#options.collab.getProject(role, result.projectId); return [{ ...result, projectName: project.name }]; } catch { return []; } }) };
  }
  commit(person: Principal, previewId: string): PromotionResult {
    const done = this.#db.prepare('SELECT source_session,result FROM chat_promotions WHERE id=? AND person=?').get(previewId, person.userId) as { source_session: string; result: string } | undefined;
    if (done) { this.#source(person, done.source_session); const result = JSON.parse(done.result) as PromotionResult; this.#target(person, { kind: 'project', projectId: result.projectId }); return result; }
    const preview = this.#previews.get(previewId);
    if (!preview || preview.person !== person.userId) throw new RpcError('E_NOT_FOUND', 'promotion preview not found');
    if (preview.expiresAt <= this.#options.now()) { this.#previews.delete(previewId); throw new RpcError('E_CONFLICT', 'promotion preview expired'); }
    const source = this.#source(person, preview.sessionId); this.#target(person, preview.target);
    if (source.sourceHash !== preview.sourceHash) throw new RpcError('E_CONFLICT', 'chat changed; preview the selection again');
    // Audit contains metadata only. The original session is never updated/re-scoped and no source id/title enters the board.
    this.#options.audit({ action: 'chat.promoted', person: person.userId, selection: preview.selection.kind, bytes: Buffer.byteLength(preview.content) });
    this.#previews.delete(previewId);
    let projectId = preview.target.projectId;
    if (preview.target.kind === 'new_project') { const { tokenScopes: _s, ...role } = person; projectId = this.#options.collab.createProject(role, { name: preview.target.name!.trim() }).id; }
    if (!projectId) throw new RpcError('E_INVALID_PARAMS', 'destination project required');
    let cardId: string | null = null;
    if (preview.target.kind === 'card' || preview.content) {
      const columnId = preview.target.columnId ?? this.#options.collab.boardStore.columns(projectId)[0]!.id;
      cardId = this.#options.collab.boardStore.createCard(projectId, { columnId, title: preview.target.title?.trim() ?? 'Conversation notes', description: preview.content }, { kind: 'person', id: person.userId }).id;
    }
    const result: PromotionResult = { projectId, cardId, selection: preview.selection.kind, transferredMessages: preview.selection.kind === 'selected' ? preview.selection.messageIds!.length : preview.selection.kind === 'transcript' ? source.messages.length : 0 };
    this.#db.prepare('INSERT INTO chat_promotions VALUES (?,?,?,?)').run(previewId, person.userId, preview.sessionId, JSON.stringify(result));
    return result;
  }
}
export function promotionMethods(service: ChatPromotion): Record<string, Handler> {
  const bind = (fn: (p: any, a: Principal) => unknown): Handler => async (p, ctx) => { try { return fn(p, authenticatedPrincipal(ctx)); } catch (e) { if (e instanceof CollabError) return surfaceError(e); if (e instanceof BoardError) throw new RpcError(e.code === 'wip' ? 'E_PROJECT_WIP_LIMIT' : e.code === 'not-found' ? 'E_NOT_FOUND' : 'E_CONFLICT', 'destination board refused promotion'); return mapSessionError(e); } };
  return { 'chat.promote.links': bind((p, a) => service.links(a, p.sessionId)), 'chat.promote.preview': bind((p, a) => service.preview(a, p)), 'chat.promote.commit': bind((p, a) => service.commit(a, p.previewId)) };
}
