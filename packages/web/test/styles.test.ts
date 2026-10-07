// Style hygiene: colours come from the Glow tokens only, every stylesheet is reached from app.css, and pages ship no style
// objects or constructable stylesheets (all styling is real CSS files; the strict CSP of ADR-004 stays untouched).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

const web = fileURLToPath(new URL("..", import.meta.url));
const stylesDir = join(web, "src/styles");
const read = (p: string): string => readFileSync(p, "utf8");
const files = (dir: string, ext: RegExp): string[] =>
  readdirSync(dir, { withFileTypes: true, recursive: true }).filter((e) => e.isFile() && ext.test(e.name)).map((e) => join(e.parentPath, e.name));
/** CSS without comments and without string contents (a `content: "#fff"` is not a colour). */
const code = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');

/** Files that may define raw colours: only the token sheet. Add a path here only with a reason. */
const COLOUR_ALLOWLIST = new Set<string>(["tokens.css"]);
const RAW_COLOUR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\(/g;

describe("styles", () => {
  test("no raw colour values outside tokens.css (#hex, rgb(), hsl() and friends)", () => {
    const offences: string[] = [];
    for (const f of files(stylesDir, /\.css$/)) {
      const name = relative(stylesDir, f);
      if (COLOUR_ALLOWLIST.has(name)) continue;
      const lines = code(read(f)).split("\n");
      lines.forEach((line, i) => { for (const m of line.matchAll(RAW_COLOUR)) offences.push(`${name}:${i + 1}: ${m[0]}`); });
    }
    assert.deepEqual(offences, [], "use a token from tokens.css (var(--ink), var(--border), ...)");
  });

  test("the checker itself catches what it should", () => {
    for (const bad of ["a{color:#fff}", "a{color:#A1B2C3D4}", "a{background:rgba(0,0,0,.5)}", "a{color:hsl(10 20% 30%)}", "a{color:oklch(0.5 0.1 20)}"]) {
      assert.ok(code(bad).match(RAW_COLOUR), bad);
    }
    for (const ok of ["a{color:var(--ink)}", 'a::before{content:"#fff"}', "/* #fff */ a{color:inherit}", "a{background:color-mix(in srgb, var(--accent) 12%, transparent)}"]) {
      assert.equal(code(ok).match(RAW_COLOUR), null, ok);
    }
  });

  test("every stylesheet is imported (directly) by app.css", () => {
    const app = read(join(stylesDir, "app.css"));
    const imported = new Set([...app.matchAll(/@import\s+"\.\/([\w.-]+\.css)"/g)].map((m) => m[1]));
    const all = files(stylesDir, /\.css$/).map((f) => relative(stylesDir, f)).filter((n) => n !== "app.css");
    assert.deepEqual(all.filter((n) => !imported.has(n)).sort(), [], "add an @import to app.css (build.ts bundles it into styles.css)");
  });

  test("@import lines come first in app.css (later ones are ignored by browsers and esbuild)", () => {
    const body = code(read(join(stylesDir, "app.css")));
    const firstRule = body.search(/[^@\s][^{;]*\{/);
    const lastImport = body.lastIndexOf("@import");
    assert.ok(firstRule === -1 || lastImport < firstRule);
  });

  test("pages and components set no style objects and adopt no stylesheets", () => {
    const offences: string[] = [];
    for (const f of [...files(join(web, "src/pages"), /\.ts$/), ...files(join(web, "src/components"), /\.ts$/)]) {
      read(f).split("\n").forEach((line, i) => {
        // `style: "currency"` of Intl.NumberFormat is fine; a style object or a shared style constant is not.
        if (/\bstyle:\s*(\{|S\.|[A-Z_]+\b)/.test(line) || /adoptedStyleSheets|new CSSStyleSheet|\.style\.\w+\s*=|setAttribute\(\s*["']style["']/.test(line)) {
          offences.push(`${relative(web, f)}:${i + 1}: ${line.trim().slice(0, 100)}`);
        }
      });
    }
    assert.deepEqual(offences, [], "put the rule into src/styles/*.css and use a class");
  });
});
