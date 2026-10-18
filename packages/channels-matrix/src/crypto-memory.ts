import type * as CryptoTypes from '@matrix-org/matrix-sdk-crypto-wasm';
import { isObj, isRoomId, isUserId, type MatrixEvent, type SyncResponse } from './events.ts';

/** The WASM module is loaded on first use, never at import time: the core bundle imports this file for every
 *  deployment, and only an operator who opts in to Matrix memory crypto needs the package to resolve. */
let crypto!: typeof CryptoTypes;
async function loadCrypto(): Promise<typeof CryptoTypes> { return crypto ??= await import('@matrix-org/matrix-sdk-crypto-wasm'); }

export const MEMORY_CRYPTO_WARNING = 'Not persistent: encryption keys are lost after restart; device verification is required again.';
export interface CryptoRequest { id?: string | undefined; type: number; body: string; event_type?: string; txn_id?: string; room_id?: string }
export interface CryptoTransport {
  request(request: CryptoRequest): Promise<string>;
  members(roomId: string): Promise<string[]>;
}
export interface VerificationInput { actor: string; action: 'start' | 'inspect' | 'accept' | 'confirm' | 'cancel'; userId?: string; deviceId?: string; flowId?: string }

/** Deliberately opt-in and memory-only. No claim of restart-safe E2EE or backup support. */
export class MatrixMemoryCrypto {
  readonly #machine: CryptoTypes.OlmMachine;
  readonly #transport: CryptoTransport;
  readonly #unverified: 'reject' | 'allow';
  readonly #flows = new Map<string, { actor: string; userId: string; deviceId: string; expires: number }>();
  #tail: Promise<unknown> = Promise.resolve();
  private constructor(machine: CryptoTypes.OlmMachine, transport: CryptoTransport, unverified: 'reject' | 'allow') {
    this.#machine = machine; this.#transport = transport; this.#unverified = unverified;
  }
  static async open(userId: string, deviceId: string, transport: CryptoTransport, unverified: 'reject' | 'allow' = 'reject'): Promise<MatrixMemoryCrypto> {
    if (!isUserId(userId) || !/^[A-Za-z0-9._-]{1,255}$/.test(deviceId)) throw new Error('invalid matrix crypto identity');
    await (await loadCrypto()).initAsync();
    const machine = await crypto.OlmMachine.initialize(new crypto.UserId(userId), new crypto.DeviceId(deviceId));
    const out = new MatrixMemoryCrypto(machine, transport, unverified);
    try { await out.#flush(); return out; } catch (error) { await out.close(); throw error; }
  }
  #serial<T>(fn: () => Promise<T>): Promise<T> { const run = this.#tail.then(fn); this.#tail = run.catch(() => {}); return run; }
  async #send(request: CryptoRequest): Promise<void> {
    // Backup uploads and cross-signing are never enabled implicitly by this experimental transport.
    if (request.type === crypto.RequestType.KeysBackup) throw new Error('matrix backup requires owner confirmation and persistent crypto');
    const response = await this.#transport.request(request);
    if (request.id) await this.#machine.markRequestAsSent(request.id, request.type, response);
  }
  async #flush(): Promise<void> {
    const requests = await this.#machine.outgoingRequests();
    if (requests.length > 256) throw new Error('matrix crypto request limit');
    for (const request of requests) { try { await this.#send(request); } finally { request.free(); } }
  }
  receive(sync: SyncResponse): Promise<void> {
    return this.#serial(async () => {
      const events = sync.to_device?.events ?? [];
      if (events.length > 1000) throw new Error('matrix to-device event limit');
      const senders = [...new Set(events.map(event => event.sender).filter(isUserId))];
      if (senders.length) { await this.#machine.updateTrackedUsers(senders.map(id => new crypto.UserId(id))); await this.#flush(); }
      const processed = await this.#machine.receiveSyncChanges(JSON.stringify(events),
        new crypto.DeviceLists((sync.device_lists?.changed ?? []).filter(isUserId).map(id => new crypto.UserId(id)), (sync.device_lists?.left ?? []).filter(isUserId).map(id => new crypto.UserId(id))),
        new Map(Object.entries(sync.device_one_time_keys_count ?? {})), new Set(sync.device_unused_fallback_key_types ?? []));
      for (const event of processed) event.free();
      await this.#flush();
    });
  }
  decrypt(roomId: string, event: MatrixEvent): Promise<MatrixEvent> {
    return this.#serial(async () => {
      const settings = new crypto.DecryptionSettings(this.#unverified === 'reject' ? crypto.TrustRequirement.CrossSigned : crypto.TrustRequirement.Untrusted);
      const room = new crypto.RoomId(roomId);
      try {
        const decrypted = await this.#machine.decryptRoomEvent(JSON.stringify(event), room, settings);
        try {
          if (this.#unverified === 'reject') {
            const shield = decrypted.shieldState(true);
            try { if (shield.color !== crypto.ShieldColor.None) throw new Error('matrix unverified device rejected'); }
            finally { shield.free(); }
          }
          const parsed: unknown = JSON.parse(decrypted.event);
          if (!isObj(parsed) || typeof parsed.type !== 'string' || !isObj(parsed.content)) throw new Error('invalid decrypted matrix event');
          return { ...event, type: parsed.type, content: parsed.content };
        } finally { decrypted.free(); }
      } finally { settings.free(); room.free(); }
    });
  }
  encrypt(roomId: string, type: string, content: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.#serial(async () => {
      if (!isRoomId(roomId)) throw new Error('invalid encrypted room');
      const members = (await this.#transport.members(roomId)).filter(isUserId);
      if (members.length === 0 || members.length > 1000) throw new Error('invalid matrix room membership');
      await this.#machine.updateTrackedUsers(members.map(id => new crypto.UserId(id))); await this.#flush();
      const missing = await this.#machine.getMissingSessions(members.map(id => new crypto.UserId(id)));
      if (missing) { try { await this.#send(missing); } finally { missing.free(); } }
      const settings = new crypto.EncryptionSettings();
      settings.sharingStrategy = this.#unverified === 'reject' ? crypto.CollectStrategy.onlyTrustedDevices() : crypto.CollectStrategy.allDevices();
      const room = new crypto.RoomId(roomId);
      try {
        for (const request of await this.#machine.shareRoomKey(room, members.map(id => new crypto.UserId(id)), settings)) {
          try { await this.#send(request); } finally { request.free(); }
        }
        const result: unknown = JSON.parse(await this.#machine.encryptRoomEvent(room, type, JSON.stringify(content)));
        if (!isObj(result)) throw new Error('invalid encrypted matrix content'); return result;
      } finally { settings.free(); room.free(); }
    });
  }
  verification(input: VerificationInput): Promise<Record<string, unknown>> {
    return this.#serial(async () => {
      for (const [key, value] of this.#flows) if (value.expires <= Date.now()) this.#flows.delete(key);
      if (input.action === 'start') {
        if (!isUserId(input.userId) || !input.deviceId || this.#flows.size >= 32) throw new Error('invalid verification request');
        await this.#machine.updateTrackedUsers([new crypto.UserId(input.userId)]); await this.#flush();
        const device = await this.#machine.getDevice(new crypto.UserId(input.userId), new crypto.DeviceId(input.deviceId));
        if (!device) throw new Error('matrix device unavailable');
        try {
          const [request, outgoing] = device.requestVerification([crypto.VerificationMethod.SasV1]);
          try {
            await this.#send(outgoing);
            this.#flows.set(request.flowId, { actor: input.actor, userId: input.userId, deviceId: input.deviceId, expires: Date.now() + 10 * 60_000 });
            return { flowId: request.flowId, mode: 'memory', warning: MEMORY_CRYPTO_WARNING };
          } finally { request.free(); outgoing.free(); }
        } finally { device.free(); }
      }
      if (input.action === 'accept' && input.flowId && isUserId(input.userId) && !this.#flows.has(input.flowId)) {
        const pending = this.#machine.getVerificationRequest(new crypto.UserId(input.userId), input.flowId);
        if (!pending || this.#flows.size >= 32) throw new Error('verification unavailable');
        const deviceId = pending.otherDeviceId?.toString(); pending.free();
        if (!deviceId) throw new Error('verification unavailable');
        this.#flows.set(input.flowId, { actor: input.actor, userId: input.userId, deviceId, expires: Date.now() + 10 * 60_000 });
      }
      const binding = input.flowId ? this.#flows.get(input.flowId) : undefined;
      if (!binding || binding.actor !== input.actor) throw new Error('verification unavailable');
      const request = this.#machine.getVerificationRequest(new crypto.UserId(binding.userId), input.flowId!);
      if (!request) {
        const device = await this.#machine.getDevice(new crypto.UserId(binding.userId), new crypto.DeviceId(binding.deviceId));
        try { if (device?.isVerified()) return { flowId: input.flowId, done: true, cancelled: false }; }
        finally { device?.free(); }
        throw new Error('verification unavailable');
      }
      try {
        const outgoing = input.action === 'accept' ? request.acceptWithMethods([crypto.VerificationMethod.SasV1]) : input.action === 'cancel' ? request.cancel() : undefined;
        if (outgoing) { try { await this.#send(outgoing); } finally { outgoing.free(); } }
        if (request.isReady() && input.action === 'accept') {
          const started = await request.startSas();
          if (started) { const [sas, send] = started; try { await this.#send(send); } finally { send.free(); sas.free(); } }
        }
        const verification = request.getVerification();
        try {
          if (!(verification instanceof crypto.Sas)) return { flowId: input.flowId, done: request.isDone(), cancelled: request.isCancelled() };
          if (input.action === 'accept') { const send = verification.accept(); if (send) { try { await this.#send(send); } finally { send.free(); } } }
          if (input.action === 'confirm') {
            if (!verification.canBePresented()) throw new Error('SAS is not ready for owner confirmation');
            for (const send of await verification.confirm()) { try { await this.#send(send); } finally { send.free(); } }
          }
          const emojis = verification.emoji();
          const emoji = emojis?.map(e => ({ symbol: e.symbol, description: e.description })); emojis?.forEach(e => e.free());
          return { flowId: input.flowId, done: request.isDone(), cancelled: request.isCancelled(), ...(emoji ? { emoji } : {}), ...(verification.decimals() ? { decimals: [...verification.decimals()!] } : {}) };
        } finally { verification?.free(); }
      } finally { request.free(); }
    });
  }
  async close(): Promise<void> { await this.#tail; this.#flows.clear(); this.#machine.close(); }
}
