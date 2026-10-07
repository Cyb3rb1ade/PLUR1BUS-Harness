// A6: the harness never registers a host cron. Static half: nothing in the scheduler can reach a process, a shell or
// an OS scheduler. (The runtime half, that its only external effects are the ledger and the logs, is in dreams-acceptance.)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const dir = path.join(import.meta.dirname, "..", "src", "dreams");

describe("A6 no host cron", () => {
  it("the dreams sources import nothing that can spawn a process or touch a network", () => {
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    assert.ok(files.length >= 5);
    for (const f of files) {
      const src = readFileSync(path.join(dir, f), "utf8");
      for (const imp of src.matchAll(/from\s+["']([^"']+)["']/g)) {
        assert.ok(!/^(node:)?(child_process|net|http|https|dgram|worker_threads|cluster)$/.test(imp[1]!), `${f} imports ${imp[1]}`);
      }
      assert.ok(!/\b(crontab|schtasks|launchctl|systemctl|cron\s+add|agentTurn)\b/i.test(src.replace(/\/\/.*$/gm, "")), `${f} names a host scheduler`);
      assert.ok(!/(?<![.\w])(spawn|exec|execFile|execSync|spawnSync|fork)\s*\(/.test(src), `${f} starts a process`);
    }
  });
});
