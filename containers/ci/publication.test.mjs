import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./publication.sh", import.meta.url));
const release = "ghcr.io/cyb3rb1ade/plur1bus-harness-distribution";
const staging = release + "-staging";

function run(t, ref, states, mode = "verify", event = "push") {
  const dir = mkdtempSync(join(tmpdir(), "distribution-registry-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const write = (name, body) => writeFileSync(join(dir, name), body, { mode: 0o700 });
  write("responses", states.join("\n") + "\n");
  write("gh", `#!/bin/sh
echo "$*" >> "$TMPCASE/queries"
state=$(head -n1 "$TMPCASE/responses")
sed '1d' "$TMPCASE/responses" > "$TMPCASE/rest"
mv "$TMPCASE/rest" "$TMPCASE/responses"
case "$state" in
private|public|internal) printf 'HTTP/2.0 200 OK\\r\\ncontent-type: application/json\\r\\n\\r\\n{"visibility":"%s","name":"plur1bus-harness-distribution-staging","owner":{"login":"Cyb3rb1ade"}}' "$state";;
wrong-owner) printf 'HTTP/2.0 200 OK\\n\\n{"visibility":"private","name":"plur1bus-harness-distribution-staging","owner":{"login":"someone-else"}}';;
wrong-package) printf 'HTTP/2.0 200 OK\\n\\n{"visibility":"private","name":"another","owner":{"login":"Cyb3rb1ade"}}';;
broken) printf 'HTTP/2.0 200 OK\\n\\nnull';;
*) printf 'HTTP/2.0 %s Error\\n\\n{}' "$state"; exit 1;;
esac
`);
  write("docker", '#!/bin/sh\necho "$*" >> "$TMPCASE/docker-log"\ncat >> "$TMPCASE/docker-log"\n');
  write("sleep", "#!/bin/sh\nexit 0\n");
  const r = spawnSync("bash", [script, mode], {
    cwd: dir, encoding: "utf8", env: { ...process.env, PATH: dir + ":" + process.env.PATH,
      TMPCASE: dir, GITHUB_REF: ref, GITHUB_EVENT_NAME: event },
  });
  const log = name => { try { return readFileSync(join(dir, name), "utf8"); } catch { return ""; } };
  return { status: r.status, image: r.stdout.trim(), docker: log("docker-log"), queries: log("queries") };
}

test("main prepares only the staging image, with a scratch bootstrap and a second privacy check", t => {
  const r = run(t, "refs/heads/main", ["404", "404", "private"], "prepare");
  assert.equal(r.status, 0);
  assert.equal(r.image, staging);
  assert.match(r.docker, /--tag ghcr\.io\/cyb3rb1ade\/plur1bus-harness-distribution-staging:bootstrap -\nFROM scratch\nLABEL /);
  assert.doesNotMatch(r.docker, /COPY|ADD|--secret|--build-context/);
  assert.equal(r.queries.trim().split("\n").length, 3);
  for (const query of r.queries.trim().split("\n")) assert.ok(query.endsWith("/user/packages/container/plur1bus-harness-distribution-staging"));
});
test("main requires positive private evidence before every payload push", t => {
  for (const state of ["404", "public", "internal", "403", "500", "broken", "wrong-owner", "wrong-package"]) {
    const r = run(t, "refs/heads/main", [state]);
    assert.notEqual(r.status, 0);
    assert.equal(r.docker, "");
  }
  assert.equal(run(t, "refs/heads/main", ["private"]).image, staging);
  for (const state of ["public", "403", "500", "broken", "wrong-owner", "wrong-package"]) {
    const r = run(t, "refs/heads/main", [state], "prepare");
    assert.notEqual(r.status, 0);
    assert.equal(r.docker, "");
  }
  assert.notEqual(run(t, "refs/heads/main", ["404", "public"], "prepare").status, 0);
  const invisible = run(t, "refs/heads/main", Array(6).fill("404"), "prepare");
  assert.notEqual(invisible.status, 0);
  assert.equal(invisible.queries.trim().split("\n").length, 6);
});
test("version tags retain their release destination and never bootstrap it", t => {
  for (const state of ["private", "public", "404"]) {
    const r = run(t, "refs/tags/v1.2.3", [state], "prepare");
    assert.equal(r.status, 0);
    assert.equal(r.image, release);
    assert.equal(r.docker, "");
    assert.ok(r.queries.trim().endsWith("/plur1bus-harness-distribution"));
  }
  assert.notEqual(run(t, "refs/tags/v1", ["403"]).status, 0);
});
test("PRs, dispatch, other branches and other tags cannot publish", t => {
  for (const [ref, event] of [["refs/heads/main", "workflow_dispatch"], ["refs/heads/main", "pull_request"], ["refs/heads/other", "push"], ["refs/tags/test", "push"]]) {
    const r = run(t, ref, [], "prepare", event);
    assert.notEqual(r.status, 0);
    assert.equal(r.queries + r.docker, "");
  }
});
