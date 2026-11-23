// W4: record production image verification, metadata stripping and embedding.
import { fileURLToPath } from "node:url";
import { embedImage } from "../../packages/media/src/adapters/_shared/metadata.ts";
import { stripMetadata, verifyOutput } from "../../packages/media/src/adapters/_shared/images.ts";
import { MediaError, type ImageFormat } from "../../packages/media/src/types.ts";
import { makeJpeg, makeLeakyPng, makePng, makeWebp, pngChunk } from "../../packages/media/test/adapters-fixtures.ts";
import { exporterMain } from "./lib.mjs";

export function recordMediaImages() {
  const payload = { prompt: "A tree 🌳 & a lake < 1 km away", parameters: { n: 1 }, metadata: { seed: 7 } };
  const valid: Array<{ format: ImageFormat; source: Buffer }> = [
    { format: "png", source: makeLeakyPng() },
    { format: "jpeg", source: makeJpeg({ exif: 6, xmp: "synthetic-xmp", comment: "synthetic-note", icc: true }) },
    { format: "webp", source: Buffer.from(embedImage(makeWebp({ extended: true, exif: true }), "webp",
      { ...payload, prompt: "synthetic previous packet" })) },
    { format: "webp", source: makeWebp({ lossy: true }) },
  ];
  const cases = valid.map(({ format, source }) => {
    const stripped = stripMetadata(source);
    return {
      format, input: source.toString("base64"),
      expected: {
        sanitized: Buffer.from(stripped.bytes).toString("base64"),
        embedded: Buffer.from(embedImage(source, format, payload)).toString("base64"),
      },
    };
  });
  const withDimensions = (width: number, height: number) => {
    const image = makePng();
    image.writeUInt32BE(width, 16);
    image.writeUInt32BE(height, 20);
    return Buffer.concat([image.subarray(0, 8), pngChunk("IHDR", image.subarray(16, 29)), image.subarray(33)]);
  };
  const refusals = [
    { format: "png" as const, source: makePng().subarray(0, 19), mode: "sanitize" },
    { format: "png" as const, source: withDimensions(32769, 1), mode: "verify" },
    { format: "png" as const, source: withDimensions(20000, 20000), mode: "verify" },
    { format: "jpeg" as const, source: makePng(), mode: "embed" },
  ].map(({ format, source, mode }) => {
    try {
      if (mode === "sanitize") stripMetadata(source);
      else if (mode === "verify") verifyOutput({ bytes: source, format });
      else embedImage(source, format, payload);
    } catch (error) {
      if (!(error instanceof MediaError)) throw error;
      return { format, mode, source: source.toString("base64"), code: error.code };
    }
    throw new Error("Expected image fixture refusal");
  });
  return { "image-codecs": { payload, cases, refusals } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await exporterMain({ area: "media", build: recordMediaImages });
}
