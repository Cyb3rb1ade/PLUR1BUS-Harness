import { isLoopbackHost } from "../egress/index.ts";
import { BUNDLED_CATALOG_ROOT, CatalogError, type CatalogClient, type CatalogOptions, type CatalogFailure, type CatalogResult, type CatalogView, type CatalogSnapshot, type CatalogCheckpoint, type CatalogRoot, type CatalogIndex, type PackageRevocation } from "./types.ts";
import { digest, envelope, fail, json, parseRoot, parseRevocations, parseCatalogIndex, timestamp, verifyEnvelope, payload } from "./verify.ts";

function failure(e: unknown): CatalogFailure {
  return e instanceof CatalogError ? { code: e.code, message: e.message } : { code: "transport", message: "catalogue I/O or reporting failed" };
}
async function result<T>(op: () => Promise<T>): Promise<CatalogResult<T>> {
  try { return { ok: true, value: await op() }; } catch (e) { return { ok: false, error: failure(e) }; }
}
function monotone(version: number, hash: string, oldVersion: number | undefined, oldHash: string | undefined, name: string): void {
  if (oldVersion !== undefined && (version < oldVersion || (version === oldVersion && hash !== oldHash))) throw new CatalogError("rollback_detected", `${name} rollback or conflicting content at version ${version}`);
}
const revokedPackage = (revocations: PackageRevocation[], id: string, version: string) => revocations.find((r) => r.id === id && r.versions.includes(version));

export function createCatalogClient(options: CatalogOptions): CatalogClient {
  // Clone caller-owned trust configuration; a result/config mutation must not change an accepted trust decision.
  const config = structuredClone(options.config);
  const { store, egress } = options;
  const now = options.now ?? Date.now;
  const maxBytes = config.maxBytes ?? 4 * 1024 * 1024;
  const artifactCap = config.maxArtifactBytes ?? 128 * 1024 * 1024;
  const timeoutMs = config.timeoutMs ?? 15_000;
  const grace = config.offlineGraceMs ?? 0;
  const rootAnchor = () => parseRoot(config.root ?? BUNDLED_CATALOG_ROOT);
  function urlPolicy(raw: string): URL {
    let url: URL;
    try { url = new URL(raw); } catch { throw new CatalogError("transport", "invalid catalogue URL"); }
    const test = config.testOrigin && url.origin === config.testOrigin && url.protocol === "http:" && isLoopbackHost(url.hostname);
    if ((url.protocol !== "https:" && !test) || url.username || url.password || url.hash) throw new CatalogError("transport", "HTTPS required (HTTP only at the explicit loopback test origin)");
    return url;
  }
  function prepare() {
    const root = rootAnchor();
    urlPolicy(config.url);
    if (maxBytes > 8 * 1024 * 1024) throw new CatalogError("transport", "metadata cap cannot exceed 8 MiB");
    if (![maxBytes, artifactCap, timeoutMs].every((n) => Number.isSafeInteger(n) && n > 0) || !Number.isSafeInteger(grace) || grace < 0) throw new CatalogError("transport", "invalid catalogue limit/timeout/grace");
    return root;
  }
  async function fetchBytes(raw: string, signal?: AbortSignal, cap = maxBytes): Promise<Buffer> {
    const url = urlPolicy(raw);
    try {
      // Zero redirects: stronger than host checking after the fact, and sends nothing to another host.
      const response = await egress.request(url.href, { maxRedirects: 0, maxBytes: cap, timeoutMs, signal, userAgent: "PLUR1BUS-Catalog/1", accept: "application/json,application/octet-stream" });
      if (response.status !== 200 || response.redirects.length || response.url !== url.href || response.body.length > cap) throw new Error("status, redirect or byte limit");
      return response.body;
    } catch { throw new CatalogError("transport", `catalogue request failed for ${url.host} (policy, status, size, timeout or redirect)`); }
  }
  interface Verified { root: CatalogRoot; index: CatalogIndex; floor: CatalogCheckpoint; expires: number }
  function authenticate(snapshot: CatalogSnapshot, previous: CatalogCheckpoint | null): Verified {
    let root = prepare();
    if (!Array.isArray(snapshot.rotations) || snapshot.rotations.length > 64) return fail("rotation chain too long or malformed");
    const oldRevoked = new Set(previous?.revokedKeys ?? []);
    const allKeys = [...root.keys];
    const rotationHashes: string[] = [];
    let rootHash = digest(Buffer.from(JSON.stringify(root)));
    for (const raw of snapshot.rotations) {
      // Only an already accepted exact delegation may be replayed under a subsequently revoked key.
      const rotationHash = digest(payload(envelope(raw)));
      const historical = previous?.rotationHashes[rotationHashes.length] === rotationHash;
      const verified = verifyEnvelope(raw, root, now(), historical ? new Set() : oldRevoked, historical);
      if (!historical && root.keys.some((k) => previous?.revokedPublicKeys.includes(k.publicKey) && verified.signers.includes(k.id))) throw new CatalogError("key_revoked", "revoked key material cannot authorize a rotation under an alias");
      const next = parseRoot(json(verified.bytes));
      if (next.version !== root.version + 1) throw new CatalogError("rollback_detected", "root rotation chain must be consecutive");
      if (!historical && timestamp(next.expires) <= now()) throw new CatalogError("stale_index", "rotated root has expired");
      root = next; allKeys.push(...next.keys); rotationHashes.push(rotationHash); rootHash = rotationHash;
    }
    monotone(root.version, rootHash, previous?.rootVersion, previous?.rootHash, "trust root");
    const indexVerified = verifyEnvelope(snapshot.index, root, now(), oldRevoked);
    const index = parseCatalogIndex(indexVerified.bytes, config.testOrigin);
    if (index.rootVersion !== root.version) return fail("index belongs to a different signed root version");
    monotone(index.serial, digest(indexVerified.bytes), previous?.serial, previous?.indexHash, "index");
    const revVerified = verifyEnvelope(snapshot.revocations, root, now(), oldRevoked);
    const rev = parseRevocations(revVerified.bytes);
    if (rev.rootVersion !== root.version || rev.version !== index.revocation.version || digest(revVerified.bytes) !== index.revocation.sha256) return fail("index and revocation metadata do not match");
    monotone(rev.version, digest(revVerified.bytes), previous?.revocationVersion, previous?.revocationHash, "revocations");
    // Revocations are permanent. Neither a rotation nor a newer list can resurrect a key or package version.
    const revoked = new Set(rev.keys);
    for (const id of oldRevoked) if (!revoked.has(id)) throw new CatalogError("key_revoked", `revocation list removed revoked key ${id}`);
    for (const p of previous?.revokedPackages ?? []) for (const version of p.versions) if (!revokedPackage(rev.packages, p.id, version)) throw new CatalogError("revoked_package", `revocation list removed ${p.id}@${version}`);
    const revokedPublicKeys = new Set(previous?.revokedPublicKeys ?? []);
    for (const k of allKeys) if (revoked.has(k.id)) revokedPublicKeys.add(k.publicKey);
    for (const signer of [...indexVerified.signers, ...revVerified.signers]) if (root.keys.some((k) => k.id === signer && revokedPublicKeys.has(k.publicKey))) throw new CatalogError("key_revoked", "revoked key material signed metadata under an alias");
    verifyEnvelope(snapshot.index, root, now(), revoked);
    verifyEnvelope(snapshot.revocations, root, now(), revoked);
    const expires = Math.min(timestamp(index.expires), timestamp(rev.expires), timestamp(root.expires));
    if (timestamp(index.generatedAt) > now()) return fail("index generatedAt is in the future");
    const floor: CatalogCheckpoint = { serial: index.serial, indexHash: digest(indexVerified.bytes), rootVersion: root.version, rootHash,
      revocationVersion: rev.version, revocationHash: digest(revVerified.bytes), revokedKeys: [...revoked], revokedPublicKeys: [...revokedPublicKeys], revokedPackages: rev.packages, rotationHashes };
    return { root, index, floor, expires };
  }
  async function view(verified: Verified, snapshot: CatalogSnapshot, source: "network" | "cache"): Promise<CatalogView> {
    const { index, floor, expires } = verified;
    if (options.installed) {
      const installed = await options.installed.list();
      await options.installed.report(installed.flatMap((item) => {
        const r = revokedPackage(floor.revokedPackages, item.id, item.version);
        return r ? [{ ...item, status: "revoked" as const, reason: r.reason }] : [];
      }));
    }
    return { index: { ...index, packages: index.packages.map((p) => ({ ...p, versions: p.versions.filter((v) => !revokedPackage(floor.revokedPackages, p.id, v.version)) })).filter((p) => p.versions.length > 0) }, rootVersion: floor.rootVersion, fetchedAt: snapshot.fetchedAt, source, stale: expires <= now() };
  }
  async function refresh(signal?: AbortSignal): Promise<CatalogView> {
    prepare();
    const { checkpoint, legacySerial } = await store.read();
    const origin = new URL(config.url);
    const [indexBytes, revBytes, rotationBytes] = await Promise.all([
      fetchBytes(config.url, signal), fetchBytes(config.revocationsUrl ?? new URL("revocations", origin).href, signal), fetchBytes(config.rotationsUrl ?? new URL("rotations", origin).href, signal),
    ]);
    const rotations = json(rotationBytes);
    if (!Array.isArray(rotations)) return fail("rotations must be a complete array");
    const snapshot: CatalogSnapshot = { index: envelope(json(indexBytes)), revocations: envelope(json(revBytes)), rotations: rotations.map(envelope), fetchedAt: now() };
    const verified = authenticate(snapshot, checkpoint);
    if (legacySerial !== undefined && verified.index.serial <= legacySerial) throw new CatalogError("rollback_detected", "new-format index must advance the legacy serial floor");
    if (verified.expires <= now()) throw new CatalogError("stale_index", "fetched index or revocation list expired; refusing frozen metadata");
    await store.write(verified.floor, snapshot);
    return view(verified, snapshot, "network");
  }
  return {
    refresh: (signal) => result(() => store.exclusive(() => refresh(signal))),
    get: (signal) => result(() => store.exclusive(async () => {
      try { return await refresh(signal); }
      catch (e) {
        const error = failure(e);
        // Never hide signature, revocation, rollback or freeze attacks behind an older cache.
        if (error.code !== "transport") throw e;
        const { checkpoint, snapshot } = await store.read();
        if (!snapshot) throw e;
        const verified = authenticate(snapshot, checkpoint);
        const cachedView = await view(verified, snapshot, "cache");
        if (verified.expires + grace <= now()) throw new CatalogError("stale_index", "offline catalogue expired beyond configured grace");
        return { ...cachedView, refreshError: error };
      }
    })),
    download: (selection, signal) => result(() => store.exclusive(async () => {
      prepare();
      const { checkpoint, snapshot } = await store.read();
      if (!snapshot) throw new CatalogError("transport", "no authenticated index cached");
      const verified = authenticate(snapshot, checkpoint);
      if (verified.expires <= now()) throw new CatalogError("stale_index", "downloads forbidden from stale metadata, including offline grace");
      if (selection.serial !== verified.index.serial) throw new CatalogError("rollback_detected", "package selection belongs to another signed index version");
      if (revokedPackage(verified.floor.revokedPackages, selection.id, selection.version)) throw new CatalogError("revoked_package", "selected package version is revoked");
      const version = verified.index.packages.find((p) => p.id === selection.id)?.versions.find((v) => v.version === selection.version);
      if (!version) return fail("package/version absent from the signed index");
      if (version.size > artifactCap) throw new CatalogError("transport", "signed artifact size exceeds configured artifact limit");
      const bytes = await fetchBytes(version.url, signal, version.size);
      if (bytes.length !== version.size || digest(bytes) !== version.sha256) throw new CatalogError("hash_mismatch", "artifact differs from signed index hash/size");
      authenticate(snapshot, verified.floor);
      if (verified.expires <= now()) throw new CatalogError("stale_index", "catalogue expired during artifact download");
      return new Uint8Array(bytes);
    })),
  };
}
