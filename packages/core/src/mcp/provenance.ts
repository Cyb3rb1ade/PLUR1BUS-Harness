import type { Redactor } from "./redact.ts";
import type { McpCaller, McpProvenance, McpToolResult, McpTrust } from "./types.ts";

/** D19: `{ origin: { system, agent, principal, trust }, hops, transformedBy }` (ADR-014 §3). */
export function makeProvenance(server: string, caller: McpCaller, trust: McpTrust, transformedBy: string[] = []): McpProvenance {
  return {
    // An MCP server is a system, not an agent: `agent` stays null (A2A peers will fill it). `principal` is who the call ran under.
    origin: { system: `mcp:${server}`, agent: null, principal: caller.principal, trust },
    hops: 1,
    transformedBy: [...transformedBy],
  };
}

type Block = Record<string, unknown>;

interface Budget { left: number; truncated: boolean; redacted: boolean }

function takeText(text: string, b: Budget, redactor: Redactor): string {
  let out = redactor.redact(text);
  if (out !== text) b.redacted = true;
  const bytes = Buffer.byteLength(out, "utf8");
  if (bytes > b.left) {
    // Cut on a character boundary: slice by bytes then drop a trailing partial sequence.
    out = Buffer.from(out, "utf8").subarray(0, Math.max(0, b.left)).toString("utf8").replace(/�$/, "");
    b.truncated = true; b.left = 0;
  } else b.left -= bytes;
  return out;
}

function shapeBlock(block: Block, b: Budget, redactor: Redactor): Block {
  if (block.type === "text" && typeof block.text === "string") return { ...block, text: takeText(block.text, b, redactor) };
  if (block.type === "resource" && block.resource && typeof block.resource === "object") {
    const res = block.resource as Block;
    if (typeof res.text === "string") return { ...block, resource: { ...res, text: takeText(res.text, b, redactor) } };
    if (typeof res.blob === "string" && res.blob.length > b.left) { b.truncated = true; return { type: "text", text: "[omitted: resource blob over the size cap]" }; }
    if (typeof res.blob === "string") b.left -= res.blob.length;
    return block;
  }
  if ((block.type === "image" || block.type === "audio") && typeof block.data === "string") {
    if (block.data.length > b.left) { b.truncated = true; return { type: "text", text: `[omitted: ${String(block.type)} block over the size cap]` }; }
    b.left -= block.data.length;
    return block;
  }
  return block;
}

export interface WrapOptions {
  server: string; tool: string; caller: McpCaller; trust: McpTrust; redactor: Redactor; maxBytes: number;
}

/** Wrap a raw `tools/call` result. The only way a result leaves the client (ADR-014 §3). */
export function wrapToolResult(raw: { content?: unknown; structuredContent?: unknown; isError?: unknown }, o: WrapOptions): McpToolResult {
  const b: Budget = { left: o.maxBytes, truncated: false, redacted: false };
  const blocks = Array.isArray(raw.content) ? (raw.content as Block[]) : [];
  const content = blocks.map((blk) => shapeBlock(blk, b, o.redactor));
  let structured: Record<string, unknown> | undefined;
  if (raw.structuredContent && typeof raw.structuredContent === "object") {
    const json = JSON.stringify(raw.structuredContent);
    const red = o.redactor.redact(json);
    if (red !== json) b.redacted = true;
    if (Buffer.byteLength(red, "utf8") > b.left) b.truncated = true; // dropped, not cut: a partial object would not parse
    else {
      try { structured = JSON.parse(red) as Record<string, unknown>; b.left -= Buffer.byteLength(red, "utf8"); } catch { b.truncated = true; }
    }
  }
  const transformedBy = [...(b.truncated ? ["truncate"] : []), ...(b.redacted ? ["redact"] : [])];
  return {
    provenance: makeProvenance(o.server, o.caller, o.trust, transformedBy),
    server: o.server, tool: o.tool, isError: raw.isError === true, content,
    ...(structured ? { structuredContent: structured } : {}),
  };
}
