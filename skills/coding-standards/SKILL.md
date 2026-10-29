---
name: coding-standards
description: Default coding completion standards when the project has no more specific verifier conventions.
category: code.test
useWhen: Complete a coding task after checking the project's formatter, linter, type checks, tests and review requirements.
---

Use project conventions first. The coding gate detects Node/pnpm, Python, Rust,
Go and Java/Gradle and requires formatter, linter, typecheck/compiler and tests.
Missing programs/checks fail closed. Network is disabled unless committed
project conventions explicitly allow it. Never infer success from an agent's
report. Review is mandatory at 200 changed lines and binds the exact worktree
fingerprint. A project lead may explicitly override with an audited note.

A committed `.plur1bus-verifiers.json` can specify `commands` with four fixed
argv arrays: `format`, `lint`, `typecheck`, `test`; optional `networkAllowed` is
false by default. Command conventions changed by the delegate are refused until
a human reviews/commits them or explicitly overrides.
