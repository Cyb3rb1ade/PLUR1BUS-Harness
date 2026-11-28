import { fileURLToPath } from "node:url";
import { decodeBody, decodeEntities, splitSections } from "../../packages/core/src/tools/web/html.ts";
import { exporterMain } from "./lib.mjs";

export function recordWebText() {
  const encodings = [
    { bytes: [...Buffer.from("Lärm 🐈")] },
    { bytes: [0x80, 0x20, 0x93, 0x48, 0x94] },
    { bytes: [0xff, 0xfe, 0x41, 0, 0x42, 0] },
    { bytes: [0xfe, 0xff, 0, 0x48, 0, 0x69] },
    { bytes: [0xe9], contentType: "text/html; charset='iso-8859-1'" },
    { bytes: [...Buffer.from('<meta charset="windows-1252">'), 0xe9] },
    { bytes: [0xef, 0xbb, 0xbf, 0x41], contentType: "text/html; charset=unknown-fixture" },
    { bytes: [0xe9], contentType: "text/html; charset=utf-8" },
  ].map(({ bytes, contentType }) => ({
    bytes, contentType, output: decodeBody(Uint8Array.from(bytes), contentType),
  }));
  const entities = [
    "A &amp; B &leaves; &lt;draft&gt;",
    "&#128008; &#x1F408; &#0; &#xD800; &#x110000;",
    "&Auml; &szlig; &nbsp; &shy; &thinsp; &zwnj;",
    "&unknown; &#3; &unfinished",
  ].map(input => ({ input, output: decodeEntities(input) }));
  const sections = [
    "", "\n\n# Heading  \n\nBody 🐈 \n## Next\nMore",
    "Introduction\n\n```md\n# This stays literal\n```\n\n# Real heading\nText",
    "Only a paragraph\n\n", "##### Five\n> Quote\n####### Ordinary text",
  ].map(input => ({ input, output: splitSections(input) }));
  return { text: { source: "packages/core/src/tools/web/html.ts", encodings, entities, sections } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await exporterMain({ area: "webtools", build: recordWebText });
}
