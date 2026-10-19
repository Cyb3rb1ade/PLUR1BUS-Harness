import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { RpcError } from '../rpc/errors.ts';
export type ArtifactAudit = (event: { action: string; target: string; enabled?: boolean }) => void;
export type ArtifactAuthor = 'human' | 'agent';
export interface ArtifactChange { path: string; text: string; oldHash: string | null; author: ArtifactAuthor }
export interface ArtifactProposalPort { propose(change: ArtifactChange): Promise<{ proposalId: string }> }
const digest = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
/** A provenance record is evidence for exactly these bytes. A later manual edit makes an agent record human again. */
export class ArtifactProvenance {
  readonly #db: DatabaseSync;
  constructor(path: string) { this.#db = new DatabaseSync(path); this.#db.exec('CREATE TABLE IF NOT EXISTS artifact_provenance(path TEXT PRIMARY KEY, author TEXT NOT NULL CHECK(author IN (\'human\',\'agent\')), hash TEXT NOT NULL); CREATE TABLE IF NOT EXISTS artifact_policy(key TEXT PRIMARY KEY, value INTEGER NOT NULL)'); }
  inspect(path: string): { path: string; author: ArtifactAuthor; hash: string } {
    const canonical = realpathSync(path); const hash = digest(readFileSync(canonical));
    const row = this.#db.prepare('SELECT author,hash FROM artifact_provenance WHERE path=?').get(canonical);
    const author = row?.['author'] === 'agent' && row['hash'] === hash ? 'agent' : 'human';
    if (!row || row['hash'] !== hash) this.#db.prepare('INSERT OR REPLACE INTO artifact_provenance(path,author,hash) VALUES(?,?,?)').run(canonical, author, hash);
    return { path: canonical, hash, author };
  }
  /** Owner attribution only; neither a model argument nor imported metadata can call this through RPC. */
  attribute(path: string, author: ArtifactAuthor, role: string): void {
    if (role !== 'owner') throw new RpcError('E_DENIED', 'artifact attribution requires owner');
    const current = this.inspect(path);
    this.#db.prepare('INSERT OR REPLACE INTO artifact_provenance(path,author,hash) VALUES(?,?,?)').run(current.path, author, current.hash);
  }
  approvalRequired(): boolean { return this.#db.prepare("SELECT value FROM artifact_policy WHERE key='self-knowledge'").get()?.['value'] !== 0; }
  storeApprovalPolicy(enabled: boolean): void { this.#db.prepare("INSERT OR REPLACE INTO artifact_policy(key,value) VALUES('self-knowledge',?)").run(enabled ? 1 : 0); }
  close(): void { this.#db.close(); }
}
/** Read-only write gate for self-improvement paths. A proposal result contains no permission to write the file. */
export class SelfKnowledgePolicy {
  readonly #provenance: ArtifactProvenance; readonly #queue: ArtifactProposalPort;
  readonly #audit: (event: { action: string; target: string; enabled?: boolean }) => void;
  constructor(provenance: ArtifactProvenance, queue: ArtifactProposalPort, audit: ArtifactAudit) { this.#provenance = provenance; this.#queue = queue; this.#audit = audit; }
  get writeApproval(): boolean { return this.#provenance.approvalRequired(); }
  /** Owner-only, audit-before-change. Disabling this never permits overwriting a human artifact. */
  setWriteApproval(enabled: boolean, role: string): void {
    if (role !== 'owner') throw new RpcError('E_DENIED', 'self-knowledge approval policy requires owner');
    if (typeof enabled !== 'boolean') throw new RpcError('E_INVALID_PARAMS', 'write approval must be boolean');
    this.#audit({ action: 'self-knowledge.write-approval', target: 'self-knowledge', enabled }); this.#provenance.storeApprovalPolicy(enabled);
  }
  async request(path: string, text: string): Promise<{ kind: 'proposal'; proposalId: string } | { kind: 'agent-owned-write'; oldHash: string }> {
    const current = this.#provenance.inspect(path);
    if (current.author === 'human' || this.writeApproval) {
      this.#audit({ action: 'self-knowledge.propose', target: digest(current.path) });
      const proposal = await this.#queue.propose({ path: current.path, text, oldHash: current.hash, author: current.author });
      return { kind: 'proposal', ...proposal };
    }
    this.#audit({ action: 'self-knowledge.agent-write', target: digest(current.path) });
    return { kind: 'agent-owned-write', oldHash: current.hash };
  }
}
