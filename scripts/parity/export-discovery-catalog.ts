import { fileURLToPath } from "node:url";
import { createCatalogClient } from "../../packages/core/src/catalog/client.ts";
import type { CatalogCheckpoint, CatalogConfig, CatalogSnapshot, CatalogStore } from "../../packages/core/src/catalog/types.ts";
import { EXPIRES, NOW, hash, index, revocations, root, signed } from "../../packages/core/test/catalog/signing.ts";
import type { Egress } from "../../packages/core/src/egress/index.ts";
import { testKey } from "./export-discovery-trust.ts";
import { exporterMain } from "./lib.mjs";

function key(id: string, seed: number) {
  const { key: privateKey, publicKey } = testKey(seed);
  return { id, privateKey, publicKey, expires: "2027-01-01T00:00:00Z" };
}

const bytes = Buffer.from("synthetic package");
const anchor = key("fixture-anchor", 1);
const rotated = key("fixture-rotated", 2);
const backup = key("fixture-backup", 3);
const base = "https://catalog.fixture.invalid";
const asset = "https://assets.test/skill.p1x";
const pastExpiry = Date.parse(EXPIRES) + 1;
const revokedPackage = { id: "owner/skill", versions: ["1.*"], reason: "fixture revocation" };
const selection = { serial: 2, id: "owner/skill", version: "1.0.0" };

function serve(serial: number, options: {
  keys?: ReturnType<typeof key>[]; rotations?: unknown[]; version?: number; rev?: ReturnType<typeof revocations>;
  indexOptions?: Record<string, unknown>; tamper?: boolean; artifact?: Buffer;
} = {}) {
  const signers = options.keys ?? [anchor];
  const rootVersion = options.version ?? 1;
  const rev = options.rev ?? revocations({ rootVersion });
  const revocation = signed(rev, signers);
  const doc = index(serial, bytes, { rootVersion, revocation: { version: rev.version, sha256: hash(Buffer.from(revocation.payload, "base64")) }, ...options.indexOptions });
  const envelope = signed(doc, signers);
  if (options.tamper) envelope.payload = Buffer.from(JSON.stringify({ ...doc, serial: serial + 1 })).toString("base64");
  return {
    "/index": envelope, "/rotations": options.rotations ?? [], "/revocations": revocation,
    [asset]: (options.artifact ?? bytes).toString("base64"),
  };
}

type Action = { op: "refresh" | "get" | "download"; routes?: Record<string, unknown>; time?: number; selected?: typeof selection };

export async function recordDiscoveryCatalog() {
  const rotation = signed(root([rotated], 2), [anchor]);
  const rotatedRoutes = serve(2, { keys: [rotated], rotations: [rotation], version: 2 });
  const revoke = revocations({ version: 2, keys: ["fixture-anchor"], packages: [revokedPackage] });
  const alias = { ...anchor, id: "fixture-alias" };
  const extraRevocations = "https://revocations.fixture.invalid/signed";
  const defaults = { url: `${base}/index`, maxBytes: 32_768, offlineGraceMs: 1000 };
  const reply = serve(2);
  const cases: { name: string; keys?: ReturnType<typeof key>[]; legacySerial?: number; config?: Partial<CatalogConfig>; actions: Action[] }[] = [
    { name: "network-cache-download", actions: [{ op: "refresh", routes: serve(2) }, { op: "download", routes: serve(2) }, { op: "get" }] },
    { name: "configured-catalogue-endpoints-and-caps", config: {
      rotationsUrl: `${base}/channel/rotations`, revocationsUrl: extraRevocations,
      timeoutMs: 2500, maxArtifactBytes: bytes.length - 1,
    }, actions: [
      { op: "refresh", routes: { ...reply, "/channel/rotations": reply["/rotations"], [extraRevocations]: reply["/revocations"] } },
      { op: "download", routes: reply }, { op: "get" },
    ] },
    { name: "explicit-loopback-test-origin", config: {
      url: "http://localhost:4781/index", testOrigin: "http://localhost:4781",
    }, actions: [{ op: "refresh", routes: reply }, { op: "download", routes: reply }] },
    { name: "rollback-and-equivocation", actions: [
      { op: "refresh", routes: serve(2) }, { op: "refresh", routes: serve(1) },
      { op: "get", routes: serve(2, { indexOptions: { generatedAt: "2026-10-06T00:00:00Z" } }) },
      { op: "get", routes: serve(2, { tamper: true }) }, { op: "get" },
    ] },
    { name: "legacy-floor", legacySerial: 2, actions: [{ op: "refresh", routes: serve(2) }, { op: "refresh", routes: serve(3) }] },
    { name: "expiry-and-grace", actions: [
      { op: "refresh", routes: serve(2) }, { op: "refresh", routes: serve(2), time: pastExpiry },
      { op: "get", time: pastExpiry }, { op: "download", time: pastExpiry }, { op: "get", time: pastExpiry + 1000 },
    ] },
    { name: "rotation-and-root-floor", actions: [
      { op: "refresh", routes: rotatedRoutes }, { op: "get" }, { op: "refresh", routes: serve(3) },
    ] },
    { name: "nonconsecutive-rotation", actions: [
      { op: "refresh", routes: serve(2, { keys: [rotated], rotations: [signed(root([rotated], 3), [anchor])], version: 3 }) },
    ] },
    { name: "revocation-and-alias", keys: [anchor, backup], actions: [
      { op: "refresh", routes: serve(2, { keys: [backup], rev: revoke }) }, { op: "download" },
      { op: "refresh", routes: serve(3, { keys: [backup], rev: revocations({ version: 3, keys: ["fixture-anchor"] }) }) },
      { op: "refresh", routes: serve(3, { keys: [backup], rev: revocations({ version: 3, packages: [revokedPackage] }) }) },
      { op: "refresh", routes: serve(3, { keys: [alias], rotations: [signed(root([alias], 2), [backup])], version: 2,
        rev: revocations({ version: 3, rootVersion: 2, keys: ["fixture-anchor"], packages: [revokedPackage] }) }) },
    ] },
    { name: "artifact-hash-size-and-selection", actions: [
      { op: "refresh", routes: serve(2) },
      { op: "download", routes: serve(2, { artifact: Buffer.alloc(bytes.length, 7) }) },
      { op: "download", routes: serve(2, { artifact: Buffer.alloc(1) }) },
      { op: "download", routes: serve(2), selected: { ...selection, serial: 1 } },
      { op: "download", routes: serve(2), selected: { ...selection, id: "missing" } },
    ] },
  ];
  const vectors = [];
  for (const entry of cases) {
    const trustRoot = root(entry.keys ?? [anchor]);
    const config = { ...defaults, ...entry.config, root: trustRoot };
    const origin = new URL(config.url).origin;
    const { id, version } = selection;
    let checkpoint: CatalogCheckpoint | null = null;
    let snapshot: CatalogSnapshot | null = null;
    let legacySerial = entry.legacySerial;
    const store: CatalogStore = {
      read: async () => ({ checkpoint, snapshot, legacySerial }),
      async write(next, signedSnapshot) { checkpoint = next; snapshot = signedSnapshot; legacySerial = undefined; },
      exclusive: op => op(),
    };
    const steps = [];
    for (const action of entry.actions) {
      const requests: unknown[] = [];
      const reports: unknown[] = [];
      const egress = { request: async (url: string, options: { maxRedirects: number; maxBytes: number; timeoutMs: number; userAgent: string; accept: string }) => {
        const target = new URL(url).origin === origin ? new URL(url).pathname : url;
        requests.push({ target, ...options });
        const reply = action.routes?.[target];
        if (reply === undefined) throw new Error("fixture unavailable");
        const body = typeof reply === "string" ? Buffer.from(reply, "base64") : Buffer.from(JSON.stringify(reply));
        return { url, body, redirects: [], status: 200 };
      } } as Egress;
      const client = createCatalogClient({
        config,
        store, egress, now: () => action.time ?? NOW,
        installed: { list: async () => [{ id, version }], report: async items => { reports.push(items); } },
      });
      const result = action.op === "download" ? await client.download(action.selected ?? selection) : await client[action.op]();
      let expected;
      if (!result.ok) expected = { code: result.error.code };
      else if (result.value instanceof Uint8Array) expected = { artifact: Buffer.from(result.value).toString("base64") };
      else {
        const { index: signedIndex, rootVersion, source, stale, fetchedAt, warnings, refreshError } = result.value;
        expected = { index: signedIndex, rootVersion, source, stale, fetchedAt, warnings, refreshError: refreshError?.code };
      }
      steps.push({ op: action.op, time: action.time ?? NOW, routes: action.routes, selected: action.selected,
        expected, requests: requests.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), reports, checkpoint });
    }
    vectors.push({ name: entry.name, config, legacySerial: entry.legacySerial, steps });
  }
  return { catalog: { source: "packages/core/src/catalog/client.ts", selection, cases: vectors } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await exporterMain({ area: "discovery", build: recordDiscoveryCatalog });
}
