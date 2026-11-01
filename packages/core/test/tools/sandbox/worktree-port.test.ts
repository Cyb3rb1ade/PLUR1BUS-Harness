import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CollabStore } from "../../../src/collab/store.ts";
import { provisionedWorktreePort } from "../../../src/external-agents/provisioner.ts";
import { validateAcpMount } from "../../../src/tools/sandbox/acp-worktree.ts";
import { sandboxPolicy } from "../../../src/tools/sandbox/ports.ts";
import { tempDir } from "../../helpers/temp-dir.ts";

test("the provisioner port supplies a live opaque grant through the ordinary process policy", async () => {
  const dir = tempDir("worktree-process-port-"), home = join(dir, "home"), state = join(home, "state"), repo = join(dir, "repo");
  mkdirSync(state, { recursive: true }); mkdirSync(repo);
  execFileSync("git", ["-C", repo, "init", "-b", "main"], { stdio: "pipe" });
  execFileSync("git", ["-C", repo, "-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "--allow-empty", "-m", "init"], { stdio: "pipe" });
  const store = new CollabStore({ path: join(state, "collab.sqlite") });
  try {
    const project = store.createProject({ name: "Coding", owner: "owner" });
    const port = provisionedWorktreePort(store, () => repo, state);
    assert.equal(port.mount?.("coder", project.id, ""), undefined, "a workspace fallback grants no writable opt-in");
    store.setRepo(project.id, { repoPath: repo, baseBranch: "main" });
    const path = port.root("coder", project.id, "")!;
    const grant = port.mount?.("coder", project.id, "");
    assert.ok(grant, "the trusted provisioner port supplies the DB-bound grant");
    const options = { home, roots: [{ id: "coder", path }], acpWorktree: grant, deny: [], principal: "owner", audit: { append() {} } as never };
    const policy = sandboxPolicy(options, { program: "/usr/bin/true", args: [], cwd: path, env: {} });
    assert.equal(policy.acpWorktree, process.platform === "linux" ? grant : undefined, "only Linux process policies carry the opt-in");
    assert.equal((await validateAcpMount(grant, policy.writeRoots.map(r => r.path))).path, path);
    await assert.rejects(validateAcpMount(JSON.parse(JSON.stringify(grant)), [path]), /forged/);
    await assert.rejects(validateAcpMount(grant, [path, repo]), /mismatched/);
    store.markWorktreeRemoved(project.id, null);
    await assert.rejects(validateAcpMount(grant, [path]), /forged or mismatched/);
    const legacy = store.insertWorktree({ projectId: project.id, rootId: project.id, cardId: null, branch: "legacy", path, baseSha: "legacy-base" });
    assert.equal(legacy.gitDir, null);
    assert.equal(port.root("coder", project.id, ""), path, "a legacy checkout remains available for file tools");
    assert.equal(port.mount?.("coder", project.id, ""), undefined, "legacy rows grant no writable process opt-in");
  } finally { store.close(); }
});
