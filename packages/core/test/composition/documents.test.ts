import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { composeTools, type ToolCompositionOptions } from "../../src/composition/tools.ts";
import type { ToolRegistry, ToolRunContext } from "../../src/tools/registry.ts";
import type { BrowserPort } from "../../../documents/src/index.ts";
import type { ChatRequest } from "../../src/session/provider.ts";
import { useTempDirs } from "./helpers.ts";

const tmp = useTempDirs("p1b-docs-");
const noAudit = { append() { /* discarded */ } } as never;
const noGrants = { get: () => undefined, list: () => [] };
const turn = (over: Partial<ChatRequest> = {}): ChatRequest => ({ sessionId: "s1", agentId: "a1", principal: "user-1", summaries: [], memory: "", messages: [], signal: new AbortController().signal, ...over });
const run = (signal = new AbortController().signal): ToolRunContext => ({ signal, agentId: "a1", principal: "user-1", sessionId: "s1", surface: 0 });

const STUB_PDF = Buffer.from("%PDF-1.4\n%stub\n%%EOF\n", "ascii");

function fakeBrowser(capture: (html: string) => void): BrowserPort {
  return { async printToPdf(html) { capture(html); return new Uint8Array(STUB_PDF); } };
}

function options(over: Partial<ToolCompositionOptions> = {}): ToolCompositionOptions {
  const root = tmp.make();
  return { home: root, roots: [{ id: "r", path: root }], audit: noAudit, grants: noGrants, ...over };
}

describe("composition/tools document.render (D100)", () => {
  it("registers only when a documents browser is configured", async () => {
    const without = await composeTools(options(), turn());
    assert.ok(!without.entries().some((t) => t.name === "document.render"));
    const withDoc = await composeTools(options({ documents: { browser: fakeBrowser(() => {}) } }), turn());
    const tool = withDoc.entries().find((t) => t.name === "document.render")!;
    assert.equal(tool.capability, "fs.write");
    assert.equal(tool.effect, "local-write");
    assert.equal(tool.risk, "low");
  });

  it("refuses an output path outside the roots in classification", async () => {
    const root = tmp.make();
    const outside = tmp.make();
    const reg = await composeTools(options({ roots: [{ id: "r", path: root }], documents: { browser: fakeBrowser(() => {}) } }), turn());
    const tool = reg.entries().find((t) => t.name === "document.render")!;
    const cls = await tool.classify!({ template: "report", content: "# T", title: "T", outputPath: join(outside, "x.pdf") });
    assert.equal(cls.flags?.outsideRoots, true);
  });

  it("renders and writes the PDF inside the root, and the browser sees only self-contained HTML", async () => {
    const root = tmp.make();
    let seen = "";
    const reg: ToolRegistry = await composeTools(options({ roots: [{ id: "r", path: root }], documents: { browser: fakeBrowser((html) => (seen = html)) } }), turn());
    const tool = reg.entries().find((t) => t.name === "document.render")!;
    const out = join(root, "report.pdf");
    const result = (await tool.execute({ template: "report", content: "# Overview\n\n<script>alert(1)</script>\n\nBody.", title: "Quarterly Report", outputPath: out }, run())) as { path: string; bytes: number };
    assert.ok(existsSync(result.path));
    assert.ok(existsSync(out));
    assert.equal(readFileSync(out).subarray(0, 5).toString("ascii"), "%PDF-");
    assert.doesNotMatch(seen, /<\s*script/i);
    assert.doesNotMatch(seen, /https?:\/\//i);
  });
});
