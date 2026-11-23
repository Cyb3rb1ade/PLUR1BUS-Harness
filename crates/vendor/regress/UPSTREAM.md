# Local patch to regress 0.10.5

The source is the crates.io archive for regress 0.10.5, checksum
`2057b2325e68a893284d1538021ab90279adac1139957ca2a74426c6f118fb48`,
from upstream commit `f74c8c3723b0d351e1bba764f1a6000040d339e2`.
The original Apache-2.0 and MIT license files accompany the source. The
upstream copy is commit `fe7f884bbcf9b9bec4dbf5a6c5dd0f75cd70012a`.

R-K-33b adds one bounded UTF-16 API in `src/api.rs` and debits shared work
in `src/classicalbacktrack.rs`. The old constructors still use the
unmetered executor. R-K-37 returns the remaining steps to the bounded caller so
a single validation can share its budget. The step tests use ordinary
patterns and check each measured charge at its exact budget boundary. The standalone test lock resolves the same memchr and hashbrown
versions as the root lock.

When updating, first commit the new unmodified registry source and licenses.
Review and port the output of
`git diff fe7f884bbcf9b9bec4dbf5a6c5dd0f75cd70012a -- crates/vendor/regress/src/api.rs crates/vendor/regress/src/classicalbacktrack.rs`.
Run the upstream test suite with `--features utf16`, the tool-call validator
and its TypeScript vectors, and regenerate and check both attribution files.
Keep the crate outside workspace membership while pinning it in the workspace
patch table. To return to upstream, first update the one bounded caller to an
equivalent upstream API and then remove the Cargo patch.
