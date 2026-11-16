// P4-20 flip B1: the front door owns the secret store, and the TypeScript core behind it reaches the store over the
// bridge (`bridge.secret.*` on run/core-bridge.sock, docs/phase4/bridge.md). The `secret.*` methods themselves are
// still answered by the TypeScript core. This runs one scenario three times and compares the answers and the audit
// lines: on a stock TypeScript core, on the front door that owns the store, and on the front door with
// `PLUR1BUS_P4_SECRETS=ts` (the store stays with the TypeScript core; the switch needs the test seam).
//
// The scenario walks the store through the owner's methods (status, list, set, get, describe, rotation, the refusals,
// delete) and through one caller inside the core that takes leases (`agent.export`: the signing key is made, leased and
// released, and every secret is leased once for the export's redaction). What a leg wrote to logs/audit.log must be the
// same lines in the same order, apart from the time and the lease ids.
//
// Who holds the store. On the leg where the front door owns it, the bridge answers a holder of run/core-legacy.token:
// `bridge.secret.list` shows a name that was set through the TypeScript core's `secret.set`, which is only possible if
// that call went over the bridge. The witness opens its connection as the TypeScript core does, with the keyring
// service a TypeScript core derives from the home; a front door that derived another one refuses it. Opening it takes
// the store from the TypeScript core (the front door serves the store on the connection that opened last), so the
// witness comes last. On the other two legs nothing listens at the bridge's address.
//
// Three variants: the keyring (the in-memory stand-in of the test seam; no run reaches a real keyring), the file
// backend (`secrets.fileFallback.enabled`, keyring off), and a home given with a trailing separator (the two processes
// must still derive one keyring service name from it).
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { unitAddress } from "@plur1bus/module-api";
import { layout } from "../../packages/core/src/paths.ts";
import { keyringServiceOf } from "../../packages/core/src/secrets/runtime.ts";
import { tempDir } from "../../packages/core/test/helpers/temp-dir.ts";
import { settled } from "./p4-10-parity.ts";
import { differences, type Leg, type Step } from "./p4-12-native.ts";
import { rawConnect } from "./raw-client.ts";
import { startProcessTarget } from "./target.ts";

export type { Leg, Step };

/** Which process holds the store on a leg. */
export type Holder = "typescript" | "front-door";
export interface SecretLeg extends Leg { holder: Holder }
export const LEGS: readonly SecretLeg[] = [
  { name: "typescript", impl: "ts", holder: "typescript" },
  { name: "front door, the store is the front door's", impl: "rust", holder: "front-door" },
  { name: "front door, the store stays with the TypeScript core (PLUR1BUS_P4_SECRETS=ts)", impl: "rust", env: { PLUR1BUS_P4_SECRETS: "ts" }, holder: "typescript" },
];

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
export const VALUES: readonly string[] = [FIRST, SECOND, OTHER];
const NAME = "parity.secrets";
const OTHER_NAME = "parity.other";
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
      if (!w.names.includes(OTHER_NAME)) out.push(`${leg.name}: the bridge's list has no ${OTHER_NAME}; the TypeScript core's secret.set did not go through the front door's store`);
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
  const target = await startProcessTarget(leg.impl, { home, env: { ...(leg.env ?? {}), ...variant.env }, stderr: "ignore", ...(variant.config ? { config: variant.config } : {}) });
  const steps: Step[] = [];
  let seen: Witness = { listening: false };
  try {
    await settled(target);
    const homes = [...new Set([realpathSync(at), at])];
    const c = await rawConnect(target.address);
    let n = 0;
    const call = async (method: string, params: unknown): Promise<any> => {
      const id = ++n;
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
  const logs = existsSync(l.logs) ? readdirSync(l.logs).map((name) => [name, readFileSync(join(l.logs, name), "utf8")] as const) : [];
  for (const name of holding(logs)) findings.push(`${who}: a value is in logs/${name}`);
  notes.push(`${who}: ${audit.own.length} audit lines; bridge ${seen.listening ? `answered (${seen.names?.length ?? 0} names)` : "absent"}; ${logs.length} log files read for values`);
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
