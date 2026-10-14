// Audit d16: packaging manifests, container build script, healthcheck and .dockerignore parity.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const read = (p: string): string => readFileSync(resolve(ROOT, p), "utf8");

test("nfpm: every packaged file has an explicit mode and root owner (no umask-dependent permissions)", () => {
  const entries = read("packaging/nfpm/nfpm.yaml.in").split(/^ {2}- src: /m).slice(1);
  assert.ok(entries.length >= 10);
  for (const e of entries) {
    const src = e.split("\n")[0];
    assert.match(e, /mode: 0[0-7]{3}/, `no mode for ${src}`);
    assert.match(e, /owner: root/, `no owner for ${src}`);
    assert.match(e, /group: root/, `no group for ${src}`);
  }
  assert.match(read("packaging/nfpm/nfpm.yaml.in"), /src: bin\/plur1bus\n {4}dst: \/usr\/bin\/plur1bus\n {4}file_info:\n {6}mode: 0755/);
});

test(".dockerignore (root) keeps git bundles and archives out of the context like the harness ignore file", () => {
  const ignore = read(".dockerignore").split(/\r?\n/).map((l) => l.trim());
  for (const must of [".git-bundles", "**/*.tar", "**/*.tar.gz"]) assert.ok(ignore.includes(must), `lacks ${must}`);
});

test("build.sh: the rsync context excludes everything the dockerignore treats as secret", () => {
  const sh = read("containers/build.sh");
  for (const must of [".netrc", "*.log", ".claude", ".superpowers"]) assert.ok(sh.includes(`--exclude ${must}`) || sh.includes(`--exclude '${must}'`), `rsync lacks ${must}`);
});

function fakeBin(dir: string, name: string, body: string): void {
  writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(dir, name), 0o755);
}

test("build.sh: an unknown runtime fails with 64 before any context is copied", () => {
  const dir = mkdtempSync(join(tmpdir(), "d16-build-"));
  try {
    const tmp = join(dir, "tmp");
    mkdirSync(tmp);
    fakeBin(dir, "git", 'echo 0123456789012345678901234567890123456789');
    fakeBin(dir, "rsync", `echo rsync >> "${dir}/calls"`);
    const r = spawnSync("/bin/sh", [join(ROOT, "containers/build.sh"), "bogus"], { env: { PATH: `${dir}:/usr/bin:/bin`, TMPDIR: tmp }, encoding: "utf8" });
    assert.equal(r.status, 64, r.stderr);
    assert.equal(existsSync(join(dir, "calls")), false, "rsync ran before the runtime was validated");
    assert.deepEqual(readdirSync(tmp), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("build.sh: SIGTERM removes the temporary context and the script does not continue", async () => {
  const dir = mkdtempSync(join(tmpdir(), "d16-build-"));
  try {
    const tmp = join(dir, "tmp");
    mkdirSync(tmp);
    fakeBin(dir, "git", 'echo 0123456789012345678901234567890123456789');
    fakeBin(dir, "rsync", "exit 0");
    fakeBin(dir, "docker", `touch "${dir}/started"; sleep 1; echo finished >> "${dir}/after"`);
    const { spawn } = await import("node:child_process");
    const child = spawn("/bin/sh", [join(ROOT, "containers/build.sh"), "docker"], { env: { PATH: `${dir}:/usr/bin:/bin`, TMPDIR: tmp } });
    const code = new Promise<number | null>((res) => child.on("exit", (c) => res(c)));
    for (let i = 0; i < 100 && !existsSync(join(dir, "started")); i++) await new Promise((r) => setTimeout(r, 50));
    child.kill("SIGTERM");
    const status = await code;
    assert.notEqual(status, 0, "build.sh exited 0 after being terminated");
    assert.deepEqual(readdirSync(tmp), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function health(statusJson: string): { status: number | null; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), "d16-hc-"));
  try {
    fakeBin(dir, "fake-plur1bus", `cat <<'JSON'\n${statusJson}\nJSON`);
    const r = spawnSync(process.execPath, [join(ROOT, "containers/harness/healthcheck.mjs")], { env: { ...process.env, PLUR1BUS_HEALTHCHECK_BIN: join(dir, "fake-plur1bus") }, encoding: "utf8" });
    return { status: r.status, stderr: r.stderr };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("healthcheck: ready core is healthy; both copies are identical", () => {
  assert.equal(health('{"children":[{"role":"core","process":{"state":"ready"}}]}').status, 0);
  assert.equal(read("containers/harness/healthcheck.mjs"), read("deploy/container/healthcheck.mjs"));
});

test("healthcheck: non-object or malformed status documents give one 'unhealthy:' line, not a stack trace", () => {
  for (const doc of ["null", "[]", '"x"', '{"children":"nope"}', '{"children":[null]}']) {
    const r = health(doc);
    assert.equal(r.status, 1, doc);
    assert.match(r.stderr.trim(), /^unhealthy: [^\n]+$/, `${doc}: ${r.stderr}`);
  }
});
