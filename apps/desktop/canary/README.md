# Advisory Tauri 3 / CEF canary

The nightly `desktop.yml` job applies `tauri3.patch` to its disposable checkout,
resolves a separate alpha lockfile, and compiles the actual shell with the CEF
runtime. Compile failures of the shell itself are useful migration evidence, not
a release signal. No source or lockfile from this experiment is published or
committed. The job is allowed to fail and retains its full build log. It does
not run tests requiring downloaded CEF.

The patch must move the whole Tauri family together, not only `tauri`: every
`tauri` release declares `links = "Tauri"`, so Cargo refuses a graph in which a
Tauri 2 plugin and Tauri 3 meet. The patch therefore pins `tauri`, `tauri-build`,
`tauri-runtime-cef` and the five plugins (updater, single-instance, deep-link,
autostart, notification) to one mutually compatible alpha set. A pin that the
other crates do not accept fails at resolution, before any source is compiled,
and then says nothing about the shell. Keep the set consistent when you bump it
(`tauri-runtime-cef` and the plugins each require a minimum `tauri` alpha), and
re-run `git apply --check apps/desktop/canary/tauri3.patch` after every change to
the lines the patch touches in `src-tauri/Cargo.toml` and `src-tauri/src/lib.rs`.

Exact experimental pins: [Tauri 3.0.0-alpha.5](https://docs.rs/crate/tauri/3.0.0-alpha.5),
`tauri-build` 3.0.0-alpha.4, [tauri-runtime-cef 3.0.0-alpha.6](https://docs.rs/tauri-runtime-cef/3.0.0-alpha.6/tauri_runtime_cef/struct.Cef.html)
and the plugins at 3.0.0-alpha.3.
Local check: `git apply --check apps/desktop/canary/tauri3.patch`.

Expected result today: the job stays red. On Linux the CEF runtime needs the GTK 4
development files (`libgtk-4-dev`, gtk4 >= 4.14) besides the packages the shell
already installs, and the shell itself does not yet build against Tauri 3: it names
`tauri::Wry` (`src-tauri/src/native.rs`), which Tauri 3 no longer exports, and calls
the Tauri 2 autostart extension (`src-tauri/src/controller/autostart.rs`). Those are
the migration findings, not defects of this repository.

The separate advisory nightly repro job builds unsigned Linux x64 `.deb` bundles
twice in separate target directories, fixes SOURCE_DATE_EPOCH, and compares their
SHA-256. Differences remain visible as failures; it is not a release gate.
tauri-bundler 2.10 ignores SOURCE_DATE_EPOCH and stamps the `.deb` (the three `ar`
members and every tar entry of `control.tar.gz` and `data.tar.gz`) with the build
clock, so two builds of identical bytes never hash alike. `scripts/tauri.mjs`
therefore runs `scripts/normalize-deb.mjs` after a successful `tauri build` whenever
SOURCE_DATE_EPOCH is set: it rewrites those timestamps to the epoch, sorts the tar
entries and recompresses with a fixed gzip stream, and leaves file contents, names
and modes untouched. Without SOURCE_DATE_EPOCH nothing changes. The release
packaging (`scripts/build-bundle.mjs`) does not call the wrapper.
