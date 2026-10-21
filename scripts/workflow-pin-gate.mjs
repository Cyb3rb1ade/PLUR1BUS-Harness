// HYG-016 (docs/ci.md): every `uses:` in a workflow is pinned to a full 40-hex commit SHA. Tag and branch refs
// (`@v4`, `@stable`, `@main`) and unpinned refs are rejected. Local actions (`./...`) and `docker://` images pinned
// by `@sha256:<64 hex>` digest are allowed. A trailing `# <tag>` comment is the repository's style but not required.
const USES = /^\s*(?:-\s+)?uses:\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))/;
const SHA_PIN = /^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[0-9a-f]{40}$/;
const DIGEST_PIN = /^docker:\/\/\S+@sha256:[0-9a-f]{64}$/;

export function workflowPinFindings(text) {
  const findings = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const m = USES.exec(line);
    if (!m) return;
    const ref = m[1] ?? m[2] ?? m[3];
    if (ref.startsWith("./") || SHA_PIN.test(ref) || DIGEST_PIN.test(ref)) return;
    findings.push({ line: i + 1, ref });
  });
  return findings;
}
