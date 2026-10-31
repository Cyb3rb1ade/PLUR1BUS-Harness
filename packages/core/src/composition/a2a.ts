import { defaults } from "@plur1bus/config-schema";
import { join } from "node:path";
import { A2aPeerClient } from "../a2a/peer-client.ts";
import { A2aPeerStore } from "../a2a/peer-store.ts";
import { A2aPeerTransport } from "../tools/a2a-transport.ts";
import { PeerCallBudget } from "../budget/peer.ts";
import type { CallBudget } from "../budget/calls.ts";
import { createPolicyAudit } from "../policy/audit.ts";
import { localOnlyFor } from "../privacy/local-only.ts";
import { a2aPeerMethods } from "../rpc/a2a-peers.ts";
import type { CompositionDeps } from "./index.ts";

export function composeA2a(d: Pick<CompositionDeps, 'home' | 'config' | 'egress' | 'permissions' | 'audit' | 'clock' | 'secrets' | 'signal' | 'surfaceOf'>, budget: CallBudget, registerSecret: (value: string) => void) {
  const fallback = defaults().a2aClient!;
  const settings = () => d.config().a2aClient ?? fallback;
  const store = new A2aPeerStore({ path: join(d.home, "state", "a2a-peers.sqlite"), now: d.clock, maxPeers: 1024 });
  let peerBudget: PeerCallBudget | undefined;
  try {
    peerBudget = new PeerCallBudget({ path: join(d.home, "state", "budget.sqlite"), now: d.clock });
    const audit = createPolicyAudit({ sink: d.audit, clock: { now: d.clock }, ...(d.secrets.redaction ? { redactor: d.secrets.redaction.redactor() } : {}) });
    const transport = new A2aPeerTransport({ settings, peerBudget, budget, egress: d.egress, localOnly: id => localOnlyFor(d.config(), id), audit: d.audit, now: d.clock,
      beforeDispatch: () => d.permissions.open(),
      dispatch: {
        audit, grants: { list: q => d.permissions.current()?.grants.list(q) ?? [], get: id => d.permissions.current()?.grants.get(id), maxGrantDays: () => d.config().approvals?.maxGrantDays ?? 90 },
        grantUse: { markUsed: id => d.permissions.current()!.grants.markUsed(id), consumeOnce: (id, binding) => d.permissions.current()!.grants.consumeOnce(id, binding) },
        approvals: { request: async ask => (await d.permissions.open()).service.request(ask), begin: (answer, ask) => d.permissions.current()?.service.begin(answer, ask) ?? false },
        policyContext: ctx => { const p = d.permissions.current(); if (!p) throw new Error("approval service unavailable"); return p.service.policyContext()(ctx); },
      },
      credential: async (name, peerId) => {
        const lease = await d.secrets.lease({ kind: "core" }, name, { purpose: "a2a-peer", profileId: peerId, ttlMs: settings().timeoutMs + 1000 });
        registerSecret(lease.value);
        return { value: lease.value, release: () => { d.secrets.revokeLease({ kind: "core" }, lease.leaseId); } };
      },
    });
    const redactor = d.secrets.redaction?.redactor();
    const client = new A2aPeerClient({ store, transport, enabled: () => settings().enabled, maxPeers: () => settings().maxPeers, signal: d.signal, ...(redactor ? { redactText: (text: string) => redactor.text(text) } : {}) });
    return { client, methods: a2aPeerMethods(() => client, d.surfaceOf), close() { client.close(); peerBudget!.close(); store.close(); } };
  } catch (e) { peerBudget?.close(); store.close(); throw e; }
}
