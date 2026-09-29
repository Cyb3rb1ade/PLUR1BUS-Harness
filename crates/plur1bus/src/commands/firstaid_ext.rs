//! `1staid check`'s extension rows (X1 Task 13, X1-R17, X1-R30): `extensions.integrity`, `extensions.consistency` and
//! `extensions.revoked`. Read-only: no lock is taken and nothing is written, `integrity` is never cached back into
//! `state.json` (that is `ext.show`/`ext.enable`'s job), and `1staid repair` plans nothing for these rows (repair from
//! the cache is X4). A record the user removed (`removedByUser`) is a tombstone, not an installed item, and is skipped.
use crate::commands::firstaid::{Check, Status};
use crate::ext::index::read_index;
use crate::ext::overlays::{load_revocations, rehash, revoked};
use crate::ext::paths::ExtPaths;
use crate::ext::state::{self, ExtState};
use crate::paths::Layout;
use serde_json::{json, Value};

/// The hint of a failed integrity or consistency row: the install command of the item's kind (`skill` or `plugin`).
const HINT_REINSTALL: &str =
    "reinstall the extension from its package: plur1bus skill|plugin install <file>";
/// The hint of a failed revocation row.
const HINT_REMOVE: &str = "remove it: plur1bus skill|plugin uninstall <name>";

const INTEGRITY: &str = "extensions.integrity";
const CONSISTENCY: &str = "extensions.consistency";
const REVOKED: &str = "extensions.revoked";

fn row(
    id: &'static str,
    status: Status,
    summary: impl Into<String>,
    detail: Option<Value>,
    hint: Option<&str>,
) -> Check {
    Check {
        id,
        status,
        summary: summary.into(),
        detail,
        hint: hint.map(str::to_string),
    }
}

/// `state.json`, or the row to report when it cannot be read.
fn read_state(layout: &Layout, id: &'static str) -> Result<ExtState, Check> {
    state::read(&ExtPaths::of(layout)).map_err(|e| {
        row(
            id,
            Status::Fail,
            "extensions/state.json is unreadable",
            Some(json!({ "error": e })),
            Some("restore extensions/state.json or reinstall the extensions"),
        )
    })
}

/// Re-hashes every installed payload against `state.json`. `fail` lists `<name>: <path>` for every file that is
/// missing or differs; no records is `ok`.
pub(crate) fn check_ext_integrity(layout: &Layout) -> Check {
    let st = match read_state(layout, INTEGRITY) {
        Ok(s) => s,
        Err(c) => return c,
    };
    // The same kinds as `check_ext_consistency`: only skills, modules and channels have a payload directory here;
    // mcp-server and bundle records are not re-hashed.
    let items: Vec<_> = st
        .items
        .values()
        .filter(|r| !r.removed_by_user)
        .filter(|r| matches!(r.kind.as_str(), "skill" | "module" | "channel"))
        .collect();
    if items.is_empty() {
        return row(INTEGRITY, Status::Ok, "no packaged extensions", None, None);
    }
    let mut bad: Vec<String> = Vec::new();
    for rec in &items {
        for p in rehash(layout, rec).paths {
            bad.push(format!("{}: {p}", rec.name));
        }
    }
    if bad.is_empty() {
        row(
            INTEGRITY,
            Status::Ok,
            format!("{} packaged extension(s) match their records", items.len()),
            None,
            None,
        )
    } else {
        row(
            INTEGRITY,
            Status::Fail,
            format!("{} installed file(s) differ from their records", bad.len()),
            Some(json!({ "files": bad })),
            Some(HINT_REINSTALL),
        )
    }
}

/// `fail`: a record whose code directory is missing. `warn`: an index entry with `package` and no record. Otherwise
/// `ok`.
pub(crate) fn check_ext_consistency(layout: &Layout) -> Check {
    let st = match read_state(layout, CONSISTENCY) {
        Ok(s) => s,
        Err(c) => return c,
    };
    let mut missing: Vec<String> = Vec::new();
    for rec in st.items.values().filter(|r| !r.removed_by_user) {
        let dir = match rec.kind.as_str() {
            "skill" => layout.skills().join(&rec.name),
            "module" | "channel" => layout.modules_dir().join(&rec.name),
            _ => continue,
        };
        if !dir.is_dir() {
            missing.push(format!("{}: {}", rec.name, dir.display()));
        }
    }
    if !missing.is_empty() {
        return row(
            CONSISTENCY,
            Status::Fail,
            format!(
                "{} installed extension(s) have no code directory",
                missing.len()
            ),
            Some(json!({ "missingCode": missing })),
            Some(HINT_REINSTALL),
        );
    }
    let index = match read_index(layout) {
        Ok(i) => i,
        Err(e) => {
            return row(
                CONSISTENCY,
                Status::Warn,
                "the skills index cannot be read",
                Some(json!({ "error": e.message })),
                None,
            )
        }
    };
    let orphans: Vec<String> = index.0["skills"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|e| e.get("package").is_some_and(|p| !p.is_null()))
        .filter_map(|e| e["id"].as_str())
        .filter(|id| st.items.get(*id).is_none_or(|r| r.removed_by_user))
        .map(str::to_string)
        .collect();
    if orphans.is_empty() {
        row(
            CONSISTENCY,
            Status::Ok,
            "extension records, code and index agree",
            None,
            None,
        )
    } else {
        row(
            CONSISTENCY,
            Status::Warn,
            format!(
                "{} index entr(ies) name a package with no record",
                orphans.len()
            ),
            Some(json!({ "orphanIndexEntries": orphans })),
            Some("remove the entry from skills/index.json or reinstall the package"),
        )
    }
}

/// `fail` listing every installed item the revocation list disables, with its reason.
pub(crate) fn check_ext_revoked(layout: &Layout) -> Check {
    let st = match read_state(layout, REVOKED) {
        Ok(s) => s,
        Err(c) => return c,
    };
    let revs = load_revocations(&ExtPaths::of(layout));
    let hits: Vec<Value> = st
        .items
        .values()
        .filter(|r| !r.removed_by_user)
        .filter_map(|r| {
            revoked(&revs, &r.id, &r.version).map(|reason| {
                json!({ "name": r.name, "id": r.id, "version": r.version, "reason": reason })
            })
        })
        .collect();
    if hits.is_empty() {
        row(
            REVOKED,
            Status::Ok,
            "no installed extension is revoked",
            None,
            None,
        )
    } else {
        row(
            REVOKED,
            Status::Fail,
            format!("{} installed extension(s) are revoked", hits.len()),
            Some(json!({ "revoked": hits })),
            Some(HINT_REMOVE),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::{HINT_REINSTALL, HINT_REMOVE};
    use clap::Parser;

    /// Every command a hint names parses with the real CLI, for each `a|b` alternative of a word (placeholders
    /// filled in).
    #[test]
    fn every_command_a_hint_names_parses() {
        for hint in [HINT_REINSTALL, HINT_REMOVE] {
            let cmd = &hint[hint.find("plur1bus ").expect(hint)..];
            let mut lines: Vec<Vec<String>> = vec![vec![]];
            for word in cmd.split_whitespace() {
                let word = match word {
                    "<file>" => "x.p1x",
                    "<name>" => "demo",
                    w => w,
                };
                lines = lines
                    .into_iter()
                    .flat_map(|l| {
                        word.split('|').map(move |alt| {
                            let mut l = l.clone();
                            l.push(alt.to_string());
                            l
                        })
                    })
                    .collect();
            }
            assert_eq!(lines.len(), 2, "{hint}");
            for argv in lines {
                if let Err(e) = crate::cli::Cli::try_parse_from(&argv) {
                    panic!("hint {hint:?}: `{}` does not parse: {e}", argv.join(" "));
                }
            }
        }
    }
}
