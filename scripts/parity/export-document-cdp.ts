import { fileURLToPath } from "node:url";
import { captureFullPagePng, captureScreenshot, printToPdf } from "../../packages/documents/src/chromium.ts";
import type { CdpClient } from "../../packages/documents/src/chromium.ts";
import { exporterMain } from "./lib.mjs";

const PDF = Buffer.from("%PDF-1.7\nfixture");
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export async function recordDocumentCdp() {
  const cases = [];
  for (const name of ["pdf", "screenshot", "full-page", "cancelled"] as const) {
    const commands: unknown[] = [];
    const controller = new AbortController();
    if (name === "cancelled") controller.abort();
    const cdp: CdpClient = {
      async call<R>(method: string, params?: Record<string, unknown>) {
        commands.push({ method, params: params ?? {} });
        const response = method === "Runtime.evaluate" ? { result: { value: 1500 } }
          : method === "Page.printToPDF" ? { data: PDF.toString("base64") }
          : method === "Page.captureScreenshot" ? { data: PNG.toString("base64") }
          : {};
        return response as R;
      },
      close() {},
    };
    let expected;
    try {
      const bytes = name === "full-page" ? await captureFullPagePng(cdp)
        : name === "screenshot" ? await captureScreenshot(cdp)
        : await printToPdf(cdp, controller.signal);
      expected = { bytes: [...bytes] };
    } catch (error) {
      if (!controller.signal.aborted) throw error;
      expected = { error: "cancelled" };
    }
    cases.push({ name, commands, expected });
  }
  return { cdp: { source: "packages/documents/src/chromium.ts", cases } };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await exporterMain({ area: "documents", build: recordDocumentCdp });
}
