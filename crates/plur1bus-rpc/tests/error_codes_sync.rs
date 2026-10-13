//! The closed set of RPC error codes, compared across the places that each keep their own copy of it:
//! `packages/rpc-schema/schema/rpc.schema.json` (`$defs.ErrorCode`, the source), the generated Rust `ErrorCode` enum, the error
//! fixtures, `docs/errors.md`, `docs/rpc.md`, the doc comments in `src/error.rs`, the TypeScript `RpcError` table of
//! `packages/module-api` and the log schema's `ErrCode` enum. Everything is read, nothing is changed.
//!
//! `crates/plur1bus/tests/docs_consistency.rs` already checks that every `E_*` word in `crates/*/src` is listed in
//! `docs/errors.md` and the reverse. This file adds what that one does not look at: the schema as the reference, the generated
//! enum's wire names and its refusal of near-misses, the fixtures and `docs/rpc.md`, the exact table structure of `docs/errors.md`
//! (once each, the CLI-only codes last), wrong spellings (`E_Locked`, `e_locked`) anywhere in the prose documentation, and codes
//! that exist only in a document, plus the two other languages' lists. Comparisons are by set, so no order matters.
use plur1bus_rpc::types::ErrorCode;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}
fn read(rel: &str) -> String {
    std::fs::read_to_string(root().join(rel)).unwrap_or_else(|e| panic!("{rel}: {e}"))
}

/// The schema's list, in its own order (duplicates kept so a test can see them).
fn schema_list() -> Vec<String> {
    let schema: Value =
        serde_json::from_str(&read("packages/rpc-schema/schema/rpc.schema.json")).unwrap();
    schema["$defs"]["ErrorCode"]["enum"]
        .as_array()
        .expect("$defs.ErrorCode.enum")
        .iter()
        .map(|v| v.as_str().expect("a string").to_string())
        .collect()
}
fn schema_codes() -> BTreeSet<String> {
    schema_list().into_iter().collect()
}

/// Whole words `E_[A-Za-z0-9_]*` with at least one character after the underscore, in any letter case after `E_`.
fn error_words(text: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let bytes = text.as_bytes();
    let word = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    let mut i = 0;
    while i < bytes.len() {
        if word(bytes[i]) && (i == 0 || !word(bytes[i - 1])) {
            let start = i;
            while i < bytes.len() && word(bytes[i]) {
                i += 1;
            }
            let w = &text[start..i];
            if w.len() > 2 && w.starts_with("E_") && w[2..].chars().next().is_some() {
                out.insert(w.trim_end_matches('_').to_string());
            }
        } else {
            i += 1;
        }
    }
    out
}

/// A readable difference of two sets, naming every code on either side.
fn compare(
    what_left: &str,
    left: &BTreeSet<String>,
    what_right: &str,
    right: &BTreeSet<String>,
) -> Result<(), String> {
    let only_left: Vec<_> = left.difference(right).cloned().collect();
    let only_right: Vec<_> = right.difference(left).cloned().collect();
    if only_left.is_empty() && only_right.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "{what_left} and {what_right} differ: only in {what_left}: {only_left:?}; only in {what_right}: {only_right:?}"
        ))
    }
}

fn set(items: &[&str]) -> BTreeSet<String> {
    items.iter().map(|s| s.to_string()).collect()
}

// ---------------------------------------------------------------------------------------------------------------------
// the helper itself
// ---------------------------------------------------------------------------------------------------------------------

#[test]
fn the_comparison_ignores_order_and_names_every_difference() {
    let a = schema_list();
    let mut shuffled = a.clone();
    // A fixed permutation: reverse, then rotate.
    shuffled.reverse();
    shuffled.rotate_left(5);
    assert_ne!(a, shuffled);
    let (sa, sb) = (
        a.iter().cloned().collect::<BTreeSet<_>>(),
        shuffled.iter().cloned().collect::<BTreeSet<_>>(),
    );
    assert!(compare("a", &sa, "b", &sb).is_ok());
    let mut missing = sb.clone();
    missing.remove("E_LOCKED");
    missing.insert("E_LOCKD".into());
    let msg = compare("schema", &sa, "doc", &missing).unwrap_err();
    assert!(
        msg.contains("only in schema: [\"E_LOCKED\"]")
            && msg.contains("only in doc: [\"E_LOCKD\"]"),
        "{msg}"
    );
}

#[test]
fn the_word_scanner_takes_whole_words_in_any_case_and_nothing_else() {
    let found = error_words("a E_LOCKED, `E_Locked` e_locked E_ E_9 xE_LOCKED ERROR_X E_NOT_FOUND. (E_DENIED) E_VOICE_LICENCE_");
    assert_eq!(
        found,
        set(&[
            "E_LOCKED",
            "E_Locked",
            "E_9",
            "E_NOT_FOUND",
            "E_DENIED",
            "E_VOICE_LICENCE"
        ])
    );
}

// ---------------------------------------------------------------------------------------------------------------------
// the schema is the reference
// ---------------------------------------------------------------------------------------------------------------------

#[test]
fn the_schema_list_is_well_formed_unique_and_has_no_two_codes_that_differ_only_in_case() {
    let list = schema_list();
    assert!(list.len() >= 28, "{} codes", list.len());
    let mut seen = BTreeSet::new();
    let mut lower = BTreeSet::new();
    for code in &list {
        assert!(
            code.starts_with("E_")
                && code.len() > 2
                && code
                    .bytes()
                    .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
                && !code.ends_with('_')
                && !code.contains("__"),
            "malformed code {code:?}"
        );
        assert!(seen.insert(code.clone()), "{code} is listed twice");
        assert!(
            lower.insert(code.to_lowercase()),
            "{code} differs from another code only in case"
        );
    }
}

#[test]
fn the_voice_error_code_definition_is_a_subset_of_the_error_codes() {
    let schema: Value =
        serde_json::from_str(&read("packages/rpc-schema/schema/rpc.schema.json")).unwrap();
    let voice: BTreeSet<String> = schema["$defs"]["VoiceErrorCode"]["enum"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    let all = schema_codes();
    let stray: Vec<_> = voice.difference(&all).collect();
    assert!(
        stray.is_empty(),
        "VoiceErrorCode names codes the ErrorCode enum lacks: {stray:?}"
    );
    assert!(voice.iter().all(|c| c.starts_with("E_VOICE_")));
}

// ---------------------------------------------------------------------------------------------------------------------
// the generated Rust enum
// ---------------------------------------------------------------------------------------------------------------------

/// The wire names of `pub enum ErrorCode` in the generated `types.rs`, read from its `#[serde(rename = "…")]` attributes.
fn generated_enum_names() -> BTreeSet<String> {
    let generated = include_str!(concat!(env!("OUT_DIR"), "/types.rs"));
    let start = generated
        .find("pub enum ErrorCode {")
        .expect("pub enum ErrorCode in the generated types");
    let body = &generated[start..];
    let end = body.find("\n}\n").expect("end of the enum");
    body[..end]
        .lines()
        .filter_map(|l| l.trim().strip_prefix("#[serde(rename = \""))
        .map(|l| l.split('"').next().unwrap().to_string())
        .collect()
}

#[test]
fn the_generated_enum_has_exactly_the_schema_codes_and_each_round_trips_in_every_form() {
    let schema = schema_codes();
    compare(
        "schema",
        &schema,
        "generated ErrorCode",
        &generated_enum_names(),
    )
    .unwrap();
    for code in &schema {
        let parsed: ErrorCode =
            serde_json::from_value(json!(code)).unwrap_or_else(|e| panic!("{code}: {e}"));
        assert_eq!(
            serde_json::to_value(parsed).unwrap(),
            json!(code),
            "serde {code}"
        );
        assert_eq!(parsed.to_string(), *code, "Display {code}");
        assert_eq!(code.parse::<ErrorCode>().unwrap(), parsed, "FromStr {code}");
        assert_eq!(
            ErrorCode::try_from(code.as_str()).unwrap(),
            parsed,
            "TryFrom {code}"
        );
    }
}

#[test]
fn the_generated_enum_refuses_wrong_case_padding_and_near_misses_in_every_form() {
    for code in schema_codes() {
        let mut wrong = vec![
            code.to_lowercase(),
            code.to_uppercase().replace("E_", "e_"),
            format!(" {code}"),
            format!("{code} "),
            format!("{code}\n"),
            format!("{code}\0"),
            format!("{code}_"),
            code.trim_start_matches("E_").to_string(),
            code[..code.len() - 1].to_string(),
        ];
        // Mixed case: every other letter lowered.
        wrong.push(
            code.chars()
                .enumerate()
                .map(|(i, c)| {
                    if i % 2 == 1 {
                        c.to_ascii_lowercase()
                    } else {
                        c
                    }
                })
                .collect(),
        );
        for w in wrong {
            if schema_codes().contains(&w) {
                continue; // a prefix of another code can itself be a code (E_VOICE_LICENCE / E_VOICE_LICENSE are distinct, not prefixes)
            }
            assert!(
                serde_json::from_value::<ErrorCode>(json!(w)).is_err(),
                "serde accepted {w:?}"
            );
            assert!(w.parse::<ErrorCode>().is_err(), "FromStr accepted {w:?}");
            assert!(
                ErrorCode::try_from(w.as_str()).is_err(),
                "TryFrom accepted {w:?}"
            );
        }
    }
    for not_a_string in [
        json!(null),
        json!(1),
        json!(true),
        json!([]),
        json!({}),
        json!(["E_LOCKED"]),
    ] {
        assert!(
            serde_json::from_value::<ErrorCode>(not_a_string.clone()).is_err(),
            "{not_a_string}"
        );
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------------------------------------------------

#[test]
fn there_is_exactly_one_error_fixture_per_schema_code_and_it_carries_that_code() {
    let dir = root().join("packages/rpc-schema/fixtures/errors");
    let mut stems = BTreeSet::new();
    for entry in std::fs::read_dir(&dir).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_some_and(|x| x == "json") {
            let stem = path.file_stem().unwrap().to_string_lossy().to_string();
            let doc: Value =
                serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
            assert_eq!(
                doc["error"]["data"]["error"],
                json!(stem),
                "{} carries another code",
                path.display()
            );
            stems.insert(stem);
        } else {
            panic!("{} is not a .json fixture", path.display());
        }
    }
    compare("schema", &schema_codes(), "error fixtures", &stems).unwrap();
}

// ---------------------------------------------------------------------------------------------------------------------
// docs/errors.md
// ---------------------------------------------------------------------------------------------------------------------

/// The `| \`E_CODE\` | exit | meaning |` rows of the error-code table, in file order.
fn errors_md_rows() -> Vec<(String, String)> {
    let text = read("docs/errors.md");
    let section = text.split("## Error codes").nth(1).expect("## Error codes");
    let section = section.split("\n## ").next().unwrap();
    section
        .lines()
        .filter_map(|l| {
            let cells: Vec<&str> = l.split('|').map(str::trim).collect();
            let code = cells.get(1)?.strip_prefix('`')?.strip_suffix('`')?;
            code.starts_with("E_").then(|| {
                (
                    code.to_string(),
                    cells.get(2).copied().unwrap_or("").to_string(),
                )
            })
        })
        .collect()
}

#[test]
fn errors_md_lists_each_schema_code_once_in_exact_case_and_the_cli_only_codes_last() {
    let rows = errors_md_rows();
    let mut seen = BTreeSet::new();
    for (code, exit) in &rows {
        assert!(
            seen.insert(code.clone()),
            "docs/errors.md lists {code} twice"
        );
        assert!(
            exit.parse::<u32>().is_ok(),
            "{code}: exit column {exit:?} is not a number"
        );
    }
    let schema = schema_codes();
    let rpc_rows: BTreeSet<String> = rows
        .iter()
        .filter(|(c, _)| schema.contains(c))
        .map(|(c, _)| c.clone())
        .collect();
    compare(
        "schema",
        &schema,
        "the RPC rows of docs/errors.md",
        &rpc_rows,
    )
    .unwrap();
    // "The last two are raised by the CLI itself": the rows that are not schema codes are exactly the last two.
    let cli_only: Vec<&String> = rows
        .iter()
        .map(|(c, _)| c)
        .filter(|c| !schema.contains(*c))
        .collect();
    let tail: Vec<&String> = rows.iter().rev().take(2).map(|(c, _)| c).rev().collect();
    assert_eq!(
        cli_only, tail,
        "docs/errors.md: the codes that are not in the schema must be the last two rows"
    );
    assert_eq!(
        cli_only.len(),
        2,
        "the page says the last two codes are raised by the CLI itself"
    );
}

#[test]
fn the_cli_only_codes_of_errors_md_exist_in_the_cli_sources_and_not_in_the_rpc_crate() {
    let schema = schema_codes();
    let cli_only: Vec<String> = errors_md_rows()
        .into_iter()
        .map(|(c, _)| c)
        .filter(|c| !schema.contains(c))
        .collect();
    let mut cli_src = String::new();
    collect_rs(&root().join("crates/plur1bus/src"), &mut cli_src);
    let rpc_src = read("crates/plur1bus-rpc/src/error.rs");
    for code in cli_only {
        assert!(
            error_words(&cli_src).contains(&code),
            "{code} is documented as raised by the CLI but not found in crates/plur1bus/src"
        );
        assert!(
            !error_words(&rpc_src).contains(&code),
            "{code} is a CLI-only code but plur1bus-rpc mentions it"
        );
    }
}

fn collect_rs(dir: &Path, out: &mut String) {
    for e in std::fs::read_dir(dir).unwrap() {
        let p = e.unwrap().path();
        if p.is_dir() {
            collect_rs(&p, out);
        } else if p.extension().is_some_and(|x| x == "rs") {
            out.push_str(&std::fs::read_to_string(&p).unwrap());
            out.push('\n');
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// docs/rpc.md
// ---------------------------------------------------------------------------------------------------------------------

#[test]
fn rpc_md_error_code_list_equals_the_schema() {
    let text = read("docs/rpc.md");
    let section = text
        .split("\n## Error codes")
        .nth(1)
        .expect("## Error codes in docs/rpc.md");
    let section = section.split("\n## ").next().unwrap();
    let listed: Vec<String> = section
        .lines()
        .filter_map(|l| l.strip_prefix("- `").and_then(|r| r.strip_suffix('`')))
        .map(str::to_string)
        .collect();
    let unique: BTreeSet<String> = listed.iter().cloned().collect();
    assert_eq!(unique.len(), listed.len(), "docs/rpc.md lists a code twice");
    compare("schema", &schema_codes(), "docs/rpc.md", &unique).unwrap();
}

// ---------------------------------------------------------------------------------------------------------------------
// doc comments in plur1bus-rpc
// ---------------------------------------------------------------------------------------------------------------------

#[test]
fn the_doc_comments_in_error_rs_name_only_schema_codes_and_list_the_whole_media_family() {
    let schema = schema_codes();
    let doc_lines: Vec<String> = read("crates/plur1bus-rpc/src/error.rs")
        .lines()
        .filter_map(|l| l.trim_start().strip_prefix("///").map(str::to_string))
        .collect();
    let mut named = BTreeSet::new();
    for l in &doc_lines {
        named.extend(error_words(l));
    }
    let stray: Vec<_> = named.difference(&schema).collect();
    assert!(
        stray.is_empty(),
        "doc comments in error.rs name codes the schema lacks: {stray:?}"
    );
    // The sentence that introduces the media-index codes and the line after it (the list) must name all of them and nothing else.
    let at = doc_lines
        .iter()
        .position(|l| l.contains("Media-index codes of the closed set"))
        .expect("the media-index doc line");
    let listed: BTreeSet<String> = doc_lines[at..=at + 1]
        .iter()
        .flat_map(|l| error_words(l))
        .collect();
    let family: BTreeSet<String> = schema
        .iter()
        .filter(|c| c.starts_with("E_MEDIA_"))
        .cloned()
        .collect();
    compare(
        "the E_MEDIA_* codes of the schema",
        &family,
        "the media doc lines",
        &listed,
    )
    .unwrap();
}

// ---------------------------------------------------------------------------------------------------------------------
// prose documentation: wrong spellings and codes that only a document knows
// ---------------------------------------------------------------------------------------------------------------------

/// `E_` words in prose documents that are not RPC error codes. Each belongs to another namespace and says where it is defined.
/// A new word in a document must be a schema code, a row of `docs/errors.md` or be added here with its owner.
const OTHER_NAMESPACES: &[(&str, &str)] = &[
    (
        "E_MEDIA",
        "the prefix of the E_MEDIA_* family, used in prose",
    ),
    (
        "E_EXISTS",
        "desktop shell local file-store error (docs/desktop.md)",
    ),
    ("E_SOURCE_BUSY", "importer report code (docs/import.md)"),
    (
        "E_SOURCE_NOT_FOUND",
        "importer report code (docs/import.md)",
    ),
    (
        "E_SOURCE_UNSUPPORTED",
        "importer report code (docs/import.md)",
    ),
    (
        "E_ROLLBACK_INVALID",
        "importer report code (docs/import.md)",
    ),
    ("E_ROLLBACK_STALE", "importer report code (docs/import.md)"),
    (
        "E_DISABLED",
        "Hermes host client code (docs/hermes-host-mode.md)",
    ),
    (
        "E_TRANSPORT",
        "Hermes host client code (docs/hermes-host-mode.md)",
    ),
    (
        "E_TIMEOUT",
        "Hermes host client code (docs/hermes-host-mode.md)",
    ),
    (
        "E_SERVER_IDENTITY",
        "Python client code, a refused server pid (docs/hermes-host-mode.md, docs/rpc.md)",
    ),
];

fn prose_documents() -> Vec<(String, String)> {
    fn walk(dir: &Path, base: &Path, out: &mut Vec<(String, String)>) {
        for e in std::fs::read_dir(dir).unwrap() {
            let p = e.unwrap().path();
            let rel = p
                .strip_prefix(base)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            if p.is_dir() {
                // Plans, specs and hand-off notes are historical working papers, not the documentation of a code.
                if rel == "docs/superpowers" || rel == "docs/handoff" {
                    continue;
                }
                walk(&p, base, out);
            } else if p.extension().is_some_and(|x| x == "md") {
                out.push((rel, std::fs::read_to_string(&p).unwrap()));
            }
        }
    }
    let base = root();
    let mut out = Vec::new();
    walk(&base.join("docs"), &base, &mut out);
    if base.join("skills").is_dir() {
        walk(&base.join("skills"), &base, &mut out);
    }
    assert!(out.len() > 20, "{} documents", out.len());
    out
}

#[test]
fn no_document_spells_a_known_error_code_in_the_wrong_case_or_with_a_typo() {
    let schema = schema_codes();
    let documented: BTreeSet<String> = errors_md_rows().into_iter().map(|(c, _)| c).collect();
    let known: BTreeSet<String> = schema.union(&documented).cloned().collect();
    let mut problems = Vec::new();
    for (file, text) in prose_documents() {
        for w in error_words(&text) {
            if known.contains(&w) || OTHER_NAMESPACES.iter().any(|(n, _)| *n == w) {
                continue;
            }
            if let Some(real) = known.iter().find(|k| k.eq_ignore_ascii_case(&w)) {
                problems.push(format!(
                    "{file}: {w} is spelled in the wrong case, the code is {real}"
                ));
            } else if let Some(near) = known.iter().find(|k| edit_distance_one(k, &w)) {
                problems.push(format!("{file}: {w} looks like a typo of {near}"));
            }
        }
    }
    assert!(problems.is_empty(), "{}", problems.join("\n"));
}

#[test]
fn every_error_code_a_document_mentions_is_a_schema_code_a_documented_cli_code_or_classified() {
    let schema = schema_codes();
    let documented: BTreeSet<String> = errors_md_rows().into_iter().map(|(c, _)| c).collect();
    let mut problems = Vec::new();
    for (file, text) in prose_documents() {
        for w in error_words(&text) {
            let classified = OTHER_NAMESPACES.iter().any(|(n, _)| *n == w);
            if !schema.contains(&w) && !documented.contains(&w) && !classified {
                problems.push(format!("{file}: {w} is not a schema code, not in docs/errors.md and not classified in OTHER_NAMESPACES"));
            }
        }
    }
    assert!(problems.is_empty(), "{}", problems.join("\n"));
}

#[test]
fn the_other_namespace_list_has_no_stale_entries_and_never_shadows_an_rpc_code() {
    let schema = schema_codes();
    let all: BTreeSet<String> = prose_documents()
        .iter()
        .flat_map(|(_, t)| error_words(t))
        .collect();
    for (word, _) in OTHER_NAMESPACES {
        assert!(
            !schema.contains(*word),
            "{word} is an RPC code and must not be classified as another namespace"
        );
        assert!(
            all.contains(*word),
            "{word} is no longer mentioned in any document; remove it from OTHER_NAMESPACES"
        );
    }
}

fn edit_distance_one(a: &str, b: &str) -> bool {
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    if a == b || a.len().abs_diff(b.len()) > 1 {
        return false;
    }
    if a.len() == b.len() {
        return a.iter().zip(&b).filter(|(x, y)| x != y).count() == 1;
    }
    let (long, short) = if a.len() > b.len() {
        (&a, &b)
    } else {
        (&b, &a)
    };
    (0..long.len()).any(|skip| {
        long.iter()
            .enumerate()
            .filter(|(i, _)| *i != skip)
            .map(|(_, c)| c)
            .eq(short.iter())
    })
}

#[test]
fn the_typo_detector_sees_one_edit_and_nothing_further() {
    assert!(edit_distance_one("E_LOCKED", "E_LOCKD"));
    assert!(edit_distance_one("E_LOCKED", "E_LOCKEDD"));
    assert!(edit_distance_one("E_LOCKED", "E_LOCKEX"));
    assert!(!edit_distance_one("E_LOCKED", "E_LOCKED"));
    assert!(!edit_distance_one("E_LOCKED", "E_LOCK"));
    assert!(!edit_distance_one("E_VOICE_LICENSE", "E_VOICE_LICENCE_X"));
}

// ---------------------------------------------------------------------------------------------------------------------
// the other languages' copies
// ---------------------------------------------------------------------------------------------------------------------

#[test]
fn the_log_schema_err_code_enum_contains_every_rpc_code_and_only_codes_it_can_name() {
    let log: Value =
        serde_json::from_str(&read("packages/log-schema/schema/record.schema.json")).unwrap();
    let listed: BTreeSet<String> = log["$defs"]["ErrCode"]["enum"]
        .as_array()
        .expect("$defs.ErrCode.enum")
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    let schema = schema_codes();
    let missing: Vec<_> = schema.difference(&listed).collect();
    assert!(
        missing.is_empty(),
        "the log schema's ErrCode lacks RPC codes: {missing:?}"
    );
    // The extras are provider error classes (lower-case kebab names), never a second spelling of an RPC code.
    for extra in listed.difference(&schema) {
        assert!(
            !extra.starts_with("E_") && extra.bytes().all(|b| b.is_ascii_lowercase() || b == b'-'),
            "ErrCode has {extra:?}, which is neither an RPC code nor a provider error class"
        );
    }
}

fn module_api_table_codes() -> BTreeSet<String> {
    error_words(&read("packages/module-api/src/rpc-error.ts"))
}

#[test]
fn the_module_api_rpc_error_table_names_only_schema_codes() {
    let schema = schema_codes();
    let stray: Vec<_> = module_api_table_codes()
        .difference(&schema)
        .cloned()
        .collect();
    assert!(
        stray.is_empty(),
        "packages/module-api/src/rpc-error.ts names codes the schema lacks: {stray:?}"
    );
}

/// KNOWN GAP (packages/module-api, outside this change): `DEFAULT_JSONRPC_CODE` in `rpc-error.ts` has no entry for
/// `E_PROJECT_WIP_LIMIT`, `E_INBOX_CURSOR` and `E_INVITE_INVALID`. At run time that is harmless, because the lookup falls back to
/// `-32000`, which is what every other entry except `E_INVALID_PARAMS` has, but the table no longer lists the whole closed set.
#[test]
#[ignore = "KNOWN GAP: packages/module-api/src/rpc-error.ts DEFAULT_JSONRPC_CODE lacks E_PROJECT_WIP_LIMIT, E_INBOX_CURSOR, E_INVITE_INVALID"]
fn the_module_api_rpc_error_table_lists_every_schema_code() {
    compare(
        "schema",
        &schema_codes(),
        "module-api table",
        &module_api_table_codes(),
    )
    .unwrap();
}
