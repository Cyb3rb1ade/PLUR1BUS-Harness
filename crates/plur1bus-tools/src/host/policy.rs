use super::args;
use super::catalog::{Operation, Spec};
use super::{Config, Failure};
use crate::gate::{Classification, Classifier, GatedTool};
use plur1bus_canon::canonical_json;
use plur1bus_core::egress::read_url;
use plur1bus_core::policy::fs_paths::{
    canonicalise_path, Access, CanonicalPath, CanonicaliseOptions, PathFs, PathRoot,
};
use plur1bus_core::policy::paths::Nfc;
use plur1bus_core::toolcall::skill_tools::DENY_NAMES;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

/// Hostctl path resolution for a defined root set.
pub struct Policy<'a, F> {
    /// The configured roots.
    pub roots: &'a [PathRoot],
    /// Additional entries for this installation, in the shared path-policy format.
    pub deny: &'a [Value],
    /// The current user's home, when supplied by the host.
    pub home: Option<&'a str>,
    /// The file-system port.
    pub fs: &'a F,
    /// The existing Unicode normaliser used by path policy.
    pub nfc: &'a dyn Nfc,
}

pub(super) struct Prepared {
    pub paths: Vec<CanonicalPath>,
    pub url: Option<String>,
    pub access: Access,
}

impl Prepared {
    pub fn classification(&self) -> Classification {
        let paths = self
            .paths
            .iter()
            .map(|p| p.canonical().to_owned())
            .collect();
        let identity: Vec<_> = self.paths.iter().map(|p| p.json()).collect();
        let hash = Sha256::digest(canonical_json(&json!([identity, self.url])).as_bytes());
        Classification {
            flags: Map::from_iter([
                ("outsideRoots".to_owned(), json!(false)),
                (
                    "systemTree".to_owned(),
                    json!(self.paths.iter().any(CanonicalPath::system_tree)),
                ),
            ]),
            targets: Some(paths),
            access: Some(self.access.as_str()),
            hash_extra: Some(format!("{hash:x}")),
        }
    }
}

/// A classifier bound to a single registered Hostctl operation and the live path policy.
pub struct HostClassifier<'a, F> {
    pub(super) policy: &'a Policy<'a, F>,
    pub(super) config: &'a Config,
    pub(super) spec: Spec,
}

impl<'a, F: PathFs> HostClassifier<'a, F> {
    /// Resolve a registered tool for use at the K10a gate.
    pub fn new(name: &str, config: &'a Config, policy: &'a Policy<'a, F>) -> Option<Self> {
        let spec = Spec::get(name)?;
        config.enabled.then_some(Self {
            policy,
            config,
            spec,
        })
    }

    /// The policy definition uses the tool's catalogue capability and this classifier.
    pub fn definition(&self) -> GatedTool<'_> {
        GatedTool {
            name: self.spec.name,
            capability: self.spec.capability,
            effect: self.spec.effect(),
            risk: self.spec.risk(),
            classifier: Some(self),
        }
    }
}

impl<F: PathFs> Classifier for HostClassifier<'_, F> {
    fn classify(&self, args: &Value) -> Result<Classification, String> {
        let input = args::validate(self.config, self.spec, args).map_err(|e| e.hint)?;
        self.policy
            .prepare(self.spec.operation, input)
            .map(|p| p.classification())
            .map_err(|e| e.hint)
    }
}

impl<F: PathFs> Policy<'_, F> {
    pub(super) fn prepare(
        &self,
        op: Operation,
        input: &Map<String, Value>,
    ) -> Result<Prepared, Failure> {
        use Operation as O;
        let access = if matches!(
            op,
            O::Read | O::List | O::Search | O::Stat | O::Exec | O::Start | O::Shell | O::Open
        ) {
            Access::Read
        } else {
            Access::Write
        };
        let mut prepared = Prepared {
            paths: Vec::new(),
            url: None,
            access,
        };
        for key in ["path", "destination", "cwd"] {
            if let Some(raw) = input.get(key).and_then(Value::as_str) {
                let path = self.resolve(raw, access)?;
                if matches!(op, O::Mkdir | O::Copy | O::Move | O::Trash) {
                    self.check_namespace_leaf(raw, &path)?;
                    self.protect_roots(&path)?;
                }
                prepared.paths.push(path);
            }
        }
        if let Some(target) = input.get("target").and_then(Value::as_str) {
            let prefix = target.split_once("://").map(|(scheme, _)| scheme);
            if let Some(prefix) = prefix {
                if !prefix.eq_ignore_ascii_case("http") && !prefix.eq_ignore_ascii_case("https") {
                    return Err(Failure::denied(
                        "Only local documents or HTTP(S) URLs may be opened.",
                    ));
                }
                let url = read_url(target)
                    .filter(|url| {
                        matches!(url.scheme(), "http" | "https")
                            && url.has_host()
                            && url.username().is_empty()
                            && url.password().is_none()
                    })
                    .ok_or_else(|| Failure::denied("Use an HTTP(S) URL without credentials."))?;
                prepared.url = Some(url.to_string());
            } else {
                prepared.paths.push(self.resolve(target, Access::Read)?);
            }
        }
        Ok(prepared)
    }

    fn protect_roots(&self, target: &CanonicalPath) -> Result<(), Failure> {
        let folded = |path: &str| {
            if self.fs.platform() == "win32" {
                path.replace('\\', "/").to_lowercase()
            } else {
                path.to_owned()
            }
        };
        let checked = folded(target.canonical());
        let prefix = format!("{}/", checked.trim_end_matches('/'));
        for root in self.roots {
            let root = self.resolve(&root.path, Access::Read)?;
            let root = folded(root.canonical());
            if root == checked || root.starts_with(&prefix) {
                return Err(Failure::denied(
                    "Namespace operations cannot change a configured root or its parent.",
                ));
            }
        }
        Ok(())
    }

    fn check_namespace_leaf(&self, raw: &str, path: &CanonicalPath) -> Result<(), Failure> {
        use plur1bus_core::policy::fs_paths::{same_identity, FileKind, Identity};
        use std::path::Path;
        let raw = Path::new(raw);
        let lexical = if raw.is_absolute() {
            raw.to_owned()
        } else {
            let base = self.roots.first().ok_or_else(Failure::outside)?;
            Path::new(&base.path).join(raw)
        };
        let lexical = lexical.to_str().ok_or_else(Failure::outside)?;
        match self.fs.lstat(lexical) {
            Ok(st)
                if st.kind != FileKind::Symlink
                    && path.exists()
                    && same_identity(&Identity::of(&st), path.identity()) =>
            {
                Ok(())
            }
            Err(e) if e.code == "ENOENT" && !path.exists() => Ok(()),
            _ => Err(Failure::denied(
                "Namespace operations need a stable, non-link entry.",
            )),
        }
    }

    pub(super) fn resolve(&self, raw: &str, access: Access) -> Result<CanonicalPath, Failure> {
        let raw = if raw == "." {
            self.roots
                .first()
                .map(|root| root.path.as_str())
                .ok_or_else(Failure::outside)?
        } else {
            raw
        };
        let denied_component = |p: &str| {
            p.split(['/', '\\']).any(|part| {
                let folded = part.to_ascii_lowercase();
                folded == ".env" || folded.starts_with(".env.")
            })
        };
        if denied_component(raw) {
            return Err(Failure::denied(
                "Environment credential files cannot be accessed.",
            ));
        }
        if raw.starts_with("//")
            || raw.starts_with("\\\\")
            || raw.split(['/', '\\']).any(|part| part == "..")
        {
            return Err(Failure::outside());
        }
        let built_in =
            DENY_NAMES
                .iter()
                .copied()
                .chain(["api-owner.token", "core.token", "supervisor.token"]);
        let mut deny: Vec<_> = built_in.map(|name| json!({"name":name})).collect();
        deny.extend_from_slice(self.deny);
        let deny = Value::Array(deny);
        let mut options = CanonicaliseOptions::new(self.roots);
        options.access = access;
        options.cwd = self.roots.first().map(|r| r.path.as_str());
        options.home = self.home;
        options.deny = Some(&deny);
        let path = canonicalise_path(self.fs, raw, &options, self.nfc).map_err(|error| {
            if error.reason == "deny-listed" {
                Failure::denied("Use a non-sensitive path inside a configured root.")
            } else {
                Failure::outside()
            }
        })?;
        if denied_component(path.canonical()) {
            return Err(Failure::denied(
                "Environment credential files cannot be accessed.",
            ));
        }
        Ok(path)
    }
}
