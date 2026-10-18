import { connect, readRunToken, readRecordedPid, supervisorAddress, supervisorTokenPath, supervisorPidPath, type CoreClient } from '@plur1bus/module-api';
export interface ExtensionCapability { name: string; kind: string; enabled: boolean; agents: readonly string[] | 'all'; overlays: readonly string[] }
/** Read-only consumer of X1/X2; a broken or lost supervisor connection fails closed. */
export class ExtensionCapabilityFeed {
  #client: CoreClient | undefined;
  #closed = false;
  readonly #home: string;
  readonly #connect: typeof connect;
  constructor(home: string, connectPort: typeof connect = connect) { this.#home = home; this.#connect = connectPort; }
  #snapshotWork: Promise<ExtensionCapability[]> | undefined;
  snapshot(): Promise<ExtensionCapability[]> {
    this.#snapshotWork ??= this.#snapshot().finally(() => { this.#snapshotWork = undefined; });
    return this.#snapshotWork;
  }
  async #snapshot(): Promise<ExtensionCapability[]> {
    if (this.#closed) return [];
    if (!this.#client) {
      const pid = readRecordedPid(supervisorPidPath(this.#home));
      const client = await this.#connect({ address: supervisorAddress(this.#home), token: readRunToken(this.#home, supervisorTokenPath(this.#home)), endpoint: 'supervisor', connectTimeoutMs: 1000, callTimeoutMs: 2000, ...(pid ? { expectedServerPid: pid } : {}) });
      if (this.#closed) { await client.close(); return []; }
      this.#client = client;
      client.onClose(() => { if (this.#client === client) this.#client = undefined; });
      client.onNotification(method => { if (method === 'ext.changed') this.onChanged?.(); });
      try { await client.call('ext.watch', {}); } catch (e) { this.#client = undefined; await client.close(); throw e; }
    }
    // ext.list re-evaluates overlays and per-agent permissions, including revocations between notifications.
    const result = await this.#client.call<{ items: ExtensionCapability[] }>('ext.list', {});
    if (!Array.isArray(result.items)) throw Error('invalid extension catalogue');
    return result.items.filter(item => item && typeof item.name === 'string' && item.kind === 'skill' && item.enabled === true && Array.isArray(item.overlays) && item.overlays.length === 0 && (item.agents === 'all' || Array.isArray(item.agents)));
  }
  onChanged: (() => void) | undefined;
  async close(): Promise<void> { this.#closed = true; await this.#client?.close(); this.#client = undefined; }
}
