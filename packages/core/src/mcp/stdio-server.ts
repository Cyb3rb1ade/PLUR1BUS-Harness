// MCP stdio server entry for `plur1bus mcp serve`:
// Bridges stdio JSON-RPC to the harness MCP server (HTTP /mcp or in-process).
// stdout carries only JSON-RPC; stderr carries all logs.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";

export interface McpStdioIo {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

export interface McpStdioOptions {
  apiUrl?: string;
  inProcessHandler?: (line: string) => Promise<string | null>;
}

export async function runMcpMain(
  argv: string[],
  io: McpStdioIo,
  options: McpStdioOptions = {},
): Promise<number> {
  let values: { home?: string; agent?: string };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        home: { type: "string" },
        agent: { type: "string" },
      },
      strict: true,
    }));
  } catch (err) {
    io.stderr.write(`mcp: ${err instanceof Error ? err.message : "bad arguments"}\n`);
    return 2;
  }

  const token = process.env.PLUR1BUS_MCP_TOKEN;
  if (!token || !token.trim()) {
    io.stderr.write("mcp: PLUR1BUS_MCP_TOKEN environment variable required\n");
    return 2;
  }

  const agentId = values.agent ?? "default";
  const home = values.home ?? process.cwd();

  // Determine HTTP target or in-process fallback
  let apiUrl = options.apiUrl;
  if (!apiUrl) {
    const apiJsonPath = join(home, "run", "api.json");
    if (existsSync(apiJsonPath)) {
      try {
        const raw = readFileSync(apiJsonPath, "utf8");
        const parsed = JSON.parse(raw);
        if (typeof parsed.port === "number") {
          apiUrl = `http://127.0.0.1:${parsed.port}/mcp`;
        }
      } catch {
        // Ignored, will fall back
      }
    }
  }

  const rl = createInterface({
    input: io.stdin,
    crlfDelay: Infinity,
    terminal: false,
  });

  io.stderr.write(`[mcp-stdio] Server started for agent: ${agentId}\n`);
  let negotiatedVersion: string | undefined;

  for await (const rawLine of rl) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    let parsed: any;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      io.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        }) + "\n",
      );
      continue;
    }

    const id = parsed.id;
    const isNotification = id === undefined || id === null;

    if (apiUrl) {
      try {
        const clientVersion =
          parsed.params?._meta?.["io.modelcontextprotocol/protocolVersion"] ??
          (parsed.method === "initialize" ? parsed.params?.protocolVersion : undefined) ??
          negotiatedVersion;

        const isModern = clientVersion === "2026-07-28" || (!clientVersion && !negotiatedVersion);
        if (parsed.method === "initialize" && typeof parsed.params?.protocolVersion === "string") {
          negotiatedVersion = parsed.params.protocolVersion;
        }

        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${token}`,
        };

        let bodyToSend = trimmed;
        if (isModern) {
          headers["Mcp-Protocol-Version"] = "2026-07-28";
          headers["Mcp-Method"] = parsed.method;
          if (parsed.method === "tools/call" && parsed.params?.name) {
            headers["Mcp-Name"] = encodeURIComponent(parsed.params.name);
          }
          const params =
            typeof parsed.params === "object" && parsed.params !== null && !Array.isArray(parsed.params)
              ? { ...parsed.params }
              : {};
          params._meta = {
            ...(typeof params._meta === "object" && params._meta !== null ? params._meta : {}),
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          };
          bodyToSend = JSON.stringify({ ...parsed, params });
        } else if (clientVersion === "2024-11-05") {
          headers["Mcp-Protocol-Version"] = "2024-11-05";
        }

        const res = await fetch(apiUrl, {
          method: "POST",
          headers,
          body: bodyToSend,
        });

        if (res.status === 202) {
          // Accepted notification
          continue;
        }

        const text = await res.text();
        if (text && !isNotification) {
          io.stdout.write(text.trim() + "\n");
        }
      } catch (err) {
        io.stderr.write(`[mcp-stdio] Forwarding failed: ${err instanceof Error ? err.message : String(err)}\n`);
        if (!isNotification) {
          io.stdout.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              error: { code: -32603, message: "Internal error forwarding request" },
            }) + "\n",
          );
        }
      }
    } else if (options.inProcessHandler) {
      const resp = await options.inProcessHandler(trimmed);
      if (resp && !isNotification) {
        io.stdout.write(resp.trim() + "\n");
      }
    } else {
      io.stderr.write(`[mcp-stdio] No running API server found at ${join(home, "run", "api.json")}\n`);
      if (!isNotification) {
        io.stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code: -32603, message: "MCP server unavailable: no running API server found" },
          }) + "\n",
        );
      }
    }
  }

  io.stderr.write("[mcp-stdio] Stdio stream closed\n");
  return 0;
}
