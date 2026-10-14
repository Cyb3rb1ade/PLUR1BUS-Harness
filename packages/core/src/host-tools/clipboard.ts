import { which } from "./context.ts";
import { HostFailure, requireString } from "./errors.ts";
import { runChecked } from "./exec.ts";
import { asObject, CLIPBOARD_MAX_BYTES, type HostContext, type HostTool } from "./types.ts";

async function linuxClipboard(ctx: HostContext): Promise<{ read: string[]; write: string[]; program: string } | null> {
  if (await which(ctx, "wl-paste") && await which(ctx, "wl-copy")) {
    return { program: "wl", read: ["wl-paste"], write: ["wl-copy"] };
  }
  if (await which(ctx, "xclip")) {
    return { program: "xclip", read: ["xclip", "-selection", "clipboard", "-o"], write: ["xclip", "-selection", "clipboard"] };
  }
  if (await which(ctx, "xsel")) {
    return { program: "xsel", read: ["xsel", "--clipboard", "--output"], write: ["xsel", "--clipboard", "--input"] };
  }
  return null;
}

export const clipboardReadTool: HostTool = {
  name: "clipboard.read", capability: "clipboard.read", riskClass: "low",
  description: "Read the clipboard. Content is never written to logs.",
  schema: {
    input: { type: "object", additionalProperties: false, properties: {} },
    output: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
  },
  async run(_input, ctx) {
    asObject(_input);
    let r;
    if (ctx.platform === "darwin") {
      r = await runChecked(ctx, { program: "pbpaste", args: [] }, { code: "not_supported_on_platform", message: "the clipboard command failed" }, { whole: true });
    } else if (ctx.platform === "win32") {
      r = await runChecked(ctx, { program: "powershell", args: ["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard"] }, { code: "not_supported_on_platform", message: "the clipboard command failed" }, { whole: true });
    } else {
      const tool = await linuxClipboard(ctx);
      if (!tool) throw new HostFailure("not_found", "no clipboard tool (wl-paste, xclip or xsel) is available");
      r = await runChecked(ctx, { program: tool.read[0]!, args: tool.read.slice(1) }, { code: "not_supported_on_platform", message: "the clipboard command failed" }, { whole: true });
    }
    let text = r.stdout;
    if (text.endsWith("\r\n")) text = text.slice(0, -2);
    else if (text.endsWith("\n")) text = text.slice(0, -1);
    if (Buffer.byteLength(text, "utf8") > CLIPBOARD_MAX_BYTES) {
      throw new HostFailure("too_large", `clipboard exceeds ${CLIPBOARD_MAX_BYTES} bytes`);
    }
    return { text };
  },
};

export const clipboardWriteTool: HostTool = {
  name: "clipboard.write", capability: "clipboard.read", riskClass: "low",
  description: "Write the clipboard via stdin. Content is never logged and never placed on argv.",
  schema: {
    input: {
      type: "object", additionalProperties: false, required: ["text"],
      properties: { text: { type: "string" } },
    },
    output: { type: "object", required: ["bytes"], properties: { bytes: { type: "integer" } } },
  },
  async run(input, ctx) {
    const raw = asObject(input).text;
    if (typeof raw !== "string" || raw.includes("\0")) throw new HostFailure("invalid_input", "text must be a string");
    const bytes = Buffer.byteLength(raw, "utf8");
    if (bytes > CLIPBOARD_MAX_BYTES) throw new HostFailure("too_large", `clipboard exceeds ${CLIPBOARD_MAX_BYTES} bytes`);
    const text = raw;
    if (ctx.platform === "darwin") {
      await runChecked(ctx, { program: "pbcopy", args: [], stdin: text }, { code: "not_supported_on_platform", message: "the clipboard command failed" });
    } else if (ctx.platform === "win32") {
      await runChecked(ctx, {
        program: "powershell",
        args: ["-NoProfile", "-NonInteractive", "-Command", "Set-Clipboard -Value ([Console]::In.ReadToEnd())"],
        stdin: text,
      }, { code: "not_supported_on_platform", message: "the clipboard command failed" });
    } else {
      const tool = await linuxClipboard(ctx);
      if (!tool) throw new HostFailure("not_found", "no clipboard tool (wl-copy, xclip or xsel) is available");
      await runChecked(ctx, { program: tool.write[0]!, args: tool.write.slice(1), stdin: text }, { code: "not_supported_on_platform", message: "the clipboard command failed" });
    }
    return { bytes };
  },
};
