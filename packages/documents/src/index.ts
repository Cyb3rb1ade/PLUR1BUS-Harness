// @plur1bus/documents — the D100 document design system and HTML→PDF renderer (docs/documents.md, docs/superpowers/specs/
// 2026-09-28-basics-quality-bar-design.md §D100). Design tokens, templates, a self-contained Markdown→HTML→PDF pipeline
// over Chromium's `Page.printToPDF`, and the `document.render` tool contract. No engine, no network at render time.

export * from "./tokens.ts";
export * from "./markdown.ts";
export * from "./sanitize.ts";
export * from "./templates.ts";
export * from "./fonts.ts";
export * from "./render.ts";
export * from "./checks.ts";
export * from "./review.ts";
export * from "./schema.ts";
export * from "./chromium.ts";
