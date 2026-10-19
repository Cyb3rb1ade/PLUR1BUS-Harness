import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson } from '../tools/dispatcher.ts';
import type { ApprovalPort, ApprovalAsk } from '../tools/approval.ts';
import type { SurfaceTrust } from '../policy/index.ts';
import { RpcError } from '../rpc/errors.ts';
import type { MiningScope, SkillCandidate, SkillProposalQueue } from './miner.ts';

export interface SkillProposal {
  id: string; scope: MiningScope; status: 'pending' | 'accepted' | 'rejected'; candidate: SkillCandidate;
}
/** Additive public engine contract, not the existing memory-card correction API.
 * Acceptance records review only. This port has no filesystem target, installer or enable operation.
 * Mutations must atomically compare expectedHash and pending status in the engine proposal writer.
 */
export interface SkillProposalBackend extends SkillProposalQueue {
  readonly state: 'ready' | 'engine-unavailable';
  list(scope: MiningScope): Promise<readonly SkillProposal[]>;
  get(scope: MiningScope, id: string): Promise<SkillProposal>;
  accept(scope: MiningScope, id: string, expectedHash: string): Promise<void>;
  reject(scope: MiningScope, id: string, expectedHash: string): Promise<void>;
}
const unavailable = (): never => { throw new RpcError('E_NOT_AVAILABLE', 'the public engine skill-proposal API is unavailable', { reason: 'engine-unavailable' }); };
/** Deliberately has no fallback store, engine-internal import, file writer or activation hook. */
export class UnavailableSkillProposals implements SkillProposalBackend {
  readonly supportsSkillArtifacts = true as const;
  readonly state = 'engine-unavailable' as const;
  async find(): Promise<never> { return unavailable(); }
  async propose(): Promise<never> { return unavailable(); }
  async list(): Promise<never> { return unavailable(); }
  async get(): Promise<never> { return unavailable(); }
  async accept(): Promise<never> { return unavailable(); }
  async reject(): Promise<never> { return unavailable(); }
}
export function skillProposalHash(proposal: SkillProposal): string {
  return createHash('sha256').update(canonicalJson(proposal)).digest('hex');
}
/** Constructed by a trusted host handler after resolving identity and scope, never from model arguments. */
export interface SkillReviewer { principal: string; role: string; surface: SurfaceTrust; signal: AbortSignal }
export class SkillReview {
  readonly #backend: SkillProposalBackend;
  readonly #approval: ApprovalPort & Required<Pick<ApprovalPort, 'begin'>>;
  constructor(backend: SkillProposalBackend, approval: ApprovalPort & Required<Pick<ApprovalPort, 'begin'>>) { this.#backend = backend; this.#approval = approval; }
  status() { return { state: this.#backend.state, activeByDefault: false as const, humanReviewRequired: true as const }; }
  #authorize(actor: SkillReviewer): void {
    actor.signal.throwIfAborted();
    if (!actor.principal || !['owner', 'admin'].includes(actor.role)) throw new RpcError('E_DENIED', 'skill review requires owner or admin');
    if (this.#backend.state !== 'ready') unavailable();
  }
  #validate(proposal: SkillProposal, scope: MiningScope, id: string): SkillProposal {
    if (proposal.id !== id || canonicalJson(proposal.scope) !== canonicalJson(scope) || proposal.status !== 'pending') throw new RpcError('E_DENIED', 'proposal is not pending in this scope');
    const c = proposal.candidate;
    if (c.schema !== 'plur1bus.skill-candidate/1' || c.kind !== 'skill' || c.author !== 'agent' || c.enabled !== false || !/^mined-workflow-[a-f0-9]{16}$/.test(c.name) || !/^[a-f0-9]{64}$/.test(c.workflowHash) || typeof c.skillMd !== 'string' || Buffer.byteLength(c.skillMd) > 65536) throw new RpcError('E_STORAGE', 'invalid or active skill proposal');
    // Snapshot before awaiting a human: an adapter must not mutate the displayed object in place.
    return structuredClone(proposal);
  }
  async preview(scope: MiningScope, id: string, actor: SkillReviewer): Promise<SkillProposal> {
    this.#authorize(actor); return this.#validate(await this.#backend.get(scope, id), scope, id);
  }
  /** Uses the existing approval.list/get/decide surface, with a single-use content-bound decision.
   * No SKILL.md is written here, including after acceptance; installation/enable remain separate.
   */
  async decide(scope: MiningScope, id: string, decision: 'accept' | 'reject', actor: SkillReviewer): Promise<void> {
    if (decision !== 'accept' && decision !== 'reject') throw new RpcError('E_INVALID_PARAMS', 'invalid skill review decision');
    const bound = Object.freeze({ ...scope });
    const proposal = await this.preview(bound, id, actor), expectedHash = skillProposalHash(proposal);
    const args = { decision, proposalId: id, scope: bound, contentHash: expectedHash, enabled: false, skillMd: proposal.candidate.skillMd };
    const actionHash = createHash('sha256').update(canonicalJson(args)).digest('hex');
    const ask: ApprovalAsk = {
      request: { capability: 'fs.write', tool: 'skills.proposals.review', effect: 'local-write', risk: 'high', reversible: true,
        flags: { outsideRoots: false, denyListHit: false }, actionHash, grantOptions: [{ scope: 'once', requiredSurface: 3 }], requiredSurface: 3, tainted: false, taintSuspended: false, originSurface: actor.surface },
      callId: randomUUID(), tool: 'skills.proposals.review', args, principal: actor.principal, agentId: bound.agentId,
      park: false, signal: actor.signal,
    };
    const answer = await this.#approval.request(ask);
    actor.signal.throwIfAborted();
    this.#authorize(actor);
    if (!answer.approved || answer.scope !== 'once') throw new RpcError('E_DENIED', 'skill review was not approved');
    const current = this.#validate(await this.#backend.get(bound, id), bound, id);
    if (skillProposalHash(current) !== expectedHash) throw new RpcError('E_DENIED', 'skill proposal changed during review');
    if (!this.#approval.begin(answer, ask)) throw new RpcError('E_DENIED', 'skill approval is missing, changed or already consumed');
    actor.signal.throwIfAborted();
    await this.#backend[decision](bound, id, expectedHash);
  }
}
