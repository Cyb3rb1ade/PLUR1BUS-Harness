// P4-20 flips B1 and B2: the front door owns the secret store. The TypeScript core behind it reaches the store over
// the bridge (`bridge.secret.*` on run/core-bridge.sock, docs/phase4/bridge.md), and six `secret.*` methods are
// answered by the front door itself (status, list, describe, set, get, delete; `secret.grants.list` stays), and so is
// the engine's `host.secret.get` on an engine connection. This runs
// one scenario four times and compares the answers and the audit lines: on a stock TypeScript core; on the front door
// that owns the store and answers; on the front door that owns the store while the TypeScript core answers through the
// bridge (`PLUR1BUS_P4_IDENTITY=ts` relays every native method: flip B1's path); and on the front door with
// `PLUR1BUS_P4_SECRETS=ts` (the store stays with the TypeScript core; the switch needs the test seam).
//
// The scenario walks the store through the owner's methods (status, list, set, get, describe, rotation, the refusals,
// delete) and through one caller inside the core that takes leases (`agent.export`: the signing key is made, leased and
// released, and every secret is leased once for the export's redaction). What a leg wrote to logs/audit.log must be the
// same lines in the same order, apart from the time and the lease ids.
//
// The engine. The scenario writes a token to run/engine.token (no engine process runs here, so nobody else writes the
// file) and opens a connection as the engine does. `host.secret.get` over it: a value, a name nobody set, a name that
// is none, a call without a name, and, after another token was written to the file, a call on the same connection,
// which is refused. One other method on the engine's connection and the owner's own `host.secret.get` are refused by
// the TypeScript core on every leg. The lease and its revocation are two audit lines, compared like the rest.
//
// Who answers the engine (R-20-38). The front door answers `host.secret.get` for a name of its own set, the set of
// the last valid `config.json`; a name outside it goes on to the TypeScript core, which knows the planned target of an
// embedding migration and decides. On the native leg the TypeScript core therefore reads the engine's requests for a
// name outside the set (not the one without a name, which the front door refuses for its parameters), and the
// recording is checked for exactly those: the scenario counts, at each call, whether the name is in the set of the
// file as it is then (`engineSecretNames`).
//
// What the engine may resolve (P4D-29). The engine gets the secrets its configuration refers to and no other stored one.
// The scenario's configuration refers to NAME from `engine.merging.apiKeyRef`. Over the engine's connection, on every
// leg: a stored name outside the configuration and a name nobody set get the same answer (and leave one
// `secret.denied` line each, which names the engine as the one who asked, no lease); a reference put into `config.json` is served by the next request and taken out
// it is refused by the next one; a name a block falls back to (`OPENAI_API_KEY`, `x-secret-default` of the schema) is
// served while the block is in the configuration and refused without it; and it is served without the block while the
// checkpoint of an embedding migration says a remote target is under way (R-20-38), and refused once it says aborted.
//
// Persons behind the harness API (review S1). Five of the six methods have no RBAC rule: who is the store's owner is
// decided by the mapping from the connection's principal alone (`principalOf` in core.ts, `store_principal` in
// native_secrets.rs). The scenario opens an API connection for an Owner, an Admin, a Member, a disabled person and a
// person the store does not know; each claims a role it does not have, and calls `secret.status`, `secret.set` and
// `secret.describe`. Only the Owner is the store's owner. The answers and the lines the refusals leave in
// logs/audit.log (`secret.denied`, the guard's own for `secret.describe`) are compared like the rest.
//
// Who answered. Every leg records the frames its TypeScript core reads and writes (the parity recorder, a test seam).
// On the leg where the front door answers, none of the six methods and none of the engine's `host.secret.get` calls
// may reach the TypeScript core, `secret.grants.list` and the owner's `host.secret.get`
// must, and the core must have been told of the changes (`legacy.secret.changed`, whose value the recorder replaces);
// on the other legs every one of the calls reaches it and nothing is told. No value may be in a recorded frame other
// than the answer to a `secret.get` (which is where a reveal shows it) or to a `host.secret.get`.
//
// Who holds the store. On the legs where the front door owns it, the bridge answers a holder of run/core-legacy.token:
// `bridge.secret.list` shows a name that was set through `secret.set`, so the front door's store is the one the
// clients' calls reach, natively or over the bridge. The witness opens its connection as the TypeScript core does, with the keyring
// service a TypeScript core derives from the home; a front door that derived another one refuses it. Opening it takes
// the store from the TypeScript core (the front door serves the store on the connection that opened last), so the
// witness comes last. On the other two legs nothing listens at the bridge's address.
//
// Three variants: the keyring (the in-memory stand-in of the test seam; no run reaches a real keyring), the file
// backend (`secrets.fileFallback.enabled`, keyring off), and a home given with a trailing separator (the two processes
// must still derive one keyring service name from it).
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { unitAddress } from "@plur1bus/module-api";
import { AdminStore } from "../../packages/core/src/identity/admin-store.ts";
import { layout } from "../../packages/core/src/paths.ts";
import { keyringServiceOf } from "../../packages/core/src/secrets/runtime.ts";
import { engineSecretNames } from "../../packages/core/src/engine/secret-scope.ts";
import { createStateStore } from "../../packages/core/src/embedding-migrate/state.ts";
import { tempDir } from "../../packages/core/test/helpers/temp-dir.ts";
import { settled } from "./p4-10-parity.ts";
import { differences, type Leg, type Step } from "./p4-12-native.ts";
import { rawConnect } from "./raw-client.ts";
import { startProcessTarget } from "./target.ts";

export type { Leg, Step };

/** Which process holds the store on a leg, and which answers the six `secret.*` methods. */
export type Holder = "typescript" | "front-door";
export interface SecretLeg extends Leg { holder: Holder; answers: Holder }
export const LEGS: readonly SecretLeg[] = [
  { name: "typescript", impl: "ts", holder: "typescript", answers: "typescript" },
  { name: "front door, native: its store, its answers", impl: "rust", holder: "front-door", answers: "front-door" },
  { name: "front door, its store, the TypeScript core answers over the bridge (PLUR1BUS_P4_IDENTITY=ts)", impl: "rust", env: { PLUR1BUS_P4_IDENTITY: "ts" }, holder: "front-door", answers: "typescript" },
  { name: "front door, the store stays with the TypeScript core (PLUR1BUS_P4_SECRETS=ts)", impl: "rust", env: { PLUR1BUS_P4_SECRETS: "ts" }, holder: "typescript", answers: "typescript" },
];

/** The methods the front door answers itself while it owns the store (`SECRET_METHODS` of native_secrets.rs). */
export const NATIVE_SECRET_METHODS: readonly string[] = ["secret.delete", "secret.describe", "secret.get", "secret.list", "secret.set", "secret.status"];
/** The engine's method: answered by the front door for an engine connection while it owns the store, and by the
 *  TypeScript core for everyone else (`ENGINE_NATIVE` of route.rs). */
export const ENGINE_METHOD = "host.secret.get";
/** What the recorder writes in place of a value (`PARITY_SECRET_PLACEHOLDER` of module-api). */
const PLACEHOLDER = "[REDACTED:secret]";

export interface RecordingFacts {
  /** Requests the TypeScript core read, by method, for the six native methods, `secret.grants.list` and the engine's
   *  `host.secret.get`. */
  read: Record<string, number>;
  /** `legacy.secret.changed` requests it read, and how many of them named a secret. */
  told: number;
  toldByName: number;
  /** Those whose value was written down as it came (the recorder must have replaced it). */
  toldOpen: number;
  /** Frames that hold a value and are no answer to a `secret.get` or a `host.secret.get`. */
  framesWithValues: number;
}

/** What a recording (the lines of every file a leg's recorders wrote) says about who answered and what was written. */
export function recordingFacts(lines: readonly string[], values: readonly string[] = VALUES): RecordingFacts {
  const facts: RecordingFacts = { read: {}, told: 0, toldByName: 0, toldOpen: 0, framesWithValues: 0 };
  const gets = new Set<string>();
  for (const text of lines) {
    if (!text.trim()) continue;
    const { file, conn, dir, msg } = JSON.parse(text) as { file?: string; conn: number; dir: string; msg: any };
    const key = `${file ?? ""}:${conn}:${JSON.stringify(msg?.id)}`;
    const method = dir === "in" && typeof msg?.method === "string" ? msg.method as string : undefined;
    if (method !== undefined && (NATIVE_SECRET_METHODS.includes(method) || method === "secret.grants.list" || method === ENGINE_METHOD)) facts.read[method] = (facts.read[method] ?? 0) + 1;
    if (method === "secret.get" || method === ENGINE_METHOD) gets.add(key);
    const answersGet = dir === "out" && msg?.method === undefined && gets.delete(key);
    if (!answersGet && values.some((v) => text.includes(v))) facts.framesWithValues++;
    if (method === "legacy.secret.changed") {
      facts.told++;
      if (typeof msg?.params?.name === "string") facts.toldByName++;
      if (msg?.params?.secret !== undefined && msg.params.secret !== PLACEHOLDER) facts.toldOpen++;
    }
  }
  return facts;
}

/** What the recording of a leg must show, as findings. `sent` is how often the scenario sent each method, `byEngine`
 *  how many of those calls went over the engine's connection, `inScope` how many of the engine's `host.secret.get`
 *  calls asked for a name the configuration referred to at that moment, or named none (all of them when it is not
 *  given). The front door answers the engine `host.secret.get` unless the call names a secret outside its own set
 *  (P4D-29, R-20-38), and answers nobody else `host.secret.get`: of that method the owner's calls and the engine's
 *  calls for a name outside the set reach the TypeScript core, which decides those; on every other leg all of them
 *  do. Of the six methods the engine's calls reach it on every leg. */
export function recordingFindings(leg: SecretLeg, facts: RecordingFacts, sent: Readonly<Record<string, number>>, byEngine: Readonly<Record<string, number>> = {}, inScope: number = byEngine[ENGINE_METHOD] ?? 0): string[] {
  const out: string[] = [];
  {
    const native = leg.answers === "front-door";
    const [read, expected] = [facts.read[ENGINE_METHOD] ?? 0, (sent[ENGINE_METHOD] ?? 0) - (native ? inScope : 0)];
    if (read !== expected) out.push(native
      ? `${leg.name}: ${read} ${ENGINE_METHOD} requests reached the TypeScript core, expected ${expected} (the owner's, and the engine's for a name outside the front door's set); the front door ${read > expected ? "relayed" : "answered"} the others`
      : `${leg.name}: the TypeScript core read ${read} ${ENGINE_METHOD} requests, expected ${expected}`);
  }
  for (const method of [...NATIVE_SECRET_METHODS, "secret.grants.list"]) {
    const native = leg.answers === "front-door" && method !== "secret.grants.list";
    const [read, expected] = [facts.read[method] ?? 0, native ? byEngine[method] ?? 0 : sent[method] ?? 0];
    if (read !== expected) out.push(native
      ? `${leg.name}: ${read} ${method} requests reached the TypeScript core${expected ? `, expected ${expected} (the engine's)` : ""}; the front door relayed them`
      : `${leg.name}: the TypeScript core read ${read} ${method} requests, expected ${expected}`);
  }
  if (leg.answers === "front-door") {
    // A set (twice for the rotation), two more names, a delete: at least that many changes by name.
    if (facts.toldByName < 5) out.push(`${leg.name}: the TypeScript core was told of ${facts.toldByName} changes by name, at least 5 expected`);
  } else if (facts.told !== 0) out.push(`${leg.name}: the TypeScript core was told of ${facts.told} changes, but it made them itself`);
  if (facts.toldOpen !== 0) out.push(`${leg.name}: ${facts.toldOpen} legacy.secret.changed requests were recorded with their value`);
  if (facts.framesWithValues !== 0) out.push(`${leg.name}: ${facts.framesWithValues} recorded frames hold a value and are no answer to a secret.get or a host.secret.get`);
  return out;
}

function recordingLines(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    for (const text of readFileSync(join(dir, name), "utf8").split("\n")) {
      if (text.trim()) out.push(JSON.stringify({ file: name, ...JSON.parse(text) }));
    }
  }
  return out;
}

export interface Variant {
  name: string;
  env: Record<string, string>;
  config?: (cfg: any) => void;
  /** The home as the processes are given it. */
  home?: (home: string) => string;
}
export const VARIANTS: readonly Variant[] = [
  { name: "keyring", env: { PLUR1BUS_SECRETS_KEYRING: "memory" } },
  { name: "file backend", env: { PLUR1BUS_SECRETS_KEYRING: "off" }, config: (cfg) => { cfg.secrets = { ...(cfg.secrets ?? {}), fileFallback: { enabled: true } }; } },
  { name: "keyring, the home given with a trailing separator", env: { PLUR1BUS_SECRETS_KEYRING: "memory" }, home: (home) => `${home}${sep}` },
];

/** The values of the scenario: plain words, long enough to be masked, in no log line by accident. */
export const FIRST = "the first value of the parity secret store";
export const SECOND = "the value the parity secret was rotated to";
export const OTHER = "the value of the second parity secret";
export const BY_API = "the value an owner behind the api set";
export const REFUSED = "the value nobody but an owner may set";
export const FALLBACK = "the value of the name an engine block falls back to";
export const VALUES: readonly string[] = [FIRST, SECOND, OTHER, BY_API, REFUSED, FALLBACK];
/** The persons behind the API: the role the store has for each, and the role its delegation claims. */
export const API_PERSONS: ReadonlyArray<{ id: string; stored: "owner" | "admin" | "member" | null; disabled?: true; claims: string }> = [
  { id: "api-owner", stored: "owner", claims: "viewer" },
  { id: "api-admin", stored: "admin", claims: "owner" },
  { id: "api-member", stored: "member", claims: "owner" },
  { id: "api-disabled", stored: "owner", disabled: true, claims: "admin" },
  { id: "api-unknown", stored: null, claims: "owner" },
];
/** How long the scenario waits after it wrote `config.json` before the next request of the engine. */
const CONFIG_SETTLE_MS = 400;
const NAME = "parity.secrets";
const OTHER_NAME = "parity.other";
/** A name an engine block falls back to without a reference of its own (`x-secret-default` of the `embedding` block). */
const FALLBACK_NAME = "OPENAI_API_KEY";
/** The id the bridge witness names itself with; its audit line is the one line only the owning leg has. */
export const WITNESS = "parity-witness";

const TIME = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** An answer without what differs between two runs: the request id, the home's path, times and uuids. */
export function normalised(reply: any, homes: readonly string[]): unknown {
  let text = JSON.stringify(reply?.error !== undefined ? { error: reply.error } : { result: reply?.result });
  for (const home of homes) text = text.replaceAll(JSON.stringify(home).slice(1, -1), "<home>");
  return JSON.parse(text.replace(TIME, "<time>").replace(UUID, "<uuid>"));
}

/** A line of logs/audit.log without its time and without the lease id (a random id per lease). */
export function auditLine(text: string): unknown {
  const rec = JSON.parse(text);
  if (typeof rec.at === "number") rec.at = "<at>";
  if (rec.detail && typeof rec.detail.leaseId === "string") rec.detail.leaseId = "<lease>";
  return rec;
}

/** The audit lines of a leg, split into the scenario's own and the witness's. */
export function auditLines(text: string): { own: unknown[]; witness: number } {
  const own: unknown[] = [];
  let witness = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const rec = auditLine(line) as { actor?: { user?: unknown } };
    if (rec.actor?.user === WITNESS) witness++; else own.push(rec);
  }
  return { own, witness };
}

/** The names of the texts that hold one of `values`. */
export function holding(texts: ReadonlyArray<readonly [name: string, text: string]>, values: readonly string[] = VALUES): string[] {
  return texts.filter(([, text]) => values.some((v) => text.includes(v))).map(([name]) => name);
}

export interface Witness {
  /** The bridge's address took a connection. */
  listening: boolean;
  /** The names `bridge.secret.list` answered with, when it answered. */
  names?: string[];
  /** The refusal, when it did not. */
  error?: unknown;
}

/** What the witness must have seen on a leg, as findings. */
export function witnessFindings(leg: SecretLeg, w: Witness, audited: number): string[] {
  const out: string[] = [];
  if (leg.holder === "front-door") {
    if (!w.listening) out.push(`${leg.name}: nothing listens at the bridge's address; the front door does not hold the store`);
    else if (!w.names) out.push(`${leg.name}: the bridge refused the witness: ${JSON.stringify(w.error)}`);
    else {
      if (!w.names.includes(OTHER_NAME)) out.push(`${leg.name}: the bridge's list has no ${OTHER_NAME}; the client's secret.set did not reach the front door's store`);
      if (w.names.includes(NAME)) out.push(`${leg.name}: the bridge's list still has ${NAME} after its deletion`);
    }
    if (audited !== 1) out.push(`${leg.name}: ${audited} audit lines of the witness, expected 1`);
  } else {
    if (w.listening) out.push(`${leg.name}: something listens at the bridge's address, but the store is the TypeScript core's`);
    if (audited !== 0) out.push(`${leg.name}: ${audited} audit lines of a witness that never reached a store`);
  }
  return out;
}

/** Asks the bridge of a home for its list. `home` is the home as a TypeScript core spells it (however the processes
 *  were given it): the address and the keyring service are derived from that text. */
async function witness(home: string): Promise<Witness> {
  let c;
  try { c = await rawConnect(unitAddress(home, "core-bridge")); } catch { return { listening: false }; }
  try {
    const token = readFileSync(join(layout(home).run, "core-legacy.token"), "utf8").trim();
    c.send({ jsonrpc: "2.0", id: 1, method: "core.auth", params: { token } });
    const hello = await c.waitFor((f) => f.id === 1, "the bridge's handshake", 10_000);
    if (hello?.result === undefined) return { listening: true, error: hello?.error };
    c.send({ jsonrpc: "2.0", id: 2, method: "bridge.secret.preload", params: { service: keyringServiceOf(home) } });
    const opened = await c.waitFor((f) => f.id === 2, "bridge.secret.preload", 10_000);
    if (opened?.result === undefined) return { listening: true, error: opened?.error };
    c.send({ jsonrpc: "2.0", id: 3, method: "bridge.secret.list", params: { principal: { kind: "owner", id: WITNESS } } });
    const reply = await c.waitFor((f) => f.id === 3, "bridge.secret.list", 10_000);
    if (reply?.result === undefined) return { listening: true, error: reply?.error };
    return { listening: true, names: (reply.result.secrets as Array<{ name: string }>).map((s) => s.name) };
  } finally { await c.close(); }
}

export async function scenario(leg: SecretLeg, variant: Variant, findings: string[], notes: string[] = []): Promise<Step[]> {
  const at = tempDir("p1b-secrets-");
  const home = variant.home ? variant.home(at) : at;
  const who = `${variant.name}, ${leg.name}`;
  const recordings = tempDir("p1b-secrets-rec-");
  const env = { ...(leg.env ?? {}), ...variant.env, PLUR1BUS_PARITY_RECORD: join(recordings, "rpc.ndjson") };
  // The configuration refers to NAME: it is the one name the engine may resolve until the scenario changes that.
  const config = (cfg: any): void => { variant.config?.(cfg); cfg.engine = { ...(cfg.engine ?? {}), merging: { ...(cfg.engine?.merging ?? {}), apiKeyRef: NAME } }; };
  const target = await startProcessTarget(leg.impl, { home, env, stderr: "ignore", config });
  const steps: Step[] = [];
  const sent: Record<string, number> = {};
  const byEngine: Record<string, number> = {};
  /** The engine's `host.secret.get` calls for a name `config.json` referred to when the call was sent, or for none. */
  let inScope = 0;
  let seen: Witness = { listening: false };
  try {
    await settled(target);
    const homes = [...new Set([realpathSync(at), at])];
    const c = await rawConnect(target.address);
    let n = 0;
    const call = async (method: string, params: unknown): Promise<any> => {
      const id = ++n;
      sent[method] = (sent[method] ?? 0) + 1;
      c.send({ jsonrpc: "2.0", id, method, params });
      return c.waitFor((f) => f.id === id && f.method === undefined, method, 30_000);
    };
    try {
      await call("core.auth", { token: target.token });
      const step = async (label: string, method: string, params: Record<string, unknown> = {}): Promise<any> => {
        const reply = await call(method, params);
        steps.push([label, normalised(reply, homes)]);
        return reply;
      };
      const must = (label: string, reply: any): void => {
        if (reply?.result === undefined) findings.push(`${who}: ${label} failed: ${JSON.stringify(reply?.error)}`);
      };

      await step("status before anything", "secret.status");
      await step("an empty list", "secret.list");
      await step("refused: the metadata of a name nobody set", "secret.get", { name: NAME });
      await step("refused: a description that holds a piece of the value", "secret.set", { name: NAME, value: FIRST, description: "the secret of the parity run" });
      must("secret.set", await step("set, with a description", "secret.set", { name: NAME, value: FIRST, description: "kept for a comparison" }));
      await step("its metadata", "secret.get", { name: NAME });
      const first = await step("revealed", "secret.get", { name: NAME, reveal: true });
      if (first?.result?.value !== FIRST) findings.push(`${who}: the revealed value is not the one that was set`);
      await step("described again", "secret.describe", { name: NAME, description: "described twice" });
      await step("the list shows it", "secret.list");
      must("secret.set (rotation)", await step("rotated", "secret.set", { name: NAME, value: SECOND }));
      const second = await step("revealed after the rotation", "secret.get", { name: NAME, reveal: true });
      if (second?.result?.value !== SECOND) findings.push(`${who}: the revealed value is not the one it was rotated to`);
      must("secret.set (second name)", await step("a second name", "secret.set", { name: OTHER_NAME, value: OTHER }));
      await step("a short value is stored with a warning", "secret.set", { name: "parity.short", value: "abc" });
      await step("status with three secrets", "secret.status");
      await step("the grants", "secret.grants.list");
      await step("refused: a name that is none", "secret.set", { name: "Not A Name!", value: FIRST });
      await step("refused: an empty value", "secret.set", { name: NAME, value: "" });
      await step("refused: a description that is too long", "secret.describe", { name: NAME, description: "d".repeat(5000) });
      await step("refused: a description for a name nobody set", "secret.describe", { name: "parity.nobody", description: "x" });
      await step("refused: revealing a name nobody set", "secret.get", { name: "parity.nobody", reveal: true });
      await step("refused: deleting a name nobody set", "secret.delete", { name: "parity.nobody" });
      await step("refused: a parameter the method does not have", "secret.get", { name: NAME, nope: 1 });

      // The engine's connection (R-20-32). Nothing else writes run/engine.token here: no engine process runs.
      const tokenFile = join(layout(at).run, "engine.token");
      const engineToken = randomBytes(32).toString("hex");
      writeFileSync(tokenFile, engineToken, { mode: 0o600 });
      const e = await rawConnect(target.address);
      try {
        let m = 0;
        const asEngine = async (label: string, method: string, params: Record<string, unknown>): Promise<any> => {
          const id = ++m;
          sent[method] = (sent[method] ?? 0) + 1;
          byEngine[method] = (byEngine[method] ?? 0) + 1;
          // The witness of who answers: the set of the file as it is now, by the definition both cores share.
          // A call that names no secret is the front door's as before (it refuses the parameters).
          if (method === ENGINE_METHOD && (typeof params.name !== "string" || engineSecretNames(JSON.parse(readFileSync(layout(at).configPath, "utf8"))).has(params.name))) inScope++;
          e.send({ jsonrpc: "2.0", id, method, params });
          const reply = await e.waitFor((f) => f.id === id && f.method === undefined, method, 30_000);
          steps.push([label, normalised(reply, homes)]);
          return reply;
        };
        e.send({ jsonrpc: "2.0", id: "auth", method: "core.auth", params: { token: engineToken, engine: { clientId: "plur1bus-engine", token: engineToken } } });
        const hello = await e.waitFor((f) => f.id === "auth", "the engine's handshake", 30_000);
        must("the engine's handshake", hello);
        const leased = await asEngine("the engine gets a value", ENGINE_METHOD, { name: NAME });
        if (leased?.result?.value !== SECOND) findings.push(`${who}: the engine did not get the value the secret was rotated to`);
        // The engine's configuration, as the scenario changes it: what `engine` holds beside the reference above.
        const configFile = layout(at).configPath;
        const engineBase: Record<string, any> = JSON.parse(readFileSync(configFile, "utf8")).engine ?? {};
        const bare = (block: string): Record<string, unknown> => { const { apiKeyRef: _ref, ...rest } = engineBase[block] ?? {}; return rest; };
        /** The engine's part of `config.json`: the parity configuration with `merging` and `skillMiner` referring to the
         *  names given, and the blocks `extra` adds. */
        const setEngine = async (refs: { merging?: string; skillMiner?: string }, extra: Record<string, unknown> = {}): Promise<void> => {
          const cfg = JSON.parse(readFileSync(configFile, "utf8"));
          cfg.engine = { ...engineBase, merging: { ...bare("merging"), ...(refs.merging ? { apiKeyRef: refs.merging } : {}) },
            skillMiner: { ...bare("skillMiner"), ...(refs.skillMiner ? { apiKeyRef: refs.skillMiner } : {}) }, ...extra };
          writeFileSync(`${configFile}.next`, JSON.stringify(cfg, null, 2));
          renameSync(`${configFile}.next`, configFile);
          // The TypeScript core takes a changed file in after it has prepared the change (module manifests, a stamp it
          // looks at when it is asked): a request that comes at once may meet the configuration of before. The front
          // door reads the file at the request. Both are given the time the core needs, so the legs compare what the
          // answer is once the change is in, which is what the scenario is about.
          await new Promise((resolve) => setTimeout(resolve, CONFIG_SETTLE_MS));
        };
        await asEngine("the engine, refused: a stored name the configuration does not refer to", ENGINE_METHOD, { name: OTHER_NAME });
        await asEngine("the engine, refused: a name nobody set", ENGINE_METHOD, { name: "parity.nobody" });
        await asEngine("the engine, refused: a name that is none", ENGINE_METHOD, { name: "Not A Name!" });
        await asEngine("the engine, refused: no name", ENGINE_METHOD, {});
        await asEngine("the engine, refused: a method that is not the engine's", "secret.status", {});
        await step("refused: the owner is not the engine", ENGINE_METHOD, { name: NAME });
        await step("status after the engine's leases", "secret.status");
        // What the engine may resolve follows the configuration, at every request.
        await setEngine({ merging: NAME, skillMiner: OTHER_NAME });
        const referred = await asEngine("the engine gets a name the configuration now refers to", ENGINE_METHOD, { name: OTHER_NAME });
        if (referred?.result?.value !== OTHER) findings.push(`${who}: the engine did not get the value of a name the configuration refers to`);
        await setEngine({ merging: NAME });
        await asEngine("the engine, refused: the reference was taken out of the configuration", ENGINE_METHOD, { name: OTHER_NAME });
        must("secret.set (the fallback name)", await step("the name an engine block falls back to is stored", "secret.set", { name: FALLBACK_NAME, value: FALLBACK }));
        await asEngine("the engine, refused: a fallback name while its block is not in the configuration", ENGINE_METHOD, { name: FALLBACK_NAME });
        await setEngine({ merging: NAME }, { embedding: { provider: "local-transformers" } });
        const fell = await asEngine("the engine gets a fallback name while its block is in the configuration", ENGINE_METHOD, { name: FALLBACK_NAME });
        if (fell?.result?.value !== FALLBACK) findings.push(`${who}: the engine did not get the value of a name its block falls back to`);
        await setEngine({ merging: NAME });
        await asEngine("the engine, refused: the block left the configuration", ENGINE_METHOD, { name: FALLBACK_NAME });
        // R-20-38: the planned target of an embedding migration that is under way counts as an `engine.embedding` block
        // that is there. The checkpoint is the TypeScript core's (`state/reembed/migration.json`); the scenario writes
        // it as the migration driver does. On the native leg the front door does not know it: the name is outside its
        // set, the request goes on to the TypeScript core, and that one leases the value over the bridge.
        const migration = createStateStore(layout(at).state);
        const checkpoint = (phase: "running" | "aborted") => ({ v: 1 as const, id: "parity-migration", token: "parity-confirmation", planDigest: "parity-digest", createdAt: Date.now(), updatedAt: Date.now(), phase,
          sourceGeneration: "g0", targetGeneration: "g1", target: { provider: "openai-compatible", model: "parity-model", dimensions: 8 },
          counts: { rows: 1, tables: 1, batches: 1, rowsDone: 0, batchesDone: 0 }, throttleMs: 0, abortRequested: false, error: null, remote: { apiKeyEnv: "PARITY_TARGET_KEY", tokensPerRow: 1 } });
        migration.write(checkpoint("running"));
        const planned = await asEngine("the engine gets a default name of the embedding block while a migration to a remote target is under way", ENGINE_METHOD, { name: FALLBACK_NAME });
        if (planned?.result?.value !== FALLBACK) findings.push(`${who}: the engine did not get the value of a default name while a migration to a remote target was under way`);
        await asEngine("the engine, refused: a name the migration's target does not need", ENGINE_METHOD, { name: OTHER_NAME });
        migration.write(checkpoint("aborted"));
        await asEngine("the engine, refused: the migration was aborted", ENGINE_METHOD, { name: FALLBACK_NAME });
        rmSync(migration.path, { force: true });
        await asEngine("the engine still gets the name the configuration refers to", ENGINE_METHOD, { name: NAME });
        await step("status after the refusals", "secret.status");
        // The engine was started again: another token is in the file, and the connection that is still open is the
        // old engine's.
        writeFileSync(tokenFile, randomBytes(32).toString("hex"), { mode: 0o600 });
        await asEngine("the engine, refused: its token is no longer the one in the file", ENGINE_METHOD, { name: NAME });
      } finally { await e.close(); }

      // Persons behind the API (review S1): the same three calls for each, with a role claimed that the store does
      // not have for them. The store's file is written here as another process writes it, before the connections.
      const people = new AdminStore({ path: join(layout(at).state, "admin.sqlite"), ownerId: "local-owner" });
      try {
        for (const person of API_PERSONS) {
          if (person.stored) people.setRole(person.id, person.stored, () => {});
          if (person.disabled) people.setDisabled(person.id, true, "local-owner", Date.now(), () => {});
        }
      } finally { people.close(); }
      const api = { clientId: "harness-api", token: readFileSync(join(layout(at).run, "api-delegation.token"), "utf8").trim() };
      for (const person of API_PERSONS) {
        const delegation = { ...api, principal: { userId: person.id, kind: "person", role: person.claims } };
        const k = await rawConnect(target.address);
        try {
          let m = 0;
          const ask = async (label: string, method: string, params: Record<string, unknown>): Promise<any> => {
            const id = ++m;
            sent[method] = (sent[method] ?? 0) + 1;
            k.send({ jsonrpc: "2.0", id, method, params, api: delegation });
            const reply = await k.waitFor((f) => f.id === id && f.method === undefined, method, 30_000);
            steps.push([`API, ${person.id}: ${label}`, normalised(reply, homes)]);
            return reply;
          };
          k.send({ jsonrpc: "2.0", id: "auth", method: "core.auth", params: { token: target.token, api: delegation } });
          const hello = await k.waitFor((f) => f.id === "auth", "an API handshake", 30_000);
          steps.push([`API, ${person.id}: whom the handshake is for`, normalised({ result: { apiPrincipal: hello?.result?.apiPrincipal ?? null, error: hello?.error?.data ?? null } }, homes)]);
          const owns = person.stored === "owner" && !person.disabled;
          const status = await ask("secret.status", "secret.status", {});
          const set = await ask("secret.set", "secret.set", { name: `parity.${person.id}`, value: owns ? BY_API : REFUSED });
          await ask("secret.describe", "secret.describe", { name: OTHER_NAME, description: `described by ${person.id}` });
          if ((status?.result !== undefined) !== owns || (set?.result !== undefined) !== owns) findings.push(`${who}: ${person.id} (${person.disabled ? "disabled" : person.stored ?? "unknown"}) ${owns ? "was refused" : "was served"} the store`);
        } finally { await k.close(); }
      }

      // A caller inside the core: the export makes its signing key, leases it, and leases every secret once.
      const exported = await call("agent.export", { agentId: "bernd" });
      steps.push(["agent.export, by the kind of its answer", exported?.error !== undefined ? normalised(exported, homes) : { result: Object.keys(exported?.result ?? {}).sort() }]);
      must("agent.export", exported);
      if (VALUES.some((v) => JSON.stringify(exported?.result ?? null).includes(v))) findings.push(`${who}: a value is in the export`);
      await step("the list shows the signing key", "secret.list");

      must("secret.delete", await step("deleted", "secret.delete", { name: NAME }));
      await step("refused: revealing what was deleted", "secret.get", { name: NAME, reveal: true });
      await step("the list after the deletion", "secret.list");
      await step("status at the end", "secret.status");
      await step("the audit stream, as logs.query shows it", "logs.query", { stream: "audit", order: "asc", limit: 200 });
      const last = steps[steps.length - 1]![1] as any;
      if (typeof last?.result?.scanned?.bytes === "number") last.result.scanned.bytes = "<bytes>";
      for (const rec of last?.result?.records ?? []) if (rec?.record) rec.record = auditLine(JSON.stringify(rec.record));
    } finally { await c.close(); }
    seen = await witness(at);
  } finally { await target.stop(); }

  const l = layout(at);
  const auditFile = l.logFile("audit");
  const audit = auditLines(existsSync(auditFile) ? readFileSync(auditFile, "utf8") : "");
  steps.push(["logs/audit.log, line by line", audit.own]);
  findings.push(...witnessFindings(leg, seen, audit.witness).map((f) => `${variant.name}, ${f}`));
  const facts = recordingFacts(recordingLines(recordings));
  findings.push(...recordingFindings(leg, facts, sent, byEngine, inScope).map((f) => `${variant.name}, ${f}`));
  const logs = existsSync(l.logs) ? readdirSync(l.logs).map((name) => [name, readFileSync(join(l.logs, name), "utf8")] as const) : [];
  for (const name of holding(logs)) findings.push(`${who}: a value is in logs/${name}`);
  const reached = NATIVE_SECRET_METHODS.reduce((sum, method) => sum + (facts.read[method] ?? 0), 0);
  notes.push(`${who}: ${audit.own.length} audit lines; bridge ${seen.listening ? `answered (${seen.names?.length ?? 0} names)` : "absent"}; the TypeScript core read ${reached} of ${NATIVE_SECRET_METHODS.reduce((sum, method) => sum + (sent[method] ?? 0), 0)} calls of the six methods and ${facts.read[ENGINE_METHOD] ?? 0} of ${sent[ENGINE_METHOD] ?? 0} of host.secret.get (${byEngine[ENGINE_METHOD] ?? 0} of them the engine's), and was told of ${facts.told} changes (${facts.toldByName} by name); ${logs.length} log files read for values`);
  return steps;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const findings: string[] = [], notes: string[] = [];
  const runs: Array<{ variant: string; leg: string; steps: Step[] }> = [];
  for (const variant of VARIANTS) {
    const mine: Array<{ variant: string; leg: string; steps: Step[] }> = [];
    for (const leg of LEGS) mine.push({ variant: variant.name, leg: leg.name, steps: await scenario(leg, variant, findings, notes) });
    for (const run of mine.slice(1)) findings.push(...differences(mine[0]!.steps, run.steps, `${variant.name}, ${run.leg}`));
    runs.push(...mine);
  }
  console.log(`P4-20 secrets: ${runs[0]!.steps.length} steps on ${LEGS.length} legs (${LEGS.map((l) => l.name).join("; ")}) in ${VARIANTS.length} variants (${VARIANTS.map((v) => v.name).join("; ")}); ${findings.length} findings`);
  for (const f of findings) console.log(`       ${f.length > 700 ? `${f.slice(0, 700)} … (${f.length} characters; whole in --json)` : f}`);
  for (const note of notes) console.log(`  note ${note}`);
  const out = args.includes("--json") ? args[args.indexOf("--json") + 1] : undefined;
  if (out) writeFileSync(out, JSON.stringify({ runs, findings, notes }, null, 2));
  process.exit(findings.length ? 1 : 0);
}
