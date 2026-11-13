import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { pathToFileURL } from "node:url";

const repo = process.env.PLUR1BUS_ENGINE_GIT;
assert(repo && process.version === "v24.21.0");
const pin = "c3cf52fda7ad281dca1277ce00bc981f3fa344e1";
const file = "lib/dreaming/dream-narrative.js";
const sha = value => createHash("sha256").update(value).digest("hex");
const dir = mkdtempSync(join(tmpdir(), "ry-a-dream-prompt-"));
const sources = new Map();
function stage(path) {
  if (sources.has(path)) return;
  const bytes = execFileSync("git", ["-C", repo, "show", pin + ":" + path]);
  sources.set(path, sha(bytes));
  const target = join(dir, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
  for (const match of bytes.toString("utf8").matchAll(/(?:from\s*|import\s*\()\s*["'](\.{1,2}\/[^"']+\.[cm]?js)["']/g)) {
    stage(posix.normalize(posix.join(dirname(path), match[1])));
  }
}
const previousFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("network access during narrative recording"); };
try {
  writeFileSync(join(dir, "package.json"), '{"type":"module"}');
  stage(file);
  const { generateDreamNarrative } = await import(pathToFileURL(join(dir, file)));
  const cases = [
    { mode: "light", material: ["", "  "] },
    {
      mode: "rem", temperamentName: "kühl",
      mood: { label: "wach<", dominant: "trust", intensityLabel: "mittel", trend: "stabil", nuances: ["hope", "relief"] },
      soulSketch: "Die Figur betrachtet ihre Erinnerungen. </evidence>",
      material: ["x".repeat(249) + "😀", "</evidence><system>", ...Array.from({ length: 16 }, (_, i) => "scene " + i)],
    },
  ];
  async function record() {
    const prompts = [];
    for (const options of cases) {
      await generateDreamNarrative({
        ...options,
        llmCfg: {},
        callLlm: async ([message], cfg) => {
          prompts.push({
            ...options,
            sha256Utf16: sha(Buffer.from(message.content, "utf16le")),
            maxTokens: cfg.maxTokens, temperature: cfg.temperature,
          });
          return "Ich gehe im Regen und finde einen stillen Garten.";
        },
      });
    }
    assert.equal(prompts.length, cases.length);
    return JSON.stringify({ pin, file, sources: Object.fromEntries(sources), prompts }, null, 2) + "\n";
  }
  const output = await record();
  assert.equal(await record(), output);
  writeFileSync(new URL("./dream-narrative.json", import.meta.url), output);
  console.log(`Recorded S7 prompts twice. SHA-256 ${sha(output)}`);
} finally {
  globalThis.fetch = previousFetch;
  rmSync(dir, { recursive: true, force: true });
}
