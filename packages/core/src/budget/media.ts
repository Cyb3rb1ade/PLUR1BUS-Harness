// Media units on the call budget (owner decision 2026-10-19): the media package measures a generation in images or video
// seconds (`requestedUnits`/`deliveredUnits`); this maps them onto the call port's `images`/`videoSeconds`. Type-only import.
import type { MediaUnits } from '../../../media/src/units.ts';

/** Whole budget units: `n` images, or video seconds rounded up (a 4.2 s clip counts 5). `null` (nothing delivered) is none. */
export function mediaCallUnits(u: MediaUnits | null): { images?: number; videoSeconds?: number } {
  if (!u) return {};
  if (!Number.isFinite(u.quantity) || u.quantity < 0) throw new RangeError('invalid media units');
  return u.unit === 'image' ? { images: Math.ceil(u.quantity) } : { videoSeconds: Math.ceil(u.quantity) };
}
