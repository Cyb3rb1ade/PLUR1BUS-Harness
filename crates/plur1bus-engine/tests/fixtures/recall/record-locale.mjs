// Record `resolveLocale`/`detectLanguage` of `lib/i18n.js` at the Node pin (RE-D152).
//
//   node record-locale.mjs --source <dir holding lib/i18n.js and lib/i18n-dictionary.js at the pin> --out <file>
//
// Both source hashes are checked before any import. `GERMAN_WORDS` is not exported at the pin, so
// the recorder imports a temporary copy with one appended export line; the original code is unchanged.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const COMMIT = "9f34008c143c5da87b2194b5a28442b407ff8ba7";
const SOURCES = {
  "lib/i18n.js": "f9846591fc0bb8ec21b66c6ec178c1d9be4ef6619d8d7e6fb09ed9923e81e148",
  "lib/i18n-dictionary.js": "830eaa06fa58847cc0ed813fe4b1797c481c7a68b4dbd9ffbde26f89e7e7fed5",
};

const argument = (name) => {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`missing ${name}`);
  return process.argv[index + 1];
};
const root = argument("--source");
const files = {};
for (const [path, expected] of Object.entries(SOURCES)) {
  const bytes = readFileSync(join(root, path));
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (!expected || actual !== expected) throw new Error(`${path} does not match the pin`);
  files[path] = bytes;
}
const dir = mkdtempSync(join(tmpdir(), "locale-"));
let i18n;
try {
  writeFileSync(join(dir, "i18n-dictionary.js"), files["lib/i18n-dictionary.js"]);
  const file = join(dir, "i18n.mjs");
  writeFileSync(file, `${files["lib/i18n.js"]}\nexport { GERMAN_WORDS as __germanWords };\n`);
  writeFileSync(join(dir, "package.json"), '{"type":"module"}\n');
  i18n = await import(pathToFileURL(file).href);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const user = (content) => ({ role: "user", content });
const messages = [
  [],
  [user("project fixture item")],
  [user("What did we decide last week about the project?")],
  [user("Hallo, wie geht es dir?")],
  [user("hallo wie geht es dir")],
  [user("Ich habe das gemacht")],
  [user("der")],
  [user("der der")],
  [user("DER UND")],
  [user("der, und")],
  [user("für mich")],
  [user("für mich")],
  [user("über dich")],
  [user("Ü̈ber dich")],
  [user("ja nein")],
  [user("ja nein")],
  [user("ja​nein")],
  [user("ja\tbitte\ndanke")],
  [user("  moin   hi  ")],
  [user("İch und")],
  [user("ICH UND DU")],
  [{ role: "assistant", content: "der die das und" }],
  [{ role: "assistant", content: "der die das und" }, user("hello there")],
  [user("der"), user("und")],
  [user("der"), user("hello"), user("world"), user("und")],
  [user("der und"), user("one"), user("two"), user("three")],
  [user(42), user("und der")],
  [user(null), { role: "system", content: "der und" }],
  [{ content: "der und" }],
  [user("Kannst du mir bitte helfen?")],
  [user("Can you help me with the API?")],
  [user("Das ist ein Test 🚀 und noch einer")],
  [user("dass sie es tun")],
  [user("ihr seid euer eigener chef")],
];
const detect = messages.map((list) => ({ messages: list, detected: i18n.detectLanguage(list) }));
const resolve = [
  { args: {} },
  { args: { fallback: "de" } },
  { args: { messages: [], fallback: "fr" } },
  { args: { config: "de", messages: [user("hello world")] } },
  { args: { config: "", messages: [user("der und")] } },
  { args: { ctx: { lang: "fr" }, messages: [user("der und")] } },
  { args: { ctx: { lang: "" }, messages: [user("hello")], fallback: "de" } },
  { args: { ctx: { messages: [user("der und")] }, messages: [user("der und")], fallback: "en" } },
  { args: { ctx: { messages: [user("hello")] }, messages: [user("hello")], fallback: "en" } },
  { args: { messages: [{ role: "assistant", content: "der und" }], fallback: "de" } },
].map(({ args }) => ({ args, resolved: i18n.resolveLocale(args) }));

const output = {
  source: {
    commit: COMMIT,
    files: Object.fromEntries(Object.entries(SOURCES).map(([path, sha256]) => [path, sha256])),
  },
  node: { version: process.version, unicode: process.versions.unicode, icu: process.versions.icu },
  germanWords: [...i18n.__germanWords],
  detect,
  resolve,
};
writeFileSync(argument("--out"), `${JSON.stringify(output, null, 2)}\n`);
