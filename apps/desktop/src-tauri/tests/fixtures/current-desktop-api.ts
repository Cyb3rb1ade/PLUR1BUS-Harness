// Disposable actual API/Core attach boundary. The supervisor inspection port is the only package-store fixture.
import { createApiServer } from "../../../../../packages/api/src/server.ts";
import type { CoreRpc } from "../../../../../packages/api/src/core-rpc.ts";
import { DesktopAttach } from "../../../../../packages/core/src/identity/desktop-attach.ts";
import { DeviceStore } from "../../../../../packages/remote-access/src/device-store.ts";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { AccountStore } from "../../../../../packages/api/src/account-store.ts";
import { FakeClock, systemClock } from "../../../../../packages/api/src/clock.ts";
import { hashPassword } from "../../../../../packages/api/src/password.ts";
import { TotpService, totpCodeAt } from "../../../../../packages/api/src/totp.ts";

const home = process.argv[2]!;
const person = { userId: "desktop-fixture-owner", kind: "person", role: "owner", disabled: false, version: 1 };
const audit = { append() {} };
const devices = new DeviceStore({ file: join(home, "devices.json"), clock: Date.now, audit, securePath() {} });
const attach = new DesktopAttach({ file: join(home, "desktop-attach.db"), devices, now: Date.now, audit, securePath() {}, personVersion: () => 1 });
const core: CoreRpc = {
  async call() { throw new Error("unsupported fixture method"); },
  async serviceCall(method, params) {
    const input = params as Record<string, string>;
    let result: unknown;
    if (method === "admin.api.person.resolve") result = { person };
    else if (method === "admin.api.desktop.redeem") result = attach.redeem(input.code!, input.kind!, input.name!, input.publicKey!);
    else if (method === "admin.api.desktop.token") result = attach.authenticate(input.token!);
    else if (method === "admin.api.desktop.resolve") result = attach.resolve(input.deviceId!);
    else throw new Error("unsupported fixture service");
    return result as never;
  },
  async callAs(method, params, principal, endpoint) {
    if (method !== "ext.inspect" || endpoint !== "supervisor" || principal.kind !== "person" || principal.userId !== person.userId) throw new Error("unexpected fixture inspection");
    if (!(params as { source: { upload: string } }).source.upload) throw new Error("upload required");
    return { inspectionId: "actual-api-inspection" } as never;
  },
};
const mfa = process.argv[4]?.startsWith("mfa"), productionRate = process.argv[4] === "mfa-production";
const clock = new FakeClock(Date.now()), factorClock = productionRate ? systemClock : clock;
const accounts = mfa ? new AccountStore({ path: ":memory:", resolve: async () => person as import("../../../../../packages/api/src/account-store.ts").CorePerson }) : undefined;
let factorSecret = "", backupCode = "";
if (accounts) {
  await accounts.createPending(person.userId, "native-fixture", await hashPassword("fixture-native-mfa-password"));
  await accounts.activate(person.userId);
  const factors = new TotpService({ store: accounts.totp, clock:factorClock, issuer: "fixture" });
  const pending = await factors.begin(person.userId, "native-fixture"); factorSecret = pending.secret;
  const confirmed = await factors.confirm(person.userId, totpCodeAt(factorSecret, factorClock.now()));
  if (!confirmed.ok) throw new Error("fixture factor failed");
  backupCode = confirmed.backupCodes[0]!;
  if (!productionRate) clock.advance(30_000);
}
const api = createApiServer({ home, core, ownerToken: randomBytes(32).toString("base64url"),
  ...accounts ? { accounts, users: accounts, totp: accounts.totp, clock:factorClock, requireSecondFactor: "always" as const } : {},
  ...(process.argv[3] ? {port:Number(process.argv[3])} : {}),
  webRoot: resolve(import.meta.dirname, "../../../../../packages/web/dist"),
  rateClasses: { read: {capacity:1000,refillPerSec:1000}, ...productionRate?{}:{auth: {capacity:1000,refillPerSec:1000}},
    write: {capacity:1000,refillPerSec:1000}, expensive: {capacity:1000,refillPerSec:1000}, upload: {capacity:1000,refillPerSec:1000} },
});
const listening = await api.listen();
const grant = attach.issue(person.userId, "desktop", process.argv[4] !== "default", process.argv[4] !== "default");
process.stdout.write(`${JSON.stringify({ origin: listening.url, code: grant.code, grant:{schema:"device.pair/1",...grant} })}\n`);
const input = createInterface({ input: process.stdin });
let browserCookie = "", operations = Promise.resolve();
input.on("line", line => { operations = operations.then(async () => {
  if (line.startsWith("approve ") || line.startsWith("decline ")) {
    if (!accounts) throw new Error("fixture MFA unavailable");
    const post = (path: string, body: object, headers: Record<string, string> = {}) => fetch(listening.url + path,
      { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    if (!browserCookie) {
      const password = await post("/api/v1/session", { username: "native-fixture", password: "fixture-native-mfa-password" });
      const challenge = await password.json() as { challenge: string };
      const signed = await post("/api/v1/session/totp", { challenge: challenge.challenge,
        code: productionRate ? backupCode : totpCodeAt(factorSecret, clock.now()) });
      if (!signed.ok) throw new Error("fixture browser factor refused");
      browserCookie = signed.headers.get("set-cookie")!.split(";", 1)[0]!;
    }
    const csrf = await (await fetch(listening.url + "/api/v1/csrf", { headers: { cookie: browserCookie } })).json() as { token: string };
    const [decision, userCode] = line.split(" ");
    const result = await post("/api/v1/desktop/step-up/decision", { userCode, decision }, { cookie: browserCookie, "x-csrf-token": csrf.token });
    if (!result.ok) throw new Error("fixture approval refused");
  }
  if (line === "demote") person.role = "member";
  else if (line === "expire") clock.advance(300_001);
  else if (line === "revoke") for (const device of devices.list()) devices.revoke(device.id, person.userId);
  process.stdout.write("ok\n");
}).catch(error => { process.stderr.write(error instanceof Error ? error.message + "\n" : "fixture command failed\n"); process.exitCode = 1; input.close(); }); });
input.on("close", () => { void operations.finally(() => api.close().finally(() => { attach.close(); accounts?.close(); })); });
