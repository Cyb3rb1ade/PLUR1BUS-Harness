// P4-12 flip A1: the front door answers `breakglass.notices` and `identity.principals` itself for the owner connection.
// This runs one scenario three times and compares the answers: on a stock TypeScript core, on the front door (native),
// and on the front door with `PLUR1BUS_P4_IDENTITY=ts` (the same methods through the relay). In the scenario the
// writes go to the TypeScript core (`identity.human.create`, `identity.link`, `identity.unlink` are relayed) and the
// reads are the methods under test, so on the front door leg one process writes the store and the other reads it.
//
// Ids differ between runs (UUIDv7): they are replaced by placeholders before the comparison, and the v2 principal each
// leg answers is checked against `user:v2:` plus the SHA-256 of that leg's own id.
//
// The second half is the refusal: the script disables the local owner in `state/admin.sqlite` (a third process, as an
// administrator's other session would through the legacy core), and every guarded call is then unauthenticated. On
// the native leg the front door writes the audit event of the methods it serves and the TypeScript core the one of
// the relayed call in between, so two writers extend one hash chain in turn. Afterwards the audit lines are compared
// byte for byte between the legs (the time aside), and the chain is verified with the TypeScript verifier.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAuditChain } from "../../packages/core/src/audit/chain.ts";
import { AdminStore } from "../../packages/core/src/identity/admin-store.ts";
import { layout } from "../../packages/core/src/paths.ts";
import { tempDir } from "../../packages/core/test/helpers/temp-dir.ts";
import { settled } from "./p4-10-parity.ts";
import { rawConnect } from "./raw-client.ts";
import { startProcessTarget, type CoreImpl } from "./target.ts";

export interface Leg { name: string; impl: CoreImpl; env?: Record<string, string> }
export const LEGS: readonly Leg[] = [
  { name: "typescript", impl: "ts" },
  { name: "front door, native", impl: "rust" },
  { name: "front door, relayed (PLUR1BUS_P4_IDENTITY=ts)", impl: "rust", env: { PLUR1BUS_P4_IDENTITY: "ts" } },
];

export type Step = [label: string, answer: unknown];

const CALLER = { channel: "cli", accountId: "parity", userId: "owner" };
const v2 = (id: string): string => `user:v2:${createHash("sha256").update(id, "utf8").digest("hex")}`;

/** An answer without what differs between two runs: the request id, the human's and the link's id, their timestamps. */
export function normalised(reply: any, ids: Record<string, string>): unknown {
  const swap = (v: unknown): unknown => {
    if (typeof v === "string") { for (const [id, name] of Object.entries(ids)) if (v === id) return name; return v; }
    if (Array.isArray(v)) return v.map(swap);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, /At$/.test(k) && typeof x === "number" ? "<time>" : swap(x)]));
    return v;
  };
  const { id: _id, jsonrpc: _v, ...rest } = reply ?? {};
  return swap(rest);
}

/** The lines of `logs/audit.log` the guard wrote for a refusal, as text, with the time replaced: what two legs must
 *  agree on byte for byte (member order, actor, detail). */
export function refusalLines(text: string): string[] {
  return text.split("\n").filter((l) => /"action":"rbac\.(?:unauthenticated|denied)"/.test(l)).map((l) => l.replace(/^\{"at":\d+,/, '{"at":"<time>",'));
}

/** The scenario on one leg. `findings` collects what is wrong on this leg alone. */
export async function scenario(leg: Leg, findings: string[]): Promise<Step[]> {
  const home = tempDir("p1b-native-");
  const target = await startProcessTarget(leg.impl, { home, ...(leg.env ? { env: leg.env } : {}), stderr: "ignore" });
  const steps: Step[] = [];
  try {
    await settled(target);
    const c = await rawConnect(target.address);
    let n = 0;
    const call = async (method: string, params: unknown): Promise<any> => {
      const id = ++n;
      c.send({ jsonrpc: "2.0", id, method, params });
      return c.waitFor((f) => f.id === id && f.method === undefined, method, 15_000);
    };
    try {
      await call("core.auth", { token: target.token });
      const ids: Record<string, string> = {};
      const step = async (label: string, method: string, params: unknown): Promise<any> => {
        const reply = await call(method, params);
        steps.push([label, normalised(reply, ids)]);
        return reply;
      };
      await step("no notices yet", "breakglass.notices", {});
      await step("the owner has no human record", "identity.principals", {});
      await step("an unknown human", "identity.principals", { humanId: "nobody" });
      await step("parameters the schema refuses", "identity.principals", { humanId: 7 });
      await step("a parameter the method does not have", "breakglass.notices", { all: true });
      const human = (await call("identity.human.create", { caller: CALLER, displayName: "Ada" })).result;
      if (typeof human?.id !== "string") { findings.push(`${leg.name}: identity.human.create did not answer a human`); return steps; }
      ids[human.id] = "<human>";
      ids[v2(human.id)] = "<v2 of the human>";
      const unlinked = await step("a human without links", "identity.principals", { humanId: human.id });
      const own = unlinked.result?.principals;
      if (!Array.isArray(own) || own.length !== 1 || own[0] !== v2(human.id)) findings.push(`${leg.name}: the v2 principal is not user:v2:sha256(id): ${JSON.stringify(own)}`);
      const link = (await call("identity.link", { caller: CALLER, humanId: human.id, identity: { channel: "telegram", accountId: "bot1", userId: "4242" } })).result;
      if (typeof link?.id !== "string") { findings.push(`${leg.name}: identity.link did not answer a link`); return steps; }
      const linked = await step("with one link", "identity.principals", { humanId: human.id });
      if (linked.result?.principals?.[1] !== link.v1Principal) findings.push(`${leg.name}: the linked principal is not the link's: ${JSON.stringify(linked.result)}`);
      await call("identity.unlink", { caller: CALLER, linkId: link.id });
      await step("after the link was removed", "identity.principals", { humanId: human.id });
      await step("still no notices", "breakglass.notices", {});

      // The local owner disabled by another process: nobody is authenticated on this connection any more.
      const people = new AdminStore({ path: join(layout(home).state, "admin.sqlite"), ownerId: "local-owner" });
      try {
        people.setRole("second", "owner", () => {});
        people.setDisabled("local-owner", true, "second", Date.now(), () => {});
        await step("disabled: a native method", "breakglass.notices", {});
        await step("disabled: a relayed method", "user.list", {});
        await step("disabled: the other native method", "identity.principals", { humanId: human.id });
        people.setDisabled("local-owner", false, "second", Date.now(), () => {});
        await step("enabled again", "breakglass.notices", {});
      } finally { people.close(); }
    } finally { await c.close(); }
  } finally { await target.stop(); }
  // What the refusals left behind: three audit lines in call order, and a chain the TypeScript verifier accepts.
  const logs = layout(home).logs;
  const audit = join(logs, "audit.log");
  steps.push(["the audit lines of the refusals", refusalLines(existsSync(audit) ? readFileSync(audit, "utf8") : "")]);
  const verdict = createAuditChain({ dir: logs }).verify();
  steps.push(["the audit chain", { ok: verdict.ok, findings: verdict.findings.length, anchor: verdict.anchor.status }]);
  if (!verdict.ok) findings.push(`${leg.name}: the audit chain does not verify: ${JSON.stringify(verdict.findings).slice(0, 400)}`);
  return steps;
}

/** JSON text with every object's members in key order: two answers are the same whatever order their members were
 *  written in (the front door writes an error's members in key order, module-api in the order it builds them). */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

/** The steps of `other` that differ from `reference`, as text. */
export function differences(reference: readonly Step[], other: readonly Step[], name: string): string[] {
  const out: string[] = [];
  if (reference.length !== other.length) out.push(`${name}: ${other.length} steps, expected ${reference.length}`);
  reference.forEach(([label, answer], i) => {
    const got = other[i];
    if (!got) return;
    const [a, b] = [canonical(answer), canonical(got[1])];
    if (got[0] !== label || a !== b) out.push(`${name}, "${label}": expected ${a}, got ${b}`);
  });
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const findings: string[] = [];
  const runs: Array<{ leg: string; steps: Step[] }> = [];
  for (const leg of LEGS) runs.push({ leg: leg.name, steps: await scenario(leg, findings) });
  for (const run of runs.slice(1)) findings.push(...differences(runs[0]!.steps, run.steps, run.leg));
  console.log(`P4-12 native methods: ${runs[0]!.steps.length} steps on ${runs.length} legs (${runs.map((r) => r.leg).join("; ")}); ${findings.length} findings`);
  for (const f of findings) console.log(`       ${f}`);
  const out = args.includes("--json") ? args[args.indexOf("--json") + 1] : undefined;
  if (out) writeFileSync(out, JSON.stringify({ runs, findings }, null, 2));
  process.exit(findings.length ? 1 : 0);
}
