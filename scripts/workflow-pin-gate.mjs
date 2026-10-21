// HYG-016 (docs/ci.md): every `uses:` in a workflow is pinned to a full 40-hex commit SHA. Tag and branch refs
// (`@v4`, `@stable`, `@main`), known annotated tag objects and unpinned refs are rejected. Local actions (`./...`)
// and `docker://` images pinned by `@sha256:<64 hex>` digest are allowed. A trailing `# <tag>` comment is the
// repository's style but not required.
const USES = /^\s*(?:-\s+)?uses:\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))/;
const SHA_PIN = /^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[0-9a-f]{40}$/;
const DIGEST_PIN = /^docker:\/\/\S+@sha256:[0-9a-f]{64}$/;
// Offline denylist, not a general proof of Git object type. Add verified tag objects here with their peeled commit
// and a regression test. Verified 2026-10-21 with `git ls-remote https://github.com/pnpm/action-setup.git
// 'refs/tags/v6' 'refs/tags/v6^{}'`: v6 peels to 0977fd99725f1db4007ccb2928dbb4e90d06cc86.
const KNOWN_TAG_OBJECT_SHAS = new Set([
  "f520eceda224fe1a4aed5a2a27a194379a409996", // pnpm/action-setup v6
]);

export function workflowPinFindings(text) {
  const findings = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const m = USES.exec(line);
    if (!m) return;
    const ref = m[1] ?? m[2] ?? m[3];
    if (ref.startsWith("./") || DIGEST_PIN.test(ref)) return;
    if (SHA_PIN.test(ref) && !KNOWN_TAG_OBJECT_SHAS.has(ref.slice(ref.lastIndexOf("@") + 1))) return;
    findings.push({ line: i + 1, ref });
  });
  return findings;
}
