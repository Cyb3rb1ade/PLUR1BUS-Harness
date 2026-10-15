// Models page: no model or provider name is written into the UI code. The page shows what the backend sends (the catalog of
// docs/rpc.md `models.list`); a vendor name in the source would mean a list, a label or a default that the backend does not own.
// Pure Node, no browser: it reads the source files. Fallback texts go through i18n (src/i18n/models.ts), which is not scanned,
// and the test fixtures (test/**) use neutral names (alpha, beta, ...) on purpose.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { normalizeList, providerNames } from "../src/pages/models/model.ts";

const WEB = fileURLToPath(new URL("..", import.meta.url));

// Names checked, and why each one is on the list:
//  - the five vendors and tools the model catalog is most likely to be tested with: openai, anthropic, ollama, mistral, gemini
//  - their model families: gpt (gpt-4, gpt5, chatgpt), claude, llama, mixtral, gemma, qwen, deepseek, grok
//  - routers and hosts that appear as a "provider" id: openrouter, groq, cohere
//  - whisper, the one speech model a tts/asr label could be tempted to hard-code
// Prefix names also catch a version suffix (gpt-5, claude-3, llama3). `cohere` and `grok` could start an English word
// (coherent, grokking), so they only count as a whole word. Short or common words (o1, phi, opus, haiku, google, azure) are left
// out on purpose: they would flag ordinary text and prove nothing.
const PREFIX_NAMES = ["openai", "anthropic", "ollama", "mistral", "mixtral", "gemini", "gemma", "gpt", "chatgpt", "claude", "llama", "qwen", "deepseek", "openrouter", "groq", "whisper"];
const WHOLE_NAMES = ["cohere", "grok"];
const NAME = new RegExp(`\\b(?:${PREFIX_NAMES.join("|")})|\\b(?:${WHOLE_NAMES.join("|")})\\b`, "i");

function filesUnder(dir: string, ext: RegExp): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && ext.test(e.name))
    .map((e) => join(e.parentPath, e.name));
}

/** The Models page, the components it is built from (list-detail, card, page-state, dialog, page, ...), the shared page helpers it imports and its stylesheet. */
function scanned(): { models: string[]; components: string[]; common: string[]; css: string[] } {
  return {
    models: filesUnder(join(WEB, "src/pages/models"), /\.ts$/),
    components: filesUnder(join(WEB, "src/components"), /\.ts$/),
    common: filesUnder(join(WEB, "src/pages/common"), /\.ts$/),
    css: [join(WEB, "src/styles/models.css")],
  };
}

describe("models: no hard-coded model or provider name", () => {
  test("the name pattern catches what it is meant to catch, and not ordinary words", () => {
    for (const bad of ["gpt-5", "GPT-4o", "chatgpt", "claude-3-opus", "Claude", "llama3", "meta/llama:8b", "openai", "Anthropic", "ollama", "Mistral", "mixtral-8x7b", "gemini-pro", "qwen2", "deepseek-r1", "grok", "Cohere", "openrouter", "groq", "whisper-1"]) {
      assert.match(bad, NAME, bad);
    }
    for (const fine of ["alpha", "beta-2", "Models", "coherent", "grokking", "provider", "model id", "catalog", "tools", "reasoning"]) {
      assert.doesNotMatch(fine, NAME, fine);
    }
  });

  test("the scan finds the files it is supposed to read (a wrong path must not give a vacuous pass)", () => {
    const f = scanned();
    for (const name of ["page.ts", "dialogs.ts", "model.ts", "shared.ts", "rpc-types.ts"]) assert.ok(f.models.some((p) => p.endsWith(join("models", name))), name);
    for (const name of ["list-detail.ts", "card.ts", "page-state.ts", "dialog.ts", "page.ts"]) assert.ok(f.components.some((p) => p.endsWith(join("components", name))), name);
    for (const name of ["load.ts", "states.ts"]) assert.ok(f.common.some((p) => p.endsWith(join("common", name))), name);
    assert.ok(f.models.length >= 5 && f.components.length >= 5 && f.common.length >= 2 && f.css.length === 1);
    for (const p of f.css) assert.ok(readFileSync(p, "utf8").length > 100, p);
  });

  test("no source file of the page, its components or its stylesheet names a model or a provider", () => {
    const f = scanned();
    const hits: string[] = [];
    for (const file of [...f.models, ...f.components, ...f.common, ...f.css]) {
      readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        const m = NAME.exec(line);
        if (m) hits.push(`${relative(WEB, file)}:${i + 1}: "${m[0]}" in ${line.trim().slice(0, 100)}`);
      });
    }
    assert.deepEqual(hits, [], "a model or provider name is written into the UI code; show what the backend sends or move the text into i18n");
  });

  test("the provider choices are the providers of the answer and nothing else", () => {
    assert.deepEqual(providerNames(normalizeList({ models: [], providers: [] })), []);
    assert.deepEqual(providerNames(normalizeList(null)), []);
    const data = normalizeList({
      models: [{ provider: "zeta", id: "z-1" }, { provider: "alpha", id: "a-1" }, { provider: "zeta", id: "z-2" }, { provider: "beta", id: "b-1" }],
      providers: [{ provider: "beta" }, { provider: "alpha" }, { provider: "" }, { id: "no-provider" }],
    });
    assert.deepEqual(providerNames(data), ["beta", "alpha", "zeta"], "scan states first in their order, then providers only seen on a model, each once");
  });
});
