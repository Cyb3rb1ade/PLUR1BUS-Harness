# Team core contract (TK)

The human `team.*` RPCs store bounded plans, immutable approval bindings and pending
commands. They do not call the transition function or execute actions. PT-4b owns
persistence, reconciliation, authenticated event construction and execution.

`rpc.schema.json` is the wire source. TypeScript is generated from it and Rust uses
`typify`; the native boundary additionally validates schema limits and closed objects.
The same fixtures under `packages/rpc-schema/fixtures` are consumed on both sides.
Plan and policy hashes use recursively key-sorted UTF-8 JSON with SHA-256.

## Checker inputs

`tools.team.check` receives a plan, repository file inventory, workflow contents and
an effective project policy. The Core must supply the complete inventory, including
unreadable workflows as `content: null`. No method reads the filesystem or opens a
network connection. Project path and branch restrictions only add protection.

Globs contain literal path segments, a whole-segment `*`, or `**` (zero or more
segments). Embedded wildcards such as `*.ts`, character classes, absolute paths and
traversal are refused. Explicit files or `src/*` express those scopes. The intersection
algorithm searches the product of two finite automata; it does not infer disjointness
from the current file inventory.

Workflow classification is deliberately conservative. JSON-form YAML is understood;
other YAML syntax, unreadable contents and push workflows with opaque executable jobs
are treated as potentially deploying. This can require extra confirmations. There is
no workflow execution, shell parsing, or unsafe claim that a test-named job cannot deploy.

`tools.team.diffcheck` prioritizes interface/shared restrictions over an overlapping
own declaration. `tools.team.impact` includes explicit dependencies, consumed provided
interfaces, declared ownership overlaps and supplied changed-file overlaps. Cross-section
impact or fan-out of five becomes wide; a closed lane is never downgraded.

Approvals bind plan hash, checker hash, composition hash, effective policy hash and scope.
A changed composition or policy invalidates prior approval. Project settings are stored
under `settings.collaboration.teams`; only the future human-authorized settings shell may
change them. Installed configuration supplies defaults, while project restrictions are
unioned with those defaults. Neither source can remove built-in protected classes.
