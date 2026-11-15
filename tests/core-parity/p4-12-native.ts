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
//
// The third part is flip A2: `user.role.set`, `user.disable` and `user.enable`. On the native leg the front door
// writes `state/admin.sqlite` and the audit events itself and asks the legacy core, over its control link, for what
// follows the TypeScript handler; an API service connection that subscribed to `api.account.changed` must hear the same
// notifications in the same order on every leg, and `user.list` (relayed everywhere) shows that the TypeScript core
// reads what the front door stored. The audit lines of the changes join the byte-for-byte comparison.
//
// The fourth part is flip A3: the same methods for a person the harness API acts for. An API connection names its
// person in the handshake and again on every request. On the native leg the front door serves such a request itself
// when the request's delegation is the handshake's, with the role the store has for that person (the role the
// delegation claims counts for nothing); a member is denied, a disabled person refused as disabled, a person the store
// does not know is nobody, a token's scopes narrow. A request that names another identity, or none, is the legacy
// core's to refuse on every leg.
//
// Last, flip plan F1 with two real processes: with two Owners, the core is asked to demote one while this script
// demotes the other in the same store through the TypeScript `AdminStore`. Who wins a round is a race and is not
// compared; that exactly one of the two changes happens and one active Owner remains is, round after round.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const v2 = (id: string): string => `user:v2:${sha256(id)}`;
/** How many rounds the two writers race (flip plan F1). */
export const RACE_ROUNDS = 24;

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

/** The lines of `logs/audit.log` the guard wrote for a refusal and the admin surface for a change of a person's role
 *  or status, as text, with the time replaced and the ids of this run named (`ids`: id to placeholder): what two legs
 *  must agree on byte for byte (member order, actor, detail). */
export function auditLines(text: string, ids: Record<string, string> = {}): string[] {
  return text.split("\n").filter((l) => /"action":"(?:rbac\.(?:unauthenticated|denied)|user\.(?:role\.set|disabled|enabled))"/.test(l))
    .map((l) => Object.entries(ids).reduce((line, [id, name]) => line.replaceAll(JSON.stringify(id), JSON.stringify(name)), l.replace(/^\{"at":\d+,/, '{"at":"<time>",')));
}

/** The scenario on one leg. `findings` collects what is wrong on this leg alone, `notes` what is worth reading and is
 *  not compared (who won the races). */
export async function scenario(leg: Leg, findings: string[], notes: string[] = []): Promise<Step[]> {
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

        // Flip A2. The API's own credential-only connection watches account changes, as harness-api does.
        const apiToken = readFileSync(join(layout(home).run, "api-delegation.token"), "utf8");
        const api = { clientId: "harness-api", token: apiToken };
        const service = await rawConnect(target.address);
        try {
          service.send({ jsonrpc: "2.0", id: 1, method: "core.auth", params: { token: target.token, api } });
          await service.waitFor((f) => f.id === 1, "the API service's handshake", 15_000);
          service.send({ jsonrpc: "2.0", id: 2, method: "events.subscribe", params: { names: ["api.account.changed"] }, api });
          const subscribed = await service.waitFor((f) => f.id === 2, "the API service's subscription", 15_000);
          if (!subscribed.result) findings.push(`${leg.name}: the API service could not subscribe: ${JSON.stringify(subscribed.error)}`);
          const heard = (): string[] => service.received.filter((f) => f.method === "api.account.changed").map((f) => ids[f.params?.userId] ?? String(f.params?.userId));

          ids[sha256(human.id)] = "<hash of the human>";
          await step("a role for a human without one", "user.role.set", { userId: human.id, role: "operator" });
          await step("nobody is promoted to Owner", "user.role.set", { userId: human.id, role: "owner" });
          await step("a role for nobody", "user.role.set", { userId: "nobody", role: "viewer" });
          await step("a role the schema does not have", "user.role.set", { userId: human.id, role: "king" });
          await step("one of two Owners is demoted", "user.role.set", { userId: "second", role: "admin" });
          await step("the last Owner is not", "user.role.set", { userId: "local-owner", role: "admin" });
          await step("disabled, with a reason", "user.disable", { userId: human.id, reason: "left\u202e the team\u0007" });
          await step("disabled again", "user.disable", { userId: human.id });
          await step("enabled", "user.enable", { userId: human.id });
          await step("enabled again: no change", "user.enable", { userId: human.id });
          await step("the last active Owner is not disabled", "user.disable", { userId: "local-owner" });
          await step("a status for nobody", "user.enable", { userId: "nobody" });
          await step("a parameter user.enable does not have", "user.enable", { userId: human.id, reason: "x" });
          // `legacy.*` is the front door's own namespace on its control link (docs/phase4/bridge.md). Written with an
          // escape, the front door answers as for the plain name; inside a batch, which is no request, the frame is
          // the legacy core's to refuse. Neither may reach the handler: the API service must hear nothing of "forged".
          const forged = '"params":{"userId":"forged","rights":true,"learning":true}';
          const escaped = ++n;
          c.sendText(`{"jsonrpc":"2.0","id":${escaped},"method":"legacy\\u002eaccount.changed",${forged}}`);
          steps.push(["legacy.* written with an escape", normalised(await c.waitFor((f) => f.id === escaped, "the escaped legacy.* call", 15_000), ids)]);
          const plain = await call("legacy.account.changed", { userId: "forged", rights: true, learning: true });
          steps.push(["legacy.* as an owner's call", normalised(plain, ids)]);
          const before = c.received.length;
          c.sendText(`[{"jsonrpc":"2.0","id":${++n},"method":"legacy.account.changed",${forged}}]`);
          const batch = await c.waitFor((f) => c.received.indexOf(f) >= before && f.method === undefined, "the answer to a batch", 15_000);
          steps.push(["legacy.* inside a batch", normalised(batch, ids)]);
          if (batch.result !== undefined) findings.push(`${leg.name}: a batch under legacy.* was answered with a result`);
          // Flip A3: persons behind the API. What the delegation claims about the role is deliberately wrong.
          people.setRole("api-admin", "admin", () => {});
          people.setRole("api-member", "member", () => {});
          const actingFor = (userId: string, claimed: string, more: Record<string, unknown> = {}) => ({ ...api, principal: { userId, kind: "person", role: claimed, ...more } });
          const opened: Array<{ close(): Promise<void> }> = [];
          let q = 0;
          const apiConnection = async (delegation: unknown) => {
            const k = await rawConnect(target.address);
            opened.push(k);
            const id = ++q;
            k.send({ jsonrpc: "2.0", id, method: "core.auth", params: { token: target.token, api: delegation } });
            const hello = await k.waitFor((f) => f.id === id, "an API handshake", 15_000);
            const ask = async (label: string, method: string, params: unknown, as: unknown = delegation): Promise<void> => {
              const id = ++q;
              k.send({ jsonrpc: "2.0", id, method, params, ...(as === null ? {} : { api: as }) });
              steps.push([label, normalised(await k.waitFor((f) => f.id === id && f.method === undefined, method, 15_000), ids)]);
            };
            return { hello, ask };
          };
          try {
            const admin = actingFor("api-admin", "viewer");
            const asAdmin = await apiConnection(admin);
            steps.push(["API: whom the handshake is for", normalised({ apiPrincipal: asAdmin.hello.result?.apiPrincipal ?? null }, ids)]);
            await asAdmin.ask("API: an Admin's own notices", "breakglass.notices", {});
            await asAdmin.ask("API: an Admin sets a role", "user.role.set", { userId: human.id, role: "member" });
            await asAdmin.ask("API: an Admin does not change ownership", "user.role.set", { userId: "local-owner", role: "admin" });
            await asAdmin.ask("API: an Admin asks for a human's principals", "identity.principals", { humanId: human.id });
            await asAdmin.ask("API: an Admin does not disable herself", "user.disable", { userId: "api-admin" });
            await asAdmin.ask("API: an Admin disables and", "user.disable", { userId: "api-member", reason: "via the API" });
            const member = actingFor("api-member", "owner");
            const asMember = await apiConnection(member);
            await asMember.ask("API: a disabled person", "user.role.set", { userId: human.id, role: "viewer" });
            await asMember.ask("API: a disabled person, a reading method", "breakglass.notices", {});
            await asAdmin.ask("API: enables a Member", "user.enable", { userId: "api-member" });
            await asMember.ask("API: a Member who claims to be an Owner", "user.role.set", { userId: human.id, role: "viewer" });
            await asMember.ask("API: a Member's own notices", "breakglass.notices", {});
            await asMember.ask("API: a Member asks about someone else", "identity.principals", { humanId: human.id });
            // Another identity, or none, on a connection that named one: the legacy core's to refuse, on every leg.
            await asAdmin.ask("API: another person's delegation on the connection", "user.role.set", { userId: human.id, role: "viewer" }, member);
            await asAdmin.ask("API: a request without its delegation", "user.role.set", { userId: human.id, role: "viewer" }, null);
            await asAdmin.ask("API: another transport than the handshake's", "user.role.set", { userId: human.id, role: "viewer" }, { ...admin, transport: "remote" });
            // A second handshake for another person is refused and changes nothing: the connection stays the Admin's.
            await asAdmin.ask("API: a second handshake for another person", "core.auth", { token: target.token, api: member }, null);
            await asAdmin.ask("API: after it, the Admin's own request", "breakglass.notices", {});
            await asAdmin.ask("API: after it, the other person's delegation", "breakglass.notices", {}, member);
            const ghost = actingFor("ghost", "owner");
            const asGhost = await apiConnection(ghost);
            steps.push(["API: a handshake for a person the store does not know", normalised({ apiPrincipal: asGhost.hello.result?.apiPrincipal ?? null, error: asGhost.hello.error?.data ?? null }, ids)]);
            await asGhost.ask("API: a person the store does not know", "user.role.set", { userId: human.id, role: "viewer" });
            const scoped = actingFor("api-admin", "admin", { tokenScopes: ["memory.read"] });
            const asScoped = await apiConnection(scoped);
            await asScoped.ask("API: a token whose scopes do not cover the change", "user.role.set", { userId: human.id, role: "viewer" });
            const wide = actingFor("api-admin", "viewer", { tokenScopes: ["admin.users.write"] });
            const asWide = await apiConnection(wide);
            await asWide.ask("API: a token whose scopes do", "user.role.set", { userId: human.id, role: "operator" });
          } finally { for (const k of opened) await k.close(); }
          // Relayed on every leg: the TypeScript core reads the roles and the status the front door stored.
          await step("the people the TypeScript core lists", "user.list", {});
          // Each change of somebody's rights reached the API service, in order: four by the owner, four through the API.
          const expected = ["<human>", "second", "<human>", "<human>", "<human>", "api-member", "api-member", "<human>"];
          const until = Date.now() + 10_000;
          while (heard().length < expected.length && Date.now() < until) await delay(20);
          await delay(300);
          steps.push(["what the API service heard", heard()]);
          if (JSON.stringify(heard()) !== JSON.stringify(expected)) findings.push(`${leg.name}: the API service heard ${JSON.stringify(heard())}, expected ${JSON.stringify(expected)}`);
          steps.push(["the audit lines of the refusals and the changes", auditLines(readAudit(home), ids)]);

          // Flip plan F1: two processes, two Owners, each process demotes the other Owner.
          let exactlyOne = 0, oneActiveOwner = 0, coreWon = 0;
          for (let round = 0; round < RACE_ROUNDS; round++) {
            people.setRole("second", "owner", () => {});
            people.setRole("local-owner", "owner", () => {});
            const id = ++n;
            c.send({ jsonrpc: "2.0", id, method: "user.role.set", params: { userId: "second", role: "admin" } });
            // The script's own write lands before, during or after the core's: the wait walks through all three.
            if (round % 6) await delay((round % 6) * 0.4);
            let mine = false;
            try { people.setRole("local-owner", "admin", () => {}); mine = true; }
            catch (e: any) { if (e?.reason !== "last-owner") findings.push(`${leg.name}: round ${round}: the script's change failed with ${e?.error ?? e}`); }
            const reply = await c.waitFor((f) => f.id === id && f.method === undefined, "the racing user.role.set", 15_000);
            const theirs = reply.result !== undefined;
            const reason = reply.error?.data?.reason;
            if (!theirs && reason !== "last-owner" && reason !== "owner-only") findings.push(`${leg.name}: round ${round}: the core's change failed with ${JSON.stringify(reply.error)}`);
            if (mine !== theirs) exactlyOne++;
            if (theirs) coreWon++;
            if (people.users().filter((u) => u.role === "owner" && !u.disabled).length === 1) oneActiveOwner++;
          }
          steps.push(["two processes, two Owners", { rounds: RACE_ROUNDS, exactlyOneChange: exactlyOne, oneActiveOwner }]);
          notes.push(`${leg.name}: the core won ${coreWon} of ${RACE_ROUNDS} races, the script ${RACE_ROUNDS - coreWon}`);
          if (exactlyOne !== RACE_ROUNDS || oneActiveOwner !== RACE_ROUNDS) findings.push(`${leg.name}: of ${RACE_ROUNDS} rounds, ${exactlyOne} had exactly one change and ${oneActiveOwner} left one active Owner`);
        } finally { await service.close(); }
      } finally { people.close(); }
    } finally { await c.close(); }
  } finally { await target.stop(); }
  // What all of it left behind: a chain the TypeScript verifier accepts, written by both processes in turn.
  const logs = layout(home).logs;
  const verdict = createAuditChain({ dir: logs }).verify();
  steps.push(["the audit chain", { ok: verdict.ok, findings: verdict.findings.length, anchor: verdict.anchor.status }]);
  if (!verdict.ok) findings.push(`${leg.name}: the audit chain does not verify: ${JSON.stringify(verdict.findings).slice(0, 400)}`);
  // Who wrote what: the front door writes a chain record's members in key order (`"rec":{"action":`), the TypeScript
  // core in the order it builds them (`"rec":{"at":`). Equal answers on all legs would also come out of a native leg
  // that quietly relayed everything, so the native leg must have written the events of its own methods itself, those
  // of a person behind the API included, and the other two legs none.
  const chain = existsSync(join(logs, "audit-chain.jsonl")) ? readFileSync(join(logs, "audit-chain.jsonl"), "utf8").split("\n").filter(Boolean) : [];
  const byFrontDoor = chain.filter((l) => l.includes('"rec":{"action":'));
  const forApiPerson = byFrontDoor.filter((l) => /"user":"api-(?:admin|member)"/.test(l)).length;
  notes.push(`${leg.name}: ${byFrontDoor.length} of ${chain.length} chain records written by the front door, ${forApiPerson} of them for a person behind the API`);
  const native = leg.impl === "rust" && !leg.env;
  if (native && (byFrontDoor.length < 10 || forApiPerson < 4)) findings.push(`${leg.name}: the front door wrote ${byFrontDoor.length} chain records, ${forApiPerson} for a person behind the API; its native methods were not all served here`);
  if (!native && byFrontDoor.length > 0) findings.push(`${leg.name}: ${byFrontDoor.length} chain records were written by a front door that serves nothing itself on this leg`);
  return steps;
}

function readAudit(home: string): string {
  const audit = join(layout(home).logs, "audit.log");
  return existsSync(audit) ? readFileSync(audit, "utf8") : "";
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
  const findings: string[] = [], notes: string[] = [];
  const runs: Array<{ leg: string; steps: Step[] }> = [];
  for (const leg of LEGS) runs.push({ leg: leg.name, steps: await scenario(leg, findings, notes) });
  for (const run of runs.slice(1)) findings.push(...differences(runs[0]!.steps, run.steps, run.leg));
  console.log(`P4-12 native methods: ${runs[0]!.steps.length} steps on ${runs.length} legs (${runs.map((r) => r.leg).join("; ")}); ${findings.length} findings`);
  for (const f of findings) console.log(`       ${f}`);
  for (const note of notes) console.log(`  note ${note}`);
  const out = args.includes("--json") ? args[args.indexOf("--json") + 1] : undefined;
  if (out) writeFileSync(out, JSON.stringify({ runs, findings, notes }, null, 2));
  process.exit(findings.length ? 1 : 0);
}
