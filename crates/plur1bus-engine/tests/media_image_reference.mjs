/** Apache Transformers.js 4.3.1 patch/rescale oracle using runtime-generated RGB bytes only. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.argv[2];
const base = resolve(root, "node_modules/.pnpm/@huggingface+transformers@4.3.1_@types+node@24.13.6/node_modules/@huggingface/transformers/src");
const { Gemma4ImageProcessor } = await import(pathToFileURL(resolve(base, "models/gemma4/image_processing_gemma4.js")));
const { RawImage } = await import(pathToFileURL(resolve(base, "utils/image.js")));
const input = JSON.parse(readFileSync(0, "utf8"));
const data = Uint8Array.from(input.rgb);
const image = new RawImage(data, input.width, input.height, 3);
const processor = new Gemma4ImageProcessor({ max_soft_tokens: input.budget, do_resize: false });
const result = await processor(image);
process.stdout.write(JSON.stringify({
  pixels: Buffer.from(result.pixel_values.data.buffer).toString("hex"),
  positions: Array.from(result.image_position_ids.data, Number),
  soft_tokens: result.num_soft_tokens_per_image[0],
}));
