//! The package store for the two inert extension kinds, `mcp-server` and `provider` (spec 2026-09-27 §5.2, §6.4, §8.4;
//! X2 / D1). Not wired to RPC or the CLI yet: the first consumer is the later task that runs MCP servers and reads
//! provider declarations; until then nothing here enables, starts or reads an installed package.
//!
//! Each extension lives in its own directory, `<home>/extensions/packages/<name>/`: the package tree exactly as
//! extracted (`p1x.json`, `p1x.json.minisig`, `payload/…`) plus `record.json` (id, version, kind, package SHA-256,
//! trust, declared rights, the `files` map). The directory appears whole or not at all:
//!
//! 1. [`plur1bus_ext::verify::inspect_file_kinds`] audits the package (zip structure, traversal, symlinks, size, count
//!    and ratio caps from the caller's `Policy`, signature, manifest, per-kind rules, every file's SHA-256).
//! 2. The package is extracted with the one verified extractor into `packages/.staging/<name>-<nonce>/`.
//! 3. [`super::stage::check_tree`] checks the extracted tree against `files` again (no symlink or special file, the
//!    file set, sizes and hashes), so what lies on disk is what was audited.
//! 4. `record.json` is written into the staging directory.
//! 5. A replaced package's directory moves aside, the staging directory is renamed to `packages/<name>/`, the old one
//!    is removed. A failure at any step puts everything back (`packages/` ends as it was).
//!
//! A killed process leaves only `.staging/` entries (and, between the two renames of a replace, the old package
//! under its aside name); [`PackageStore::recover`] finishes or removes them. Seam `PLUR1BUS_TEST_EXT_FAIL_AT` with
//! the points `extract`, `verify`, `record`, `swap`, `commit` and `uninstall.trash` (`kill:<point>` leaves what a
//! killed process would).
use super::commit::{fail_at, killed, reset_kill};
use super::stage::check_tree;
use super::state::{
    remove_dir_all_retrying, remove_empty_dir_retrying, rename_retrying, write_private_atomic,
};
use super::{now_iso, ExtError};
use crate::install::archive;
use plur1bus_ext::manifest::{valid_name, Kind, P1xManifest};
use plur1bus_ext::refusal::reason;
use plur1bus_ext::rights::{declared_rights, Right};
use plur1bus_ext::trust::Tier;
use plur1bus_ext::verify::{inspect_file_kinds, Policy, X2_KINDS};
use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

const RECORD: &str = "record.json";
const STAGING: &str = ".staging";

/// What the person acknowledged (X1's flags, same meaning): without them an unsigned or unknown-signer package, or a
/// lower version of an installed one, is refused with `E_APPROVAL_REQUIRED acknowledge-<x>` and nothing is written.
#[derive(Clone, Debug, Default)]
pub struct InstallOpts {
    pub allow_unsigned: bool,
    pub allow_unknown_signer: bool,
    pub allow_downgrade: bool,
}

/// What an install did.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Installed {
    pub name: String,
    pub id: String,
    pub version: String,
    pub kind: String,
    /// An older or equal version of the same id was replaced.
    pub replaced: bool,
    /// The identical package (same id and SHA-256) was already installed: nothing was written.
    pub unchanged: bool,
    pub rights: Vec<Right>,
}

#[cfg(test)]
type StageHook = Box<dyn Fn(&Path)>;

pub struct PackageStore {
    root: PathBuf,
    /// Test seam: runs on the extracted staging tree before it is checked.
    #[cfg(test)]
    after_extract: Option<StageHook>,
    /// Test seam: the step that fails (the env seam `PLUR1BUS_TEST_EXT_FAIL_AT` needs a process-wide variable).
    #[cfg(test)]
    fail: Option<&'static str>,
    /// Test seam: this store ignores the process-wide seams (`PLUR1BUS_TEST_EXT_FAIL_AT` and the kill flag it sets).
    /// `tests/ext_commit.rs` and its siblings include this file, so the unit tests below share a process with tests
    /// that set them, and a kill seam raised by one of those used to make an install here skip its rollback.
    #[cfg(test)]
    isolated: bool,
}

fn io_err(what: &str, p: &Path, e: &std::io::Error) -> ExtError {
    ExtError::new("E_INTERNAL", "io", format!("{what} {}: {e}", p.display()))
}

fn kind_str(k: Kind) -> &'static str {
    match k {
        Kind::McpServer => "mcp-server",
        Kind::Provider => "provider",
        Kind::Skill => "skill",
        Kind::Module => "module",
        Kind::Channel => "channel",
        Kind::Bundle => "bundle",
    }
}

fn nonce() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..12].to_string()
}

/// What a failed install has to put back, in reverse: `new` (the staging directory or the placed package), `aside`
/// (the replaced package's directory under its aside name), `old` (where it belongs).
#[derive(Default)]
struct Txn {
    staging: Option<PathBuf>,
    placed: Option<PathBuf>,
    aside: Option<(PathBuf, PathBuf)>,
}

impl Txn {
    fn rollback(&mut self) -> Vec<String> {
        let mut failed = Vec::new();
        if let Some(p) = self.placed.take() {
            if let Err(e) = remove_dir_all_retrying(&p) {
                failed.push(format!("{}: {e}", p.display()));
            }
        }
        if let Some((aside, old)) = self.aside.take() {
            if let Err(e) = rename_retrying(&aside, &old) {
                failed.push(format!("restore {}: {e}", old.display()));
            }
        }
        if let Some(s) = self.staging.take() {
            if let Err(e) = remove_dir_all_retrying(&s) {
                failed.push(format!("{}: {e}", s.display()));
            }
        }
        failed
    }
}

impl PackageStore {
    pub fn of(layout: &crate::paths::Layout) -> Self {
        Self::at(layout.extensions().join("packages"))
    }

    pub fn at(root: PathBuf) -> Self {
        PackageStore {
            root,
            #[cfg(test)]
            after_extract: None,
            #[cfg(test)]
            fail: None,
            #[cfg(test)]
            isolated: false,
        }
    }

    /// One named step of an install or uninstall: the test seams fail or pause it here.
    fn step(&self, point: &str) -> Result<(), ExtError> {
        #[cfg(test)]
        if self.fail == Some(point) {
            return Err(ExtError::new(
                "E_INTERNAL",
                "io",
                format!("test seam: the {point} step failed"),
            ));
        }
        #[cfg(test)]
        if self.isolated {
            return Ok(());
        }
        fail_at(point)
    }

    /// The process-wide kill flag is reset by a real install; an isolated (unit test) store neither touches nor reads it.
    fn reset_kill(&self) {
        #[cfg(test)]
        if self.isolated {
            return;
        }
        reset_kill();
    }

    fn killed(&self) -> bool {
        #[cfg(test)]
        if self.isolated {
            return false;
        }
        killed()
    }

    fn staging(&self) -> PathBuf {
        self.root.join(STAGING)
    }

    fn dir_of(&self, name: &str) -> Result<PathBuf, ExtError> {
        if !valid_name(name) {
            return Err(ExtError::new(
                "E_INVALID_PARAMS",
                reason::PACKAGE_INVALID,
                format!("{name:?} is not a valid extension name"),
            ));
        }
        Ok(self.root.join(name))
    }

    /// The installed record of `name`, `None` when it is not installed.
    pub fn record(&self, name: &str) -> Result<Option<Value>, ExtError> {
        let p = self.dir_of(name)?.join(RECORD);
        match std::fs::read(&p) {
            Ok(b) => serde_json::from_slice(&b).map(Some).map_err(|e| {
                ExtError::new(
                    "E_STORAGE",
                    "state-invalid",
                    format!("{}: not JSON: {e}", p.display()),
                )
            }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(io_err("cannot read", &p, &e)),
        }
    }

    /// The names of the installed packages, sorted.
    pub fn names(&self) -> Result<Vec<String>, ExtError> {
        let mut out = Vec::new();
        let rd = match std::fs::read_dir(&self.root) {
            Ok(rd) => rd,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
            Err(e) => return Err(io_err("cannot read", &self.root, &e)),
        };
        for e in rd {
            let e = e.map_err(|e| io_err("cannot read", &self.root, &e))?;
            if let Some(n) = e.file_name().to_str().filter(|n| valid_name(n)) {
                if e.path().join(RECORD).is_file() {
                    out.push(n.to_string());
                }
            }
        }
        out.sort();
        Ok(out)
    }

    /// Installs the `.p1x` at `pkg` (see the module documentation). Returns what was done, or the refusal; on a
    /// refusal or failure the store is as it was before the call.
    pub fn install(
        &self,
        pkg: &Path,
        policy: &Policy,
        opts: &InstallOpts,
    ) -> Result<Installed, ExtError> {
        self.reset_kill();
        let insp = inspect_file_kinds(pkg, policy, &X2_KINDS)?;
        let m = &insp.manifest;
        if !matches!(m.kind, Kind::McpServer | Kind::Provider) {
            return Err(ExtError::new(
                "E_NOT_AVAILABLE",
                reason::KIND_UNSUPPORTED,
                format!(
                    "{} packages are installed with `skill install` or `plugin install`, not into the package store",
                    kind_str(m.kind)
                ),
            ));
        }
        // RULING: the same acknowledgments as X1 (unsigned, unknown signer, downgrade); none is implied.
        match insp.trust.tier {
            Tier::Unsigned if !opts.allow_unsigned => {
                return Err(approval("acknowledge-unsigned", "the package is unsigned"))
            }
            Tier::UnknownSigner if !opts.allow_unknown_signer => {
                return Err(approval(
                    "acknowledge-unknown-signer",
                    "the package is signed by a key this harness does not trust",
                ))
            }
            _ => {}
        }
        let dir = self.dir_of(&m.name)?;
        let prev = self.record(&m.name)?;
        if let Some(p) = &prev {
            if p["id"] != m.id.as_str() {
                return Err(ExtError::new(
                    "E_CONFLICT",
                    "name-taken",
                    format!(
                        "the name {:?} is installed by {}, not {}",
                        m.name,
                        p["id"].as_str().unwrap_or("?"),
                        m.id
                    ),
                ));
            }
            if p["packageSha256"] == insp.sha256.as_str() {
                return Ok(installed(m, true, true));
            }
            let lower = p["version"]
                .as_str()
                .and_then(|v| semver::Version::parse(v).ok())
                .zip(semver::Version::parse(&m.version).ok())
                .is_some_and(|(old, new)| new < old);
            if lower && !opts.allow_downgrade {
                return Err(approval(
                    "acknowledge-downgrade",
                    "the installed version is higher",
                ));
            }
        }

        let mut tx = Txn::default();
        match self.run(
            pkg,
            &insp.sha256,
            &insp.trust,
            m,
            &dir,
            prev.is_some(),
            &mut tx,
        ) {
            Ok(()) => Ok(installed(m, false, prev.is_some())),
            Err(mut e) => {
                if self.killed() {
                    return Err(e); // a killed process undoes nothing; `recover` does
                }
                let failed = tx.rollback();
                self.prune_empty();
                if !failed.is_empty() {
                    e.message = format!(
                        "{}; the rollback also failed: {}",
                        e.message,
                        failed.join("; ")
                    );
                }
                Err(e)
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn run(
        &self,
        pkg: &Path,
        sha256: &str,
        trust: &plur1bus_ext::trust::Trust,
        m: &P1xManifest,
        dir: &Path,
        replacing: bool,
        tx: &mut Txn,
    ) -> Result<(), ExtError> {
        let staging_root = self.staging();
        std::fs::create_dir_all(&staging_root)
            .map_err(|e| io_err("cannot create", &staging_root, &e))?;
        let tag = nonce();
        let stage = staging_root.join(format!("{}-{tag}", m.name));
        tx.staging = Some(stage.clone());
        archive::extract(pkg, &stage, 0).map_err(|e| {
            let code = if e.reason() == "io" {
                "E_INTERNAL"
            } else {
                "E_INVALID_PARAMS"
            };
            ExtError::new(code, e.reason(), e.to_string())
        })?;
        self.step("extract")?;
        #[cfg(test)]
        if let Some(hook) = &self.after_extract {
            hook(&stage);
        }
        check_tree(&stage, m)?;
        self.step("verify")?;

        let record = json!({
            "schema": "ext-package/1",
            "id": m.id, "name": m.name, "version": m.version, "kind": kind_str(m.kind),
            "packageSha256": sha256,
            "trust": { "tier": trust.tier, "keyId": trust.key_id, "label": trust.key_label },
            "installedAt": now_iso(),
            "rights": declared_rights(m),
            "capabilities": m.capabilities,
            "files": m.files,
        });
        let mut text = serde_json::to_string_pretty(&record).unwrap_or_default();
        text.push('\n');
        let rp = stage.join(RECORD);
        write_private_atomic(&rp, text.as_bytes()).map_err(|e| io_err("cannot write", &rp, &e))?;
        self.step("record")?;

        if replacing {
            let aside = staging_root.join(format!("{}-old-{tag}", m.name));
            rename_retrying(dir, &aside).map_err(|e| io_err("cannot move aside", dir, &e))?;
            tx.aside = Some((aside, dir.to_path_buf()));
        }
        self.step("swap")?;
        rename_retrying(&stage, dir).map_err(|e| io_err("cannot move into place", &stage, &e))?;
        tx.staging = None;
        tx.placed = Some(dir.to_path_buf());
        self.step("commit")?;

        // Committed: what is left is clean-up, and its failure never fails the install (`recover` finishes it).
        tx.placed = None;
        if let Some((aside, _)) = tx.aside.take() {
            let _ = remove_dir_all_retrying(&aside);
        }
        self.prune_empty();
        Ok(())
    }

    /// Removes the package directory of `name`. It moves out of sight in one rename, then is deleted; `Ok(false)` when
    /// it was not installed. `data/ext/<name>/` is not this store's and stays (X1-R31).
    pub fn uninstall(&self, name: &str) -> Result<bool, ExtError> {
        self.reset_kill();
        let dir = self.dir_of(name)?;
        if std::fs::symlink_metadata(&dir).is_err() {
            return Ok(false);
        }
        let staging_root = self.staging();
        std::fs::create_dir_all(&staging_root)
            .map_err(|e| io_err("cannot create", &staging_root, &e))?;
        let gone = staging_root.join(format!("{name}-gone-{}", nonce()));
        rename_retrying(&dir, &gone).map_err(|e| io_err("cannot move", &dir, &e))?;
        if let Err(e) = self.step("uninstall.trash") {
            if !self.killed() {
                let _ = rename_retrying(&gone, &dir);
                self.prune_empty();
            }
            return Err(e);
        }
        let _ = remove_dir_all_retrying(&gone);
        self.prune_empty();
        Ok(true)
    }

    /// Reconciles what a killed install or uninstall left in `.staging/`: a replaced package under its aside name
    /// goes back when its directory is missing (else it is removed); every other entry is removed.
    pub fn recover(&self) -> Result<(), ExtError> {
        let sd = self.staging();
        let rd = match std::fs::read_dir(&sd) {
            Ok(rd) => rd,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(io_err("cannot read", &sd, &e)),
        };
        for e in rd.flatten() {
            let path = e.path();
            let fname = e.file_name().to_string_lossy().into_owned();
            if let Some((name, _)) = fname.split_once("-old-") {
                let home = self.root.join(name);
                if valid_name(name)
                    && std::fs::symlink_metadata(&home).is_err()
                    && path.join(RECORD).is_file()
                {
                    rename_retrying(&path, &home)
                        .map_err(|e| io_err("cannot restore", &home, &e))?;
                    continue;
                }
            }
            remove_dir_all_retrying(&path).map_err(|e| io_err("cannot remove", &path, &e))?;
        }
        self.prune_empty();
        Ok(())
    }

    /// Removes `.staging/` and `packages/` when empty, so a refusal leaves `extensions/` as it was.
    fn prune_empty(&self) {
        let _ = remove_empty_dir_retrying(&self.staging());
        let _ = remove_empty_dir_retrying(&self.root);
    }
}

fn approval(reason: &'static str, why: &str) -> ExtError {
    ExtError::new("E_APPROVAL_REQUIRED", reason, why)
}

fn installed(m: &P1xManifest, unchanged: bool, replaced: bool) -> Installed {
    Installed {
        name: m.name.clone(),
        id: m.id.clone(),
        version: m.version.clone(),
        kind: kind_str(m.kind).into(),
        replaced: replaced && !unchanged,
        unchanged,
        rights: declared_rights(m),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use plur1bus_ext::compat::HostFacts;
    use plur1bus_ext::pack::PayloadFile;
    use plur1bus_ext::testkit::{build_package_from, tamper, test_key, Tamper, TestKey};
    use plur1bus_ext::trust::TrustStore;
    use plur1bus_ext::zipaudit::Limits;

    fn host() -> HostFacts {
        HostFacts {
            harness_version: "0.3.0".into(),
            module_api_current: 1,
            rpc_version: "1.4.0".into(),
            platform: None,
            container: false,
        }
    }

    fn no_revocations(_: &str, _: &str) -> Option<String> {
        None
    }

    fn base(name: &str, kind: &str, version: &str) -> Value {
        json!({
            "$schema": "https://plur1bus.app/schema/p1x/1/p1x.schema.json",
            "format": 1, "id": format!("demo/{name}"), "name": name, "version": version, "kind": kind,
            "title": { "en": "Demo" }, "summary": { "en": "A demo." },
            "publisher": { "id": "demo", "name": "Demo" }, "licence": "MIT",
            "compat": { "harness": ">=0.0.0" },
            "requires": { "runtime": { "type": "none" } },
            "capabilities": {
                "network": { "mode": "none" }, "filesystem": [],
                "processes": { "spawn": false }, "harness": { "authority": "none" }
            }
        })
    }

    fn mcp(version: &str) -> Value {
        let mut t = base("crm", "mcp-server", version);
        t["remote"] = json!({ "url": "https://mcp.example.org/v1", "auth": "none" });
        t["capabilities"]["network"] = json!({ "mode": "allowlist", "hosts": ["mcp.example.org"] });
        t
    }

    fn provider() -> Value {
        let mut t = base("acme", "provider", "1.0.0");
        t["provider"] =
            json!({ "api": "chat_completions", "baseUrl": "https://api.acme.example/v1" });
        t["capabilities"]["network"] =
            json!({ "mode": "allowlist", "hosts": ["api.acme.example"] });
        t
    }

    fn files(body: &str) -> Vec<PayloadFile> {
        vec![
            PayloadFile {
                rel: "README.md".into(),
                bytes: body.as_bytes().to_vec(),
                exec: false,
            },
            PayloadFile {
                rel: "docs/notes.md".into(),
                bytes: b"notes".to_vec(),
                exec: false,
            },
        ]
    }

    /// A store that ignores the process-wide test seams (see `PackageStore::isolated`).
    fn store(root: PathBuf) -> PackageStore {
        let mut s = PackageStore::at(root);
        s.isolated = true;
        s
    }

    struct Env {
        _dir: tempfile::TempDir,
        root: PathBuf,
        key: TestKey,
        store: TrustStore,
    }

    impl Env {
        fn new() -> Env {
            let dir = tempfile::tempdir().unwrap();
            let key = test_key("test");
            let store = TrustStore::with_test_keys(
                true,
                Some(&format!("{}={}", key.label, key.public_b64)),
            )
            .unwrap();
            Env {
                root: dir.path().join("extensions").join("packages"),
                _dir: dir,
                key,
                store,
            }
        }

        fn write(&self, name: &str, bytes: &[u8]) -> PathBuf {
            let p = self._dir.path().join(name);
            std::fs::write(&p, bytes).unwrap();
            p
        }

        fn signed(&self, t: &Value, body: &str) -> PathBuf {
            self.write(
                &format!(
                    "pkg-{}-{}-{body}.p1x",
                    t["id"].as_str().unwrap().replace('/', "_"),
                    t["version"].as_str().unwrap()
                ),
                &build_package_from(t, files(body), Some(&self.key)),
            )
        }

        fn policy_with<'a>(&'a self, host: &'a HostFacts, limits: Limits) -> Policy<'a> {
            Policy {
                limits,
                skill_bytes: 1 << 20,
                store: &self.store,
                host,
                reserved: &["core"],
                revoked: &no_revocations,
            }
        }

        fn install(
            &self,
            st: &PackageStore,
            pkg: &Path,
            opts: &InstallOpts,
        ) -> Result<Installed, ExtError> {
            let h = host();
            st.install(pkg, &self.policy_with(&h, Limits::default()), opts)
        }

        /// No directory of the extension store holds anything but the named packages.
        fn assert_clean(&self, names: &[&str]) {
            let mut seen: Vec<String> = match std::fs::read_dir(&self.root) {
                Ok(rd) => rd
                    .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                    .collect(),
                Err(_) => vec![],
            };
            seen.sort();
            assert_eq!(seen, names, "leftovers under {}", self.root.display());
        }
    }

    fn reason_of(e: &ExtError) -> &str {
        e.reason.unwrap_or("")
    }

    #[test]
    fn a_remote_mcp_server_installs_into_its_own_directory() {
        let env = Env::new();
        let st = store(env.root.clone());
        let got = env
            .install(
                &st,
                &env.signed(&mcp("1.0.0"), "r1"),
                &InstallOpts::default(),
            )
            .unwrap();
        assert_eq!(
            (
                got.name.as_str(),
                got.kind.as_str(),
                got.replaced,
                got.unchanged
            ),
            ("crm", "mcp-server", false, false)
        );
        let dir = env.root.join("crm");
        assert!(dir.join("p1x.json").is_file() && dir.join("p1x.json.minisig").is_file());
        assert_eq!(std::fs::read(dir.join("payload/README.md")).unwrap(), b"r1");
        let rec = st.record("crm").unwrap().unwrap();
        assert_eq!(
            (rec["id"].as_str(), rec["version"].as_str()),
            (Some("demo/crm"), Some("1.0.0"))
        );
        assert_eq!(rec["trust"]["tier"], "first-party");
        let rights: Vec<&str> = rec["rights"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["id"].as_str().unwrap())
            .collect();
        assert_eq!(
            rights,
            [
                "network:host:mcp.example.org",
                "remote:https://mcp.example.org/v1"
            ]
        );
        assert_eq!(st.names().unwrap(), ["crm"]);
        env.assert_clean(&["crm"]);
    }

    #[test]
    fn a_provider_installs_and_unsigned_needs_the_acknowledgment() {
        let env = Env::new();
        let st = store(env.root.clone());
        let pkg = env.write("u.p1x", &build_package_from(&provider(), files("x"), None));
        let e = env.install(&st, &pkg, &InstallOpts::default()).unwrap_err();
        assert_eq!(
            (e.code, reason_of(&e)),
            ("E_APPROVAL_REQUIRED", "acknowledge-unsigned")
        );
        assert!(!env.root.exists(), "a refusal writes nothing");
        let opts = InstallOpts {
            allow_unsigned: true,
            ..Default::default()
        };
        let got = env.install(&st, &pkg, &opts).unwrap();
        assert_eq!(got.kind, "provider");
        assert_eq!(
            st.record("acme").unwrap().unwrap()["trust"]["tier"],
            "unsigned"
        );
    }

    #[test]
    fn a_skill_is_not_a_package_store_kind() {
        let env = Env::new();
        let st = store(env.root.clone());
        let t = base("demo", "skill", "1.0.0");
        let pkg = env.write(
            "s.p1x",
            &build_package_from(
                &t,
                vec![PayloadFile {
                    rel: "SKILL.md".into(),
                    bytes: b"---\nname: demo\ndescription: d\n---\n".to_vec(),
                    exec: false,
                }],
                Some(&env.key),
            ),
        );
        let e = env.install(&st, &pkg, &InstallOpts::default()).unwrap_err();
        assert_eq!(
            (e.code, reason_of(&e)),
            ("E_NOT_AVAILABLE", "kind-unsupported")
        );
        assert!(!env.root.exists());
    }

    #[test]
    fn zip_slip_symlink_and_checksum_tampering_are_refused_and_write_nothing() {
        let env = Env::new();
        let st = store(env.root.clone());
        let good = build_package_from(&mcp("1.0.0"), files("r1"), Some(&env.key));
        for (how, want) in [
            (Tamper::DotDot, "archive-unsafe-entry"),
            (Tamper::Symlink, "archive-unsafe-entry"),
            (Tamper::PayloadByte, "digest-mismatch"),
            (Tamper::ExtraEntry, "package-invalid"),
            (Tamper::CaseCollision, "archive-unsafe-entry"),
        ] {
            let pkg = env.write("t.p1x", &tamper(&good, how));
            let e = env.install(&st, &pkg, &InstallOpts::default()).unwrap_err();
            assert_eq!(reason_of(&e), want, "{how:?}: {e}");
            assert!(!env.root.exists(), "{how:?} left {}", env.root.display());
        }
        assert!(!env._dir.path().join("evil").exists());
    }

    #[test]
    fn a_tree_that_changes_between_audit_and_install_is_refused() {
        let env = Env::new();
        let mut st = store(env.root.clone());
        st.after_extract = Some(Box::new(|stage| {
            std::fs::write(stage.join("payload/README.md"), b"swapped").unwrap();
        }));
        let e = env
            .install(
                &st,
                &env.signed(&mcp("1.0.0"), "r1"),
                &InstallOpts::default(),
            )
            .unwrap_err();
        assert_eq!(reason_of(&e), "digest-mismatch", "{e}");
        assert!(!env.root.exists());
        st.after_extract = Some(Box::new(|stage| {
            std::fs::write(stage.join("payload/extra.bin"), b"x").unwrap();
        }));
        let e = env
            .install(
                &st,
                &env.signed(&mcp("1.0.0"), "r1"),
                &InstallOpts::default(),
            )
            .unwrap_err();
        assert_eq!(reason_of(&e), "package-invalid", "{e}");
        assert!(!env.root.exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_that_appears_in_the_staged_tree_is_refused() {
        let env = Env::new();
        let mut st = store(env.root.clone());
        st.after_extract = Some(Box::new(|stage| {
            let p = stage.join("payload/README.md");
            std::fs::remove_file(&p).unwrap();
            std::os::unix::fs::symlink("/etc/hostname", &p).unwrap();
        }));
        let e = env
            .install(
                &st,
                &env.signed(&mcp("1.0.0"), "r1"),
                &InstallOpts::default(),
            )
            .unwrap_err();
        assert_eq!(reason_of(&e), "archive-unsafe-entry", "{e}");
        assert!(!env.root.exists());
    }

    #[test]
    fn file_count_and_size_limits_refuse_before_anything_is_extracted() {
        let env = Env::new();
        let st = store(env.root.clone());
        let pkg = env.signed(&mcp("1.0.0"), "r1");
        let h = host();
        for limits in [
            Limits {
                max_entries: 2,
                ..Limits::default()
            },
            Limits {
                entry_bytes: 3,
                ..Limits::default()
            },
            Limits {
                package_bytes: 100,
                ..Limits::default()
            },
        ] {
            let e = st
                .install(
                    &pkg,
                    &env.policy_with(&h, limits.clone()),
                    &InstallOpts::default(),
                )
                .unwrap_err();
            assert_eq!(reason_of(&e), "download-too-large", "{limits:?}: {e}");
            assert!(!env.root.exists());
        }
    }

    #[test]
    fn a_half_install_is_rolled_back_at_every_step() {
        for point in ["extract", "verify", "record", "swap", "commit"] {
            // A fresh install leaves nothing.
            let env = Env::new();
            let mut st = store(env.root.clone());
            st.fail = Some(point);
            let e = env
                .install(
                    &st,
                    &env.signed(&mcp("1.0.0"), "r1"),
                    &InstallOpts::default(),
                )
                .unwrap_err();
            assert_eq!(reason_of(&e), "io", "{point}: {e}");
            assert!(!env.root.exists(), "{point} left {}", env.root.display());

            // A replace keeps the old package byte for byte.
            let mut st = store(env.root.clone());
            env.install(
                &st,
                &env.signed(&mcp("1.0.0"), "r1"),
                &InstallOpts::default(),
            )
            .unwrap();
            st.fail = Some(point);
            let e = env
                .install(
                    &st,
                    &env.signed(&mcp("2.0.0"), "r2"),
                    &InstallOpts::default(),
                )
                .unwrap_err();
            assert_eq!(reason_of(&e), "io", "{point}: {e}");
            assert_eq!(
                std::fs::read(env.root.join("crm/payload/README.md")).unwrap(),
                b"r1",
                "{point}"
            );
            assert_eq!(
                st.record("crm").unwrap().unwrap()["version"],
                "1.0.0",
                "{point}"
            );
            env.assert_clean(&["crm"]);
        }
    }

    #[test]
    fn replace_downgrade_identical_and_name_taken() {
        let env = Env::new();
        let st = store(env.root.clone());
        let v1 = env.signed(&mcp("1.0.0"), "r1");
        env.install(&st, &v1, &InstallOpts::default()).unwrap();
        let again = env.install(&st, &v1, &InstallOpts::default()).unwrap();
        assert!(again.unchanged && !again.replaced);

        let v2 = env.signed(&mcp("2.0.0"), "r2");
        let up = env.install(&st, &v2, &InstallOpts::default()).unwrap();
        assert!(up.replaced);
        assert_eq!(
            std::fs::read(env.root.join("crm/payload/README.md")).unwrap(),
            b"r2"
        );
        env.assert_clean(&["crm"]);

        let e = env.install(&st, &v1, &InstallOpts::default()).unwrap_err();
        assert_eq!(
            (e.code, reason_of(&e)),
            ("E_APPROVAL_REQUIRED", "acknowledge-downgrade")
        );
        let down = env
            .install(
                &st,
                &v1,
                &InstallOpts {
                    allow_downgrade: true,
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(down.replaced);
        assert_eq!(st.record("crm").unwrap().unwrap()["version"], "1.0.0");

        let mut other = mcp("1.0.0");
        other["id"] = json!("other/crm");
        other["publisher"] = json!({ "id": "other", "name": "Other" });
        let e = env
            .install(&st, &env.signed(&other, "x"), &InstallOpts::default())
            .unwrap_err();
        assert_eq!((e.code, reason_of(&e)), ("E_CONFLICT", "name-taken"));
    }

    #[test]
    fn uninstall_removes_the_directory_and_is_undone_by_a_failure() {
        let env = Env::new();
        let mut st = store(env.root.clone());
        env.install(
            &st,
            &env.signed(&mcp("1.0.0"), "r1"),
            &InstallOpts::default(),
        )
        .unwrap();
        st.fail = Some("uninstall.trash");
        assert!(st.uninstall("crm").is_err());
        assert!(env.root.join("crm/record.json").is_file());
        env.assert_clean(&["crm"]);
        st.fail = None;
        assert!(st.uninstall("crm").unwrap());
        assert!(!env.root.exists(), "the emptied store is pruned");
        assert!(!st.uninstall("crm").unwrap());
        assert_eq!(
            reason_of(&st.uninstall("../x").unwrap_err()),
            "package-invalid"
        );
    }

    #[test]
    fn recover_restores_a_replaced_package_and_removes_other_leftovers() {
        let env = Env::new();
        let st = store(env.root.clone());
        env.install(
            &st,
            &env.signed(&mcp("1.0.0"), "r1"),
            &InstallOpts::default(),
        )
        .unwrap();
        // A kill between the two renames of a replace: the old package under its aside name, no `crm/`.
        let sd = env.root.join(".staging");
        std::fs::create_dir_all(&sd).unwrap();
        std::fs::rename(env.root.join("crm"), sd.join("crm-old-abc")).unwrap();
        std::fs::create_dir_all(sd.join("crm-deadbeef/payload")).unwrap();
        std::fs::create_dir_all(sd.join("crm-gone-123")).unwrap();
        st.recover().unwrap();
        assert_eq!(st.record("crm").unwrap().unwrap()["version"], "1.0.0");
        env.assert_clean(&["crm"]);
        // An aside copy next to a present package is the stale one.
        std::fs::create_dir_all(sd.join("crm-old-zzz")).unwrap();
        st.recover().unwrap();
        env.assert_clean(&["crm"]);
    }
}
