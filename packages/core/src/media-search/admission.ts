import { mediaError } from './errors.ts';
import type { MediaIndexPort, MediaIndexRequest, MediaKind, Scope } from './types.ts';

export interface MediaEncodingUnits {
  agentId: string;
  model: string;
  images: number;
  videoSeconds: number;
}
/** Dependency-free seam for #603. Started encodes settle reserved units even on provider failure. */
export interface MediaEncodingBudget {
  reserve(units: MediaEncodingUnits): Promise<{ settle(): Promise<void>; release(): Promise<void> }>;
}
export interface MediaAdmission {
  policy(scope?: Scope, kind?: MediaKind): { local: boolean; model: string; pinned: boolean };
  budget?: MediaEncodingBudget;
}

/** Re-check policy at every operation. Cloud calls require reservation; Engine backfill lacks per-item admission. */
export function guardedMediaIndex(port: MediaIndexPort, o: MediaAdmission): MediaIndexPort {
  const policy = (scope?: Scope, kind?: MediaKind) => {
    const p = o.policy(scope, kind);
    if (!p.local && p.pinned) throw mediaError('E_MEDIA_PRIVACY', 'privacy.localOnly blocks cloud media');
    return p;
  };
  const backfillGate = () => {
    if (!policy().local) throw mediaError('E_MEDIA_UNAVAILABLE', 'Engine backfill has no per-item cloud unit admission');
  };
  return {
    async index(req: MediaIndexRequest) {
      const p = policy(req.scope, req.kind);
      if (p.local) return port.index(req);
      if (!o.budget) throw mediaError('E_MEDIA_UNAVAILABLE', 'media unit budget is not bound');
      const duration = req.encodingVideoSeconds;
      if (req.kind === 'audio' || (req.kind === 'video' && (!duration || duration < 0 || !Number.isFinite(duration)))) {
        throw mediaError('E_MEDIA_UNAVAILABLE', 'trusted media duration required for metering');
      }
      const held = await o.budget.reserve({ agentId: req.scope.agentId, model: p.model,
        images: req.kind === 'image' ? 1 : 0, videoSeconds: req.kind === 'video' ? Math.ceil(duration!) : 0 });
      let started = false;
      try {
        // The reservation may await persistent I/O; a privacy change during it must still win.
        policy(req.scope, req.kind);
        started = true;
        return await port.index(req);
      } finally {
        // A failed provider can have consumed its allocation. Do not release a started encode as free usage.
        if (started) await held.settle();
        else await held.release();
      }
    },
    async search(req) {
      const p = policy(req.scope);
      if (!p.local) throw mediaError('E_MEDIA_UNAVAILABLE', 'cloud query encoding requires a token budget/Secret lease');
      return port.search(req);
    },
    remove: id => port.remove(id),
    setCaption: (id, text, source) => port.setCaption(id, text, source),
    status: () => port.status(),
    backfill: {
      start: async options => { backfillGate(); return port.backfill.start(options); },
      resume: async () => { backfillGate(); return port.backfill.resume(); },
      pause: () => port.backfill.pause(),
      cancel: () => port.backfill.cancel(),
    },
  };
}
