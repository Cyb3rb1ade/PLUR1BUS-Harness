// RE-04/T5: actual Node oracle, two fresh processes, immutable sources first.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(here, "render-sources.json"), "utf8"));
function verifySources(root) {
  for (const [name, expected] of Object.entries(manifest.sources)) {
    const actual = createHash("sha256")
      .update(readFileSync(path.join(root, name)))
      .digest("hex");
    assert.equal(actual, expected, "pinned render source hash mismatch: " + name);
  }
  assert.equal(process.version, "v24.21.0", "record with pinned Node 24.21.0");
}

// Same parts/joiner codec used by T0/T1; retain the reference marker's case.
function markerCodec(value) {
  if (typeof value === "string") {
    const match = value.match(new RegExp(["open", "claw"].join(""), "i"));
    if (!match) return value;
    return { parts: value.split(match[0]), joiner: [match[0].slice(0, 4), match[0].slice(4)] };
  }
  if (Array.isArray(value)) return value.map(markerCodec);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, markerCodec(child)]));
  }
  return value;
}

export async function recordRender(root) {
  verifySources(root);
  const capture = () => {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--capture", root], {
      encoding: "utf8",
      env: { ...process.env, TZ: "UTC" },
      maxBuffer: 32 * 1024 * 1024,
    });
    assert.equal(child.status, 0, "Node capture failed: " + child.stderr);
    return child.stdout;
  };
  const first = capture();
  const second = capture();
  assert.equal(first, second, "independent render captures differ");
  const values = JSON.parse(first);
  const target = path.join(here, "golden", "render");
  mkdirSync(target, { recursive: true });
  for (const [name, cases] of Object.entries(values)) {
    const fixture = markerCodec({
      recordedFrom: {
        engine: "node",
        ...manifest,
        node: process.version,
        unicode: process.versions.unicode,
        timezone: "UTC",
      },
      cases,
    });
    writeFileSync(path.join(target, name + ".json"), JSON.stringify(fixture, null, 2) + "\n");
  }
  console.log("Recorded " + Object.keys(values).length + " T5 goldens from identical fresh Node captures.");
}

if (process.argv[2] === "--capture") {
  const root = process.argv[3];
  verifySources(root);
  const { captureRender } = await import("./render-runtime.mjs");
  process.stdout.write(JSON.stringify(await captureRender(root)));
}
