# Advisory Tauri 3 / CEF canary

The nightly `desktop.yml` job applies `tauri3.patch` to its disposable checkout,
resolves a separate alpha lockfile, and compiles the actual shell with the CEF
runtime. Existing Tauri 2 plugins deliberately remain: compatibility failures
are useful migration evidence, not a release signal. No source or lockfile from
this experiment is published or committed. The job is allowed to fail and
retains its full build log. It does not run tests requiring downloaded CEF.

Exact experimental pins: [Tauri 3.0.0-alpha.3](https://docs.rs/crate/tauri/3.0.0-alpha.3)
and [tauri-runtime-cef 3.0.0-alpha.5](https://docs.rs/tauri-runtime-cef/3.0.0-alpha.5/tauri_runtime_cef/struct.Cef.html).
Local check: `git apply --check apps/desktop/canary/tauri3.patch`.

The separate advisory nightly repro job builds unsigned Linux x64 `.deb` bundles
twice in separate target directories, fixes SOURCE_DATE_EPOCH, and compares their
SHA-256. Differences remain visible as failures; it is not a release gate.
