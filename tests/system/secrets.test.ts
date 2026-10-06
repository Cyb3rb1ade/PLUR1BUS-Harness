// M2 secret store over the real core and CLI (the keyring is switched off by the test seam, so no real keychain is
// reachable; the encrypted-file fallback serves). A marker value must appear in nothing a user or an operator can read
// except the one explicit `secret get --reveal`.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BIN, home, startCore, stopCore, type RunningCore } from "./helpers.ts";

const MARKER = "p1b-SYS-SECRET-MARKER-4c8e1a7b";
const SEAM = { PLUR1BUS_ALLOW_TEST_INTERNALS: "1", PLUR1BUS_SECRETS_KEYRING: "off" };

interface Run { exit: number | null; stdout: string; stderr: string }
const outputs: string[] = []; // every CLI byte except the explicit reveals

function secret(h: string, args: string[], o: { input?: string; reveal?: boolean; json?: boolean } = {}): Run & { doc: any } {
  const r = spawnSync(BIN, [...(o.json === false ? [] : ["--json"]), "--home", h, "secret", ...args], {
    encoding: "utf8", timeout: 30_000, input: o.input ?? "", env: { ...process.env, ...SEAM },
  });
  const run = { exit: r.status, stdout: r.stdout, stderr: r.stderr };
  if (!o.reveal) outputs.push(run.stdout, run.stderr);
  let doc: any = null;
  try { doc = JSON.parse(run.stdout); } catch { /* human output */ }
  return { ...run, doc };
}

function sweep(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => { const p = join(dir, n); const st = statSync(p); return st.isDirectory() ? sweep(p) : st.isFile() ? [p] : []; });
}

function homeWith(fallback: boolean): string {
  const h = home();
  mkdirSync(h, { recursive: true });
  writeFileSync(join(h, "config.json"), JSON.stringify({ schemaVersion: 1, secrets: { fileFallback: { enabled: fallback } } }));
  return h;
}

describe("secret store end to end", () => {
  it("without the fallback and without a keyring there is no backend, and says how to fix it", async () => {
    const h = homeWith(false);
    const core = await startCore(h, SEAM);
    try {
      const st = secret(h, ["status"]);
      assert.equal(st.exit, 0); assert.equal(st.doc.schema, "secret.status/1");
      assert.deepEqual([st.doc.backend, st.doc.degraded, st.doc.file.enabled], ["none", true, false]);
      const set = secret(h, ["set", "k"], { input: MARKER });
      assert.equal(set.exit, 2); assert.equal(set.doc.schema, "error/1"); assert.equal(set.doc.error, "E_NOT_AVAILABLE"); assert.equal(set.doc.reason, "no-backend");
      assert.match(set.doc.message, /secrets\.fileFallback\.enabled/);
      const human = secret(h, ["status"], { json: false });
      assert.match(human.stdout, /backend: none/); assert.match(human.stdout, /fix: /);
    } finally { await stopCore(core); }
  });

  it("round trip, persistence across a core restart, tamper fails closed, and the marker never leaks", async () => {
    const h = homeWith(true);
    let core: RunningCore = await startCore(h, SEAM);
    const stderrs: string[] = [];
    try {
      assert.deepEqual(((s) => [s.doc.backend, s.doc.degraded, s.doc.keyring.available, s.doc.file.enabled, s.doc.count])(secret(h, ["status"])), ["file", true, false, true, 0]);

      // set reads the value from stdin; one trailing newline is removed
      const set = secret(h, ["set", "openai.key"], { input: `${MARKER}\n` });
      assert.equal(set.exit, 0, set.stderr); assert.equal(set.doc.schema, "secret.set/1");
      assert.deepEqual([set.doc.name, set.doc.backend], ["openai.key", "file"]);
      assert.equal("value" in set.doc, false);

      const ls = secret(h, ["ls"]);
      assert.equal(ls.doc.schema, "secret.ls/1"); assert.deepEqual(ls.doc.secrets.map((s: any) => s.name), ["openai.key"]);
      assert.match(secret(h, ["ls"], { json: false }).stdout, /openai\.key/);

      // get without --reveal: metadata only, in both output modes
      const meta = secret(h, ["get", "openai.key"]);
      assert.equal(meta.doc.schema, "secret.get/1"); assert.equal(meta.doc.secret.name, "openai.key"); assert.equal("value" in meta.doc, false);
      const metaHuman = secret(h, ["get", "openai.key"], { json: false });
      assert.match(metaHuman.stdout, /--reveal/);

      // the one place the value comes out
      const rev = secret(h, ["get", "openai.key", "--reveal"], { reveal: true });
      assert.equal(rev.doc.value, MARKER);
      assert.equal(secret(h, ["get", "openai.key", "--reveal"], { reveal: true, json: false }).stdout, `${MARKER}\n`);

      // a value in an argument is refused without echo (and nothing is stored)
      const arg = secret(h, ["set", "other", MARKER]);
      assert.equal(arg.exit, 2); assert.equal(arg.doc.reason, "value-in-argument");
      assert.equal(secret(h, ["get", "other"]).exit, 1);

      // private files (POSIX)
      if (process.platform !== "win32") for (const f of ["store.json", "store.key"]) assert.equal(statSync(join(h, "state", "secrets", f)).mode & 0o777, 0o600, f);
      const store = readFileSync(join(h, "state", "secrets", "store.json"), "utf8");
      assert.ok(!store.includes(MARKER));

      // the value survives a core restart
      stderrs.push(core.stderr()); await stopCore(core); core = await startCore(h, SEAM);
      assert.equal(secret(h, ["get", "openai.key", "--reveal"], { reveal: true }).doc.value, MARKER);

      // errors: absent name, bad name, rm needs --yes
      const missing = secret(h, ["get", "nope"]);
      assert.deepEqual([missing.exit, missing.doc.error], [1, "E_NOT_FOUND"]);
      const badName = secret(h, ["set", "bad name"], { input: MARKER });
      assert.deepEqual([badName.exit, badName.doc.error], [1, "E_INVALID_PARAMS"]); assert.match(badName.doc.detail, /^\/name /);
      assert.equal(secret(h, ["rm", "openai.key"]).exit, 2);

      // tamper: flip one ciphertext byte on disk, restart; the value is refused, not guessed
      stderrs.push(core.stderr()); await stopCore(core);
      const doc = JSON.parse(store); const ct = Buffer.from(doc.entries["openai.key"].ct, "base64"); ct[0] = ct[0]! ^ 1; doc.entries["openai.key"].ct = ct.toString("base64");
      const good = store; writeFileSync(join(h, "state", "secrets", "store.json"), JSON.stringify(doc));
      core = await startCore(h, SEAM);
      const bad = secret(h, ["get", "openai.key", "--reveal"], { reveal: true });
      assert.deepEqual([bad.exit, bad.doc.error, bad.doc.reason], [1, "E_STORAGE", "corrupt"]);
      assert.ok(!bad.stdout.includes(MARKER) && !bad.stderr.includes(MARKER));
      outputs.push(bad.stdout, bad.stderr);

      // restore and delete
      stderrs.push(core.stderr()); await stopCore(core);
      writeFileSync(join(h, "state", "secrets", "store.json"), good);
      core = await startCore(h, SEAM);
      const rm = secret(h, ["rm", "openai.key", "--yes"]);
      assert.equal(rm.exit, 0); assert.equal(rm.doc.schema, "secret.rm/1"); assert.equal(rm.doc.removed, true);
      assert.equal(secret(h, ["get", "openai.key"]).doc.error, "E_NOT_FOUND");
      assert.equal(secret(h, ["ls"]).doc.secrets.length, 0);

      // the audit log has a line per access and no value
      const audit = readFileSync(join(h, "logs", "audit.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      const actions = audit.map((a) => a.action);
      for (const a of ["secret.set", "secret.get", "secret.reveal", "secret.list", "secret.delete"]) assert.ok(actions.includes(a), `${a} in ${actions.join(",")}`);
      assert.ok(audit.every((a) => typeof a.at === "number" && a.actor?.user && "target" in a));
      if (process.platform !== "win32") assert.equal(statSync(join(h, "logs", "audit.log")).mode & 0o777, 0o600);
      stderrs.push(core.stderr());
    } finally { await stopCore(core); }

    // redaction: no CLI output (reveals aside), no core stderr, nothing under the home contains the marker
    for (const o of [...outputs, ...stderrs]) assert.ok(!o.includes(MARKER), "marker leaked into an output");
    for (const f of sweep(h)) assert.ok(!readFileSync(f).includes(MARKER), `marker leaked into ${f}`);
  });
});
