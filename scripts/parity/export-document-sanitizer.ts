import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { buildDocumentHtml } from "../../packages/documents/src/templates.ts";
import { markdownToHtml } from "../../packages/documents/src/markdown.ts";
import { sanitizeHtml } from "../../packages/documents/src/sanitize.ts";
import { NEUTRAL_KIT } from "../../packages/documents/src/tokens.ts";
import { exporterMain } from "./lib.mjs";

export function recordDocumentSanitizer() {
  const templates = ["report", "letter", "invoice", "cv", "slides"] as const;
  const samples = [
    "<script>alert(1)</script>",
    "\"><img src=x onerror=alert(1)>",
    "<img src=file:///etc/passwd>",
    "</style><style>@import url(http://127.0.0.1:9/x.css)</style>",
    "javascript:alert(1)",
    "<iframe src=\"file:///etc/hosts\"></iframe>",
    "<object data=\"http://169.254.169.254/\"></object>",
    "x' style='background:url(http://127.0.0.1:9/)",
    "[click](javascript:alert(1)) [ok](http://a.example/\"onmouseover=\"x) [frag](#a\"b) ![i](file:///etc/passwd)",
    "**<b>**`<i>`*</em><script>*\n```\n</code></pre><script>x</script>\n```\n> <svg onload=x>\n# <h1>",
  ];
  const cases = templates.flatMap(template => samples.map(markdown => {
    const escaped = markdownToHtml(markdown);
    const sanitized = sanitizeHtml(escaped);
    // The offline document renderer strips remote link destinations before assembly.
    const offlineBody = escaped.replace(/(<a) href="https?:[^"]*"/gi, "$1");
    const options = {
      title: markdown, subtitle: markdown, kit: NEUTRAL_KIT,
      meta: {
        title: markdown, author: markdown, date: markdown, from: markdown, to: markdown,
        subject: markdown, salutation: markdown, closing: markdown, role: markdown, total: markdown,
        lineItems: [{ label: markdown, amount: markdown }],
      },
    };
    return {
      input: { template, markdown },
      escaped,
      sanitized,
      escapedTemplateSha256: createHash("sha256")
        .update(buildDocumentHtml(template, { ...options, bodyHtml: offlineBody })).digest("hex"),
      typescriptSha256: createHash("sha256")
        .update(buildDocumentHtml(template, { ...options, bodyHtml: sanitized })).digest("hex"),
      ...(offlineBody === sanitized ? {} : { expectedDivergence: "P4D-252" }),
    };
  }));
  return { sanitizer: { source: "packages/documents/src/sanitize.ts", cases } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await exporterMain({ area: "documents", build: recordDocumentSanitizer });
}
