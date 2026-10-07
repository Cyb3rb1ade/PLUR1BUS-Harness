import type { CreateGrantInput } from "../../src/grants/store.ts";
import { openPermissionStores, type PermissionStores } from "../../src/grants/open.ts";
import { staticKeySource } from "../../src/approvals/keys.ts";
import type { Call, CallFlags, Context } from "../../src/policy/index.ts";
import { decide } from "../../src/policy/index.ts";
import { FakeClock, KEY, dbFile } from "../approvals/helpers.ts";
import { abs } from "../helpers/abs.ts";

export { DAY, FakeClock, HOUR, KEY, MIN, NOW, dbFile, raw } from "../approvals/helpers.ts";

export async function open(path: string = dbFile(), o: { clock?: FakeClock; key?: Uint8Array } = {}): Promise<PermissionStores & { clock: FakeClock; path: string }> {
  const clock = o.clock ?? new FakeClock();
  const s = await openPermissionStores({ path, keys: staticKeySource(o.key ?? KEY), clock });
  return Object.assign(s, { clock, path });
}

export const alwaysCap = (o: Partial<CreateGrantInput> = {}): CreateGrantInput => ({
  capability: "fs.read", person: "christian", agent: "bernd", scope: "always", match: { kind: "capability" }, createdBy: "christian", surface: 3, ...o,
});

export const flags = (f: Partial<CallFlags> = {}): CallFlags => ({ outsideRoots: false, denyListHit: false, ...f });
export const call = (o: Partial<Omit<Call, "flags">> & { flags?: Partial<CallFlags> } = {}): Call => {
  const { flags: f, ...rest } = o;
  return { capability: "fs.read", tool: "fs.read", flags: flags(f), targets: [abs("/work/proj/a.txt")], access: "read", actionHash: "h1", ...rest };
};
export const ctx = (o: Partial<Context> = {}): Context => ({ principal: { person: "christian" }, subject: { kind: "agent", agentId: "bernd" }, surface: 3, sessionId: "s1", taskId: "t1", ...o });

export function decideWith(s: PermissionStores & { clock: FakeClock }, c: Call, x: Context) {
  return decide(c, x, { grants: s.grants, clock: s.clock });
}
