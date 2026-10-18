import { isEventId, isRoomId } from './events.ts';

export interface SyncSafetyState { encryptedRooms: string[]; claimedEventIds: string[]; encryptionOverflow?: boolean }
export const emptySafety = (): SyncSafetyState => ({ encryptedRooms: [], claimedEventIds: [] });
export function validSafety(value: unknown): value is SyncSafetyState {
  const v = value as SyncSafetyState | null;
  return !!v && Array.isArray(v.encryptedRooms) && v.encryptedRooms.length <= 4096 && v.encryptedRooms.every(isRoomId)
    && Array.isArray(v.claimedEventIds) && v.claimedEventIds.length <= 65536 && v.claimedEventIds.every(isEventId) && (v.encryptionOverflow === undefined || typeof v.encryptionOverflow === "boolean");
}

export class SyncSafetyError extends Error {}
