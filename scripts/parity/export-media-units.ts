import { fileURLToPath } from "node:url";
import { requestedUnits, deliveredUnits } from "../../packages/media/src/units.ts";
import type { ImageRequest } from "../../packages/media/src/types.ts";
import type { Manifest } from "../../packages/media/src/store.ts";
import { exporterMain } from "./lib.mjs";

function recordMediaUnits() {
  const cases = [
    { input: { prompt: "Draw a blue circle" }, files: [null] },
    { input: { prompt: "Three blue circles", n: 3, size: { width: 512, height: 512 } }, files: [null, null] },
    { input: { prompt: "Slow sunrise", kind: "video", fps: 24 }, files: [2.25, null] },
    { input: { prompt: "Slow sunrise", kind: "video", durationSeconds: 600 }, files: [1.5] },
    { input: { prompt: "Slow sunrise", kind: "video", durationSeconds: 601 }, files: [] },
    { input: { prompt: "Image", fps: 20 }, files: [] },
    { input: { prompt: "Image", steps: 0 }, files: [] },
    { input: { prompt: "Image", size: { width: 8193, height: 1 } }, files: [] },
    { input: { prompt: "   " }, files: [] },
    { input: { prompt: "x".repeat(32001) }, files: [] },
  ];
  return {
    units: {
      source: "packages/media/src/units.ts",
      cases: cases.map(({ input, files }) => {
        let expected;
        try {
          const request = input as ImageRequest;
          const manifest = { files: files.map((part) => part === null ? {} : { durationSeconds: part }) } as Pick<Manifest, "files">;
          expected = { requested: requestedUnits(request), delivered: deliveredUnits(request, manifest) };
        } catch (error) {
          expected = { error: (error as { code: string }).code };
        }
        const recordedInput = input.prompt.length > 32000 ? { ...input, prompt: undefined, promptRepeat: input.prompt.length } : input;
        return { input: recordedInput, files, expected };
      }),
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await exporterMain({ area: "media", build: recordMediaUnits });
}
