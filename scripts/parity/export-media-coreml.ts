import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { CoreMLAdapter } from "../../packages/media/src/coreml.ts";
import { MediaError } from "../../packages/media/src/types.ts";
import { makeLeakyPng, makePng } from "../../packages/media/test/adapters-fixtures.ts";
import { exporterMain } from "./lib.mjs";

export async function recordMediaCoreMl() {
  const root = await mkdtemp(join(tmpdir(), "p4-media-coreml-"));
  const helper = fileURLToPath(new URL("./helpers/media-coreml.mjs", import.meta.url));
  const png = makePng();
  const source = makeLeakyPng();
  const model = "sample-split";
  const parameters = { prompt: "A paper tree 🌳", negativePrompt: "fog", n: 1, seed: 7, steps: 12, guidance: 6 };
  type Event = { send?: string, receive?: string };
  const normalize = (line: string) => {
    const event: Event = JSON.parse(line);
    if (event.send) {
      const request = JSON.parse(event.send);
      for (const key of ["modelDir", "modelsDir"]) if (request[key] === root) request[key] = "/fixture/models";
      if (request.outputDir) request.outputDir = "/fixture/output";
      if (request.inputPath) request.inputPath = "/fixture/output/input.png";
      event.send = JSON.stringify(request);
    }
    return event;
  };
  const scenarios: Record<string, unknown> = {};
  try {
    for (const mode of ["normal", "legacy", "hold"]) {
      const log = join(root, mode);
      const adapter = new CoreMLAdapter({
        id: "coreml-local", model, helperPath: process.execPath, helperArgs: [helper, log, mode, png.toString("base64")],
        modelDir: root, platform: { os: "darwin", arch: "arm64" }, timeoutMs: 5000, cancelGraceMs: 1000,
        computeUnits: "cpuAndGPU", scheduler: "dpmpp", strength: 0.5,
      });
      try {
        const progress: number[] = [];
        const signal = new AbortController();
        const context = { signal: signal.signal, onProgress: (value: { fraction: number }) => {
          progress.push(value.fraction);
          if (mode === "hold") signal.abort();
        } };
        let outcome: unknown;
        const encode = (file: { bytes: Uint8Array }) => Buffer.from(file.bytes).toString("base64");
        if (mode === "hold") {
          try { await adapter.generate(parameters, context); }
          catch (error) { if (!(error instanceof MediaError)) throw error; outcome = error.code; }
          if (outcome !== "cancelled") throw new Error("CoreML cancel recording incomplete");
        } else {
          const result = await adapter.generate(parameters, context);
          const edited = mode === "normal" ? await adapter.edit({ prompt: "Snow",
            referenceImages: [{ bytes: source, format: "png" }] }) : undefined;
          outcome = { generated: result.files.map(encode), edited: edited?.files.map(encode),
            seed: result.metadata.seed, models: await adapter.listModels(), partial: result.partial };
        }
        const events = (await readFile(log, "utf8")).trim().split("\n").map(normalize);
        scenarios[mode] = { events, outcome, progress };
      } finally {
        await adapter.close();
      }
    }
    return { "coreml-wire": { input: { model, parameters, reference: source.toString("base64"),
      png: png.toString("base64") }, scenarios } };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await exporterMain({ area: "media", build: recordMediaCoreMl });
}
