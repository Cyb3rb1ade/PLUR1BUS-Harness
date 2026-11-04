// Generated references must expose both credential classifications, including maps and array items.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("the generated key reference exposes sensitivity for secrets, endpoint URLs and array items", () => {
  const lines = readFileSync(new URL("../../../docs/reference/config-keys.md", import.meta.url), "utf8").split("\n");
  const cells = (line: string): string[] =>
    line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim().replaceAll("`", ""));
  const header = lines.find((line) => line.startsWith("| Key |"));
  assert.ok(header, "a generated key table is required");
  const columns = cells(header);
  const sensitive = columns.indexOf("x-sensitive");
  const urlCredentials = columns.indexOf("x-url-credentials");
  assert.ok(sensitive >= 0 && urlCredentials >= 0, "both schema annotations must be visible");
  for (const [key, wantSensitive, wantUrl] of [
    ["channels.discord.tokenSecret", "true", "false"],
    ["voice.providers.elevenlabs.baseUrl", "false", "true"],
    ["auth.openai.federated.args[]", "true", "false"],
    ["auth.openai.federated.environment.*", "true", "false"],
    ["privacy.localEndpoints[]", "false", "true"],
    ["modelProfiles.*.params.maxTokens", "false", "false"],
    ["engine.embedding.apiKey.id", "true", "false"],
    ["engine.embedding.routes[].provider.apiKeyRef", "true", "false"],
    ["engine.schicht15.headers.*", "true", "false"],
    ["engine.reminders.webhookUrl", "true", "false"],
    ["engine.reranker.baseUrl", "false", "true"],
  ]) {
    const line = lines.find((line) => line.startsWith(`| \`${key}\` |`));
    assert.ok(line, `${key}: missing key reference`);
    const row = cells(line);
    assert.equal(row[sensitive], wantSensitive, key);
    assert.equal(row[urlCredentials], wantUrl, key);
  }
});
