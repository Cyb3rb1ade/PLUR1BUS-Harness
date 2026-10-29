//! Supported skill and MCP component assembly with aggregate byte/file budgets and no recursive bundles (M-A11).
use super::{inline, invalid, source, EgressFetch};
use crate::manifest::P1xManifest;
use crate::mcpb::{normalise_mcpb_with_context, McpbContext};
use crate::normalise::normalise_skill_files;
use crate::refusal::{reason, Refusal};
use crate::zipaudit::Limits;
use serde_json::Value;
use std::collections::BTreeSet;
use std::io::{Cursor, Read};

pub(super) struct Child {
    pub manifest: P1xManifest,
    pub bytes: Vec<u8>,
    pub warnings: Vec<String>,
}

pub(super) struct Builder<'a, C, F> {
    tree: &'a source::SourceTree,
    context: &'a mut C,
    fetch: &'a mut F,
    limits: &'a Limits,
    created: &'a str,
    version: Option<&'a str>,
    children: Vec<Child>,
    seen: BTreeSet<String>,
    active: BTreeSet<String>,
    names: BTreeSet<String>,
    fetched: u64,
    expanded: u64,
    files: usize,
    user_config: Value,
}

impl<'a, C: FnMut(&str) -> Result<McpbContext, Refusal>, F: EgressFetch> Builder<'a, C, F> {
    pub fn new(
        tree: &'a source::SourceTree,
        context: &'a mut C,
        fetch: &'a mut F,
        limits: &'a Limits,
        created: &'a str,
        version: Option<&'a str>,
    ) -> Self {
        Self {
            tree,
            context,
            fetch,
            limits,
            created,
            version,
            children: Vec::new(),
            seen: BTreeSet::new(),
            active: BTreeSet::new(),
            names: BTreeSet::new(),
            fetched: 0,
            expanded: 0,
            files: 0,
            user_config: Value::Null,
        }
    }

    fn add(&mut self, child: Child) -> Result<(), Refusal> {
        if !self.names.insert(child.manifest.name.clone()) {
            return Err(invalid("plugin members have duplicate normalized names"));
        }
        self.expanded = self
            .expanded
            .saturating_add(child.manifest.files.values().map(|f| f.size).sum::<u64>());
        self.files = self.files.saturating_add(child.manifest.files.len());
        if self.children.len() >= self.limits.max_entries.saturating_sub(1).min(1000)
            || self.expanded > self.limits.package_bytes
            || self.files > self.limits.max_entries
        {
            return Err(Refusal::invalid(
                reason::TOO_LARGE,
                "plugin members exceed aggregate byte, file or member limits",
            ));
        }
        self.children.push(child);
        Ok(())
    }

    pub fn skills(&mut self, metadata: &Value) -> Result<(), Refusal> {
        self.user_config = metadata.get("userConfig").cloned().unwrap_or(Value::Null);
        let mut roots = BTreeSet::from(["skills".to_owned()]);
        if let Some(paths) = metadata.get("skills") {
            for path in match paths {
                Value::String(path) => vec![path.as_str()],
                Value::Array(paths) => paths
                    .iter()
                    .map(|p| {
                        p.as_str()
                            .ok_or_else(|| invalid("plugin skills paths must be strings"))
                    })
                    .collect::<Result<Vec<_>, _>>()?,
                _ => return Err(invalid("plugin skills must be a path or an array of paths")),
            } {
                roots.insert(source::relative(path)?);
            }
        }
        let selected: BTreeSet<String> = self
            .tree
            .files
            .keys()
            .filter(|path| path.ends_with("/SKILL.md"))
            .filter(|path| {
                roots
                    .iter()
                    .any(|root| path.starts_with(&format!("{root}/")))
            })
            .filter_map(|path| path.strip_suffix("/SKILL.md").map(str::to_owned))
            .collect();
        for root in selected {
            let prefix = format!("{root}/");
            let files = self
                .tree
                .files
                .values()
                .filter_map(|file| {
                    file.rel.strip_prefix(&prefix).map(|rel| {
                        let mut file = file.clone();
                        file.rel = rel.into();
                        file
                    })
                })
                .collect();
            let mut output = Cursor::new(Vec::new());
            let (manifest, warnings) =
                normalise_skill_files(root.rsplit('/').next(), files, self.created, &mut output)?;
            self.add(Child {
                manifest,
                bytes: output.into_inner(),
                warnings,
            })?;
        }
        Ok(())
    }

    pub fn servers(&mut self, value: &Value) -> Result<(), Refusal> {
        match value {
            Value::String(path) => self.reference(path),
            Value::Array(paths) => {
                for path in paths {
                    self.reference(
                        path.as_str()
                            .ok_or_else(|| invalid("plugin MCP references must be strings"))?,
                    )?;
                }
                Ok(())
            }
            Value::Object(servers) => {
                if let Some(servers) = servers.get("mcpServers") {
                    return self.servers(servers);
                }
                for (name, definition) in servers {
                    if let Some(reference) = definition.as_str() {
                        self.reference(reference)?;
                    } else {
                        let child = inline::normalize(
                            name,
                            definition,
                            &self.user_config,
                            self.tree,
                            self.context,
                            self.limits,
                            self.version,
                        )?;
                        self.add(child)?;
                    }
                }
                Ok(())
            }
            _ => Err(invalid(
                "plugin mcpServers must be references or a server definition map",
            )),
        }
    }

    pub fn reference(&mut self, reference: &str) -> Result<(), Refusal> {
        let remote = reference.starts_with("https://");
        let reference = if remote {
            if reference.len() > 2048
                || reference.contains('#')
                || reference.chars().any(char::is_whitespace)
                || crate::kinds::url_host(reference).is_err()
            {
                return Err(invalid(
                    "plugin MCP source must use HTTPS without credentials or fragment",
                ));
            }
            reference.to_owned()
        } else {
            source::relative(reference)?
        };
        if self.active.contains(&reference) || self.active.len() >= 8 {
            return Err(invalid("plugin MCP configuration references recurse"));
        }
        if !self.seen.insert(reference.clone()) {
            return Ok(());
        }
        self.active.insert(reference.clone());
        let bytes = if remote {
            self.download(&reference)?
        } else {
            self.tree
                .files
                .get(&reference)
                .ok_or_else(|| {
                    invalid("plugin MCP reference is absent or excluded from its source root")
                })?
                .bytes
                .clone()
        };
        if bytes.starts_with(b"PK\x03\x04") {
            let mut output = Cursor::new(Vec::new());
            let report = normalise_mcpb_with_context(
                &mut Cursor::new(bytes),
                |name| (self.context)(name),
                self.limits,
                self.created,
                &mut output,
            )?;
            self.add(Child {
                manifest: report.manifest,
                bytes: output.into_inner(),
                warnings: report.warnings,
            })?;
        } else {
            let config = source::json(&bytes, self.limits)?;
            self.servers(&config)?;
        }
        self.active.remove(&reference);
        Ok(())
    }

    fn download(&mut self, url: &str) -> Result<Vec<u8>, Refusal> {
        let remaining = self.limits.package_bytes.saturating_sub(self.fetched);
        if remaining == 0 {
            return Err(Refusal::invalid(
                reason::TOO_LARGE,
                "plugin remote sources exceed their aggregate byte limit",
            ));
        }
        let reader = self.fetch.fetch(url, remaining).map_err(|error| Refusal {
            code: error.code,
            reason: error.reason,
            detail: "plugin MCP source was refused by its egress fetch port".into(),
        })?;
        let mut bytes = Vec::new();
        reader
            .take(remaining.saturating_add(1))
            .read_to_end(&mut bytes)
            .map_err(|_| invalid("plugin MCP source could not be read"))?;
        self.fetched = self.fetched.saturating_add(bytes.len() as u64);
        if self.fetched > self.limits.package_bytes {
            return Err(Refusal::invalid(
                reason::TOO_LARGE,
                "plugin remote sources exceed their aggregate byte limit",
            ));
        }
        Ok(bytes)
    }

    pub fn finish(self) -> Result<Vec<Child>, Refusal> {
        if self.children.is_empty() {
            return Err(invalid("plugin has no supported skills or MCP servers"));
        }
        Ok(self.children)
    }
}
