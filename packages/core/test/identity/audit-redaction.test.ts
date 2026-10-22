import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createAuditWriter } from "../../src/identity/audit.ts";
import { tempDir } from "../helpers/temp-dir.ts";

describe("identity audit writer", () => {
  it("redacts secrets inside `detail` before the line is appended, and keeps the five-key shape", () => {
    const file = path.join(tempDir("p1b-identity-audit-"), "logs", "audit.log");
    const w = createAuditWriter({ file, securePath: () => {}, clock: () => 7 });
    const bot = ["AAHd", "qTcvCH1vGWJxfSeofSAs0K5PALDsaw"].join(""); const pass = ["hunter", "2-but-longer"].join("");
    w({ action: "identity.pair.confirm", target: "u1", detail: { channel: "telegram", password: pass, url: `https://api.telegram.org/bot123456789:${bot}/getMe` } });
    w({ action: "identity.link", target: "u2", detail: { channel: "cli", count: 1 } });
    const text = readFileSync(file, "utf8");
    assert.ok(!text.includes(bot) && !text.includes(pass), text);
    const lines = text.trimEnd().split("\n").map((l) => JSON.parse(l) as Record<string, any>);
    assert.deepEqual(Object.keys(lines[0]!), ["at", "actor", "action", "target", "detail"]);
    assert.equal(lines[0]!.detail.password, "[REDACTED:key]");
    assert.equal(lines[0]!.detail.channel, "telegram");
    assert.deepEqual(lines[1]!.detail, { channel: "cli", count: 1 });
  });
});
