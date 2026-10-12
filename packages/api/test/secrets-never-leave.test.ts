// Step 13 of the server hardening sweep: one account lives through every secret the API handles, then every route is called with those
// secrets in every place a request can carry them. The password, the TOTP secret, the backup codes, the login challenge, the session ids
// and the token secret may appear only in the one answer that issues them (and the session id only in that login's Set-Cookie). They
// must not be in any other response (body or header), in any log line, in any audit event, nor be passed on to the core.
// The owner token is a secret too: it only ever goes in. Time is the FakeClock; the TOTP secret is whatever the server generates, so no
// documentation example is used; the marker strings carry no token shape.
import assert from "node:assert/strict";
import test from "node:test";
import { COOKIE_NAME, ROUTES } from "../src/routes.ts";
import { totpCodeAt } from "../src/totp.ts";
import { addUser, csrfToken, FIXTURE_PASSWORD, jsonHeaders, loginAs, OWNER_TOKEN, raw, start, type Harness, type Res } from "./helpers.ts";

const wide = { auth: { capacity: 100_000, refillPerSec: 10_000 }, read: { capacity: 100_000, refillPerSec: 10_000 }, write: { capacity: 100_000, refillPerSec: 10_000 }, totp: { capacity: 100_000, refillPerSec: 10_000 }, stream: { capacity: 100_000, refillPerSec: 10_000 } };

type Seen = { label: string; res: Res; allow: readonly string[]; cookieOk: readonly string[] };
const SID = (cookie: string): string => cookie.slice(cookie.indexOf("=") + 1);

/** Every shape a value could be written in without anyone meaning to: as is, in either case, a backup code without its dash, URL-encoded, JSON-escaped, base64. */
function shapes(value: string): string[] {
  return [...new Set([value, value.toLowerCase(), value.toUpperCase(), value.replaceAll("-", ""), value.replaceAll("-", "").toUpperCase(), encodeURIComponent(value), JSON.stringify(value).slice(1, -1), Buffer.from(value).toString("base64"), Buffer.from(value).toString("base64url")])];
}

test("secrets never leave the server: from creating the second factor to every route called with every secret, nothing but the issuing answer shows one", async () => {
  const h = await start({ rateClasses: wide }); const seen: Seen[] = [];
  const secrets = new Map<string, string>();
  const note = (label: string, res: Res, allow: readonly string[] = [], cookieOk: readonly string[] = []): Res => { seen.push({ label, res, allow, cookieOk }); return res; };
  const call = async (label: string, o: Parameters<typeof raw>[1], allow: readonly string[] = [], cookieOk: readonly string[] = []): Promise<Res> => note(label, await raw(h, o), allow, cookieOk);
  const post = async (label: string, cookie: string, path: string, body: unknown, allow: readonly string[] = []): Promise<Res> =>
    call(label, { method: "POST", path, headers: { cookie, "x-csrf-token": await csrfToken(h, cookie), ...jsonHeaders() }, body: JSON.stringify(body) }, allow);
  try {
    await addUser(h, { id: "mia", username: "mia", role: "admin" });
    secrets.set("password", FIXTURE_PASSWORD); secrets.set("owner token", OWNER_TOKEN);

    // 1. password login, then the second factor is switched on
    const first = await loginAs(h, "mia"); note("login", first.res, [], ["session1"]); assert.equal(first.res.status, 200); secrets.set("session1", SID(first.cookie));
    const setup = await post("totp.setup", first.cookie, "/api/v1/me/totp/setup", undefined, ["totp secret"]); assert.equal(setup.status, 200);
    const totpSecret = setup.json.secret as string; secrets.set("totp secret", totpSecret);
    const confirm = await post("totp.confirm", first.cookie, "/api/v1/me/totp/confirm", { code: totpCodeAt(totpSecret, h.clock.now()) }, ["backup codes"]); assert.equal(confirm.status, 200);
    const backup = confirm.json.backupCodes as string[]; assert.equal(backup.length, 10); backup.forEach((c, i) => secrets.set(`backup code ${i}`, c));
    assert.equal(h.clock.now() > 0, true);

    // 2. a new login with the second step; the challenge is issued once and spent once
    h.clock.advance(60_000);
    const pw = await call("login step 1", { method: "POST", path: "/api/v1/session", headers: jsonHeaders(), body: JSON.stringify({ username: "mia", password: FIXTURE_PASSWORD }) }, ["challenge"]);
    assert.equal(pw.json.schema, "session.challenge/1"); const challenge = pw.json.challenge as string; secrets.set("challenge", challenge);
    const step2 = await call("login step 2", { method: "POST", path: "/api/v1/session/totp", headers: jsonHeaders(), body: JSON.stringify({ challenge, code: totpCodeAt(totpSecret, h.clock.now()) }) }, [], ["session2"]);
    assert.equal(step2.status, 200); const cookie = (step2.headers["set-cookie"]?.[0] ?? "").split(";", 1)[0]!; secrets.set("session2", SID(cookie));

    // 3. a backup-code login, an owner-token login, a token
    const viaBackup = await call("login step 1 (backup)", { method: "POST", path: "/api/v1/session", headers: jsonHeaders(), body: JSON.stringify({ username: "mia", password: FIXTURE_PASSWORD }) }, ["challenge2"]);
    secrets.set("challenge2", viaBackup.json.challenge as string);
    const bk = await call("login step 2 (backup)", { method: "POST", path: "/api/v1/session/totp", headers: jsonHeaders(), body: JSON.stringify({ challenge: viaBackup.json.challenge, code: backup[0] }) }, [], ["session3"]);
    assert.equal(bk.status, 200); secrets.set("session3", SID((bk.headers["set-cookie"]?.[0] ?? "").split(";", 1)[0]!));
    const owner = await call("owner login", { method: "POST", path: "/api/v1/session", headers: jsonHeaders(), body: JSON.stringify({ token: OWNER_TOKEN }) }, [], ["session4"]);
    assert.equal(owner.status, 200); const ownerCookie = (owner.headers["set-cookie"]?.[0] ?? "").split(";", 1)[0]!; secrets.set("session4", SID(ownerCookie));
    const tok = await post("tokens.create", cookie, "/api/v1/tokens", { name: "redact-probe-alpha", scopes: ["my.*", "agent.*"] }, ["api token"]); assert.equal(tok.status, 201);
    const apiToken = tok.json.token as string; secrets.set("api token", apiToken); secrets.set("api token secret", apiToken.slice(apiToken.lastIndexOf("_") + 1));
    const bearer = { authorization: `Bearer ${apiToken}` };

    // 4. wrong secrets: the refusals say nothing of what was sent
    await call("wrong password", { method: "POST", path: "/api/v1/session", headers: jsonHeaders(), body: JSON.stringify({ username: "mia", password: "redact-probe-beta-password" }) });
    await call("wrong owner token", { method: "POST", path: "/api/v1/session", headers: jsonHeaders(), body: JSON.stringify({ token: `redact-probe-gamma-${"0".repeat(32)}` }) });
    await call("wrong totp code", { method: "POST", path: "/api/v1/session/totp", headers: jsonHeaders(), body: JSON.stringify({ challenge: "redact-probe-delta", code: "000000" }) });
    await call("malformed json with secrets", { method: "POST", path: "/api/v1/session", headers: jsonHeaders(), body: `{"password":"${FIXTURE_PASSWORD}","token":"${OWNER_TOKEN}",` });
    await call("secrets in path, query, origin and cookie", { path: `/api/v1/${totpSecret}/${apiToken}?token=${OWNER_TOKEN}&code=${totpSecret}&password=${FIXTURE_PASSWORD}`, headers: { cookie: `${COOKIE_NAME}=${secrets.get("session2")}x; other=${apiToken}`, origin: `https://${totpSecret.toLowerCase()}.example`, authorization: `Bearer ${OWNER_TOKEN}` } });
    await call("bearer with a damaged token", { path: "/api/v1/whoami", headers: { authorization: `Bearer ${apiToken.slice(0, -2)}zz` } });
    await call("bearer with the owner token", { path: "/api/v1/whoami", headers: { authorization: `Bearer ${OWNER_TOKEN}` } });

    // 5. every route, five ways, with every secret in the body
    const everything = { token: OWNER_TOKEN, username: "mia", password: FIXTURE_PASSWORD, challenge, code: totpSecret, name: apiToken, scopes: [backup[1]], ttlDays: 1, id: secrets.get("session2"), targetUserId: "mia", reason: `${backup[2]} is the reason`, ttlMinutes: 1 };
    const ends = new Set(["session.delete", "sessions.revoke-all"]);
    for (const spec of ROUTES) {
      const send = async (label: string, headers: Record<string, string>, body: unknown): Promise<Res> =>
        call(`${spec.id} ${label}`, { method: spec.method, path: spec.path, headers: { ...headers, ...(body !== undefined ? jsonHeaders() : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      const bodies: unknown[] = spec.requestBody ? [{}, everything] : [undefined];
      for (const body of bodies) {
        await send("anonymous", {}, body);
        await send("bearer", bearer, body);
        await send("bad cookie", { cookie: `${COOKIE_NAME}=${secrets.get("session2")!.slice(0, -1)}!` }, body);
        if (!ends.has(spec.id)) await send("owner cookie", { cookie: ownerCookie, ...(spec.csrf ? { "x-csrf-token": await csrfToken(h, ownerCookie) } : {}) }, body);
        if (!ends.has(spec.id) && spec.id !== "session.create" && spec.id !== "session.totp") await send("user cookie", { cookie, ...(spec.csrf ? { "x-csrf-token": await csrfToken(h, cookie) } : {}) }, body);
      }
    }
    await call("session.delete", { method: "DELETE", path: "/api/v1/session", headers: { cookie: ownerCookie, "x-csrf-token": await csrfToken(h, ownerCookie) } });
    await call("sessions.revoke-all", { method: "DELETE", path: "/api/v1/sessions", headers: { cookie, "x-csrf-token": await csrfToken(h, cookie) } });
    await call("after the end: the old cookie", { path: "/api/v1/whoami", headers: { cookie } });

    // 6. what the server wrote down and what it passed on
    const leaks: string[] = [];
    const scan = (where: string, text: string, allowed: readonly string[]): void => {
      for (const [name, value] of secrets) {
        if (allowed.includes(name) || (name.startsWith("backup code") && allowed.includes("backup codes")) || (name === "api token secret" && allowed.includes("api token"))) continue;
        for (const s of shapes(value)) if (s.length >= 10 && text.includes(s)) { leaks.push(`${name} in ${where}`); break; }
      }
    };
    for (const { label, res, allow, cookieOk } of seen) {
      scan(`the body of ${label}`, res.text, allow);
      for (const [k, v] of Object.entries(res.headers)) { if (k === "set-cookie") { const text = ([] as string[]).concat(v ?? []).join("\n"); scan(`Set-Cookie of ${label}`, text, [...allow, ...cookieOk]); } else scan(`header ${k} of ${label}`, ([] as string[]).concat(v ?? []).join("\n"), allow); }
    }
    for (const line of h.logs) scan(`the log line ${line.slice(0, 80)}`, line, []);
    for (const ev of h.audit.events) scan(`the audit event ${ev.action}`, JSON.stringify(ev), []);
    for (const c of h.core.calls) scan(`the call to the core ${c.method}`, JSON.stringify(c), []);
    assert.deepEqual([...new Set(leaks)], [], `a secret left the server: ${[...new Set(leaks)].join("; ")}`);

    // the check has teeth: the answers that issue a secret are flagged when nothing is allowed
    for (const [what, text, name] of [["totp.setup", setup.text, "totp secret"], ["totp.confirm", confirm.text, "backup code 0"], ["tokens.create", tok.text, "api token"], ["the challenge", pw.text, "challenge"], ["the login cookie", String(first.res.headers["set-cookie"]), "session1"]] as const) {
      const before = leaks.length; scan(what, text, []); assert.ok(leaks.slice(before).some((l) => l.startsWith(name)), `the scan did not see ${name} in ${what}`);
    }

    // the sweep did what it says: every route was reached, a good number of answers were real, and the session ids were all issued
    assert.ok(seen.length > ROUTES.length * 6, `${seen.length} exchanges`);
    for (const spec of ROUTES) assert.ok(seen.some((s) => s.label.startsWith(`${spec.id} `)), `${spec.id} was not called`);
    assert.ok(h.logs.length > 0 && h.audit.events.length > 0, "nothing was logged or audited, so the check proves nothing");
    assert.ok(seen.filter((s) => s.res.status === 200).length > 20);
  } finally { await h.close(); }
});
