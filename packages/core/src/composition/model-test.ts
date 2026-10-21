// A bounded probe through the production router: budget/auth/egress apply, tools and memory are empty.
import { randomUUID } from 'node:crypto';
import type { ProfileTable } from '../../../providers/src/index.ts';
import type { ChatProvider } from '../session/provider.ts';
import { RpcError } from '../rpc/errors.ts';
import { localOnlyDenied } from '../privacy/local-only.ts';
/** privacy.localOnly for the probe (owner decision 2026-10-18): a probe sends a real request, so a cloud model is refused before any provider exists. */
export interface ProbeLocalPolicy { localOnly: (agentId: string) => boolean; isLocalProvider: (provider: string) => boolean }
export async function testModel(model: string, profiles: ProfileTable, create: (selected: ProfileTable) => ChatProvider, principal: string, agentId: string, signal: AbortSignal, local?: ProbeLocalPolicy): Promise<{ ok: true; durationMs: number }> {
  const candidate = Object.values(profiles).flat().find(c => `${c.provider}/${c.model}` === model);
  if (!candidate) throw new RpcError('E_NOT_AVAILABLE', 'Model has no configured chat adapter', { reason: 'model-not-configured' });
  // Refused, never replaced by another model; the provider is not even constructed.
  if (local?.localOnly(agentId) === true && !local.isLocalProvider(candidate.provider)) throw localOnlyDenied(`model ${model}`);
  const started = Date.now();
  const timeout = AbortSignal.timeout(10_000);
  const bounded = AbortSignal.any([signal, timeout]);
  const id = `model-test-${randomUUID()}`;
  try {
    const provider = create({ probe: [candidate] });
    // No session is created and neither the reply nor provider details are returned or logged.
    let responded = false;
    for await (const _chunk of provider.stream({ sessionId: id, turnId: id, agentId, principal,
      role: 'decision', incognito: true, summaries: [], memory: '', messages: [{ role: 'user', text: 'Reply with OK.' }], maxOutputTokens: 16, signal: bounded })) { responded = true; bounded.throwIfAborted(); }
    if (!responded) throw new Error("empty-model-response");
    return { ok: true, durationMs: Date.now() - started };
  } catch (e) {
    if (signal.aborted) throw e;
    if (timeout.aborted) throw new RpcError('E_NOT_AVAILABLE', 'Model test timed out after 10 seconds', { reason: 'model-test-timeout' });
    // Provider responses can contain credentials; only a fixed error crosses this boundary.
    throw new RpcError('E_NOT_AVAILABLE', 'Model test failed; check credentials, egress and budget', { reason: 'model-test-failed' });
  }
}
