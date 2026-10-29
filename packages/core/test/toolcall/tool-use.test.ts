// Tool-use policy regressions: detection evidence, provider suppression and first-round loop prevention.
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectToolNeed, toolChoiceForTurn } from "../../src/toolcall/tool-use.ts";

test("need detection uses confident routable categories and keeps ordinary chat automatic", () => {
  assert.deepEqual(detectToolNeed({ message: "Tell me a joke." }), { needed: false, reasons: [] });
  const input = {
    message: "Research this",
    tasks: [{ categories: { "web.research": 1 }, confidence: 0.85 }],
    categoriesWithTools: ["web.research"],
  };
  assert.deepEqual(detectToolNeed(input), { needed: true, reasons: ["category"] });
  assert.equal(detectToolNeed({
    ...input,
    tasks: [{ categories: { "web.research": 1 }, confidence: 0.4 }],
  }).needed, false);
  assert.equal(detectToolNeed({
    ...input,
    tasks: [{ categories: { "life.cooking": 1 }, confidence: 0.95 }],
  }).needed, false);
});

test("URLs, absolute and relative paths, and current information in German and English need tools", () => {
  const paths = [
    "Read https://example.com.", "Open /tmp/report.txt", "Read ./README.md", "Read ../report.txt",
    "Open C:\\Users\\alice\\report.txt",
  ];
  for (const message of paths) assert.equal(detectToolNeed({ message }).needed, true, message);
  const current = [
    "Was ist aktuell?", "Zeige die neuesten Nachrichten.", "Wie ist das Wetter heute?",
    "What is the latest news?", "What is the current release?", "What happened today?",
  ];
  for (const message of current) {
    assert.deepEqual(detectToolNeed({ message }), { needed: true, reasons: ["current-data"] }, message);
  }
  assert.equal(detectToolNeed({ message: "Explain the word currentlyness and the currentless river." }).needed, false);
});

test("attachments and skill allowed-tools detect need and a single matching allowed tool can be named", () => {
  assert.deepEqual(detectToolNeed({ message: "Summarize this.", attachments: true }), {
    needed: true, reasons: ["attachment"],
  });
  assert.deepEqual(detectToolNeed({
    message: "Use the skill.", allowedTools: ["file.read"], offeredTools: ["file.read", "capabilities.search"],
  }), { needed: true, reasons: ["skill-tools"], namedTool: "file.read" });
  assert.deepEqual(detectToolNeed({
    message: "Use the skill.", allowedTools: ["exec.run"], offeredTools: ["file.read"],
  }), { needed: true, reasons: ["skill-tools"] });
  assert.equal(detectToolNeed({ message: "Use the skill.", allowedTools: [] }).needed, false);
});

test("prefer forces the first needed round across provider families then returns to auto", () => {
  for (const family of ["openai-chat", "openai-responses", "anthropic", "gemini"] as const) {
    const input = {
      mode: "prefer" as const,
      need: { needed: true, reasons: ["category"] as const },
      tools: ["file.read"],
      family,
    };
    assert.deepEqual(toolChoiceForTurn({ ...input, round: 0 }), { choice: "required", forced: true });
    assert.deepEqual(toolChoiceForTurn({ ...input, round: 1 }), { choice: "auto", forced: false });
    assert.deepEqual(toolChoiceForTurn({ ...input, round: 0, hasToolCall: true }), { choice: "auto", forced: false });
  }
});

test("auto never forces, prefer without need stays automatic, require-first needs no detection", () => {
  const input = {
    need: { needed: false, reasons: [] },
    tools: ["capabilities.search"],
    family: "openai-chat" as const,
    round: 0,
  };
  assert.deepEqual(toolChoiceForTurn(input), { choice: "auto", forced: false });
  assert.deepEqual(toolChoiceForTurn({
    ...input, need: { needed: true, reasons: ["attachment"] }, mode: "auto",
  }), { choice: "auto", forced: false });
  assert.deepEqual(toolChoiceForTurn({ ...input, mode: "require-first" }), { choice: "required", forced: true });
});

test("forcing excludes Anthropic thinking, unverified local servers and empty catalogues", () => {
  const input = {
    need: { needed: true, reasons: ["category"] as const },
    tools: ["file.read"],
    family: "anthropic" as const,
    round: 0,
  };
  assert.deepEqual(toolChoiceForTurn({ ...input, thinking: true }), {
    choice: "auto", forced: false, suppressed: "anthropic-thinking",
  });
  const local = { ...input, family: "openai-chat" as const, local: true };
  for (const context of [local, { ...local, modelFamily: "openai-chat" }, { ...local, modelFamily: "unknown-local" }]) {
    assert.deepEqual(toolChoiceForTurn(context), { choice: "auto", forced: false, suppressed: "local-unverified" });
  }
  assert.deepEqual(toolChoiceForTurn({ ...input, tools: [] }), {
    choice: "auto", forced: false, suppressed: "no-tools",
  });
});

test("named choice requires an offered tool and retries cannot create a continuing required loop", () => {
  const input = {
    need: { needed: true, reasons: ["skill-tools"] as const, namedTool: "file.read" },
    tools: ["file.read"],
    family: "openai-chat" as const,
    round: 0,
  };
  assert.deepEqual(toolChoiceForTurn(input), { choice: { name: "file.read" }, forced: true });
  assert.deepEqual(toolChoiceForTurn({ ...input, tools: ["capabilities.search"] }), {
    choice: "required", forced: true,
  });
  assert.deepEqual(toolChoiceForTurn({ ...input, round: 1, retry: true }), {
    choice: { name: "file.read" }, forced: true,
  });
  assert.deepEqual(toolChoiceForTurn({ ...input, round: 1, retry: true, hasToolCall: true }), {
    choice: "auto", forced: false,
  });
  assert.deepEqual(toolChoiceForTurn({ ...input, round: 1, retry: true, mode: "auto" }), {
    choice: "auto", forced: false,
  });
});
