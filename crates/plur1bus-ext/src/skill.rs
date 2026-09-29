//! The Agent Skills check (agentskills.io/specification, spec 2026-09-27 §4.3) on a `SKILL.md`, and the names a skill
//! folder never carries (docs/import.md §9.3).
//!
//! The frontmatter reader is deliberately small: top-level `key: value` entries with plain, single- or
//! double-quoted, `|` and `>` block scalars, and one level of nested mapping for `metadata`. Everything else (Hermes'
//! `metadata.hermes.*`, lists, flow collections) is skipped, not interpreted.
use crate::refusal::{reason, Refusal};

/// File names a skill never carries (docs/import.md §9.3). `*` matches any run of characters, a trailing `/` names a
/// directory at any depth. Compared case-insensitively, like the TS importer.
pub const EXCLUDED: &[&str] = &[
    ".env",
    ".env.*",
    "auth.json",
    "credentials.json",
    "*.pem",
    "*.key",
    "id_rsa*",
    ".git/",
    ".DS_Store",
    // The TS importer's `isSecretFileName` also treats these as credentials (X1-C3).
    ".netrc",
    ".npmrc",
    ".pypirc",
    "id_ed25519*",
    "id_ecdsa*",
];

/// Names the TS importer's scan leaves out silently (`SKIP_NAMES` in `skills-scan.ts`, besides `.git` and `.DS_Store`,
/// which are in [`EXCLUDED`]). `normalise_skill` drops them with a warning so its folder hash equals the TS scan's;
/// a `.p1x` skill package holding one is refused (X1-C3). Matched case-sensitively, at any depth, as a file or a
/// directory.
pub const SKIP: &[&str] = &[".hg/", ".svn/", "__pycache__/"];

/// Whether a `/`-separated path is, or lies inside, a [`SKIP`] name.
pub fn is_skipped(path: &str) -> bool {
    path.split('/')
        .any(|seg| SKIP.iter().any(|s| s.trim_end_matches('/') == seg))
}

/// Whether a `/`-separated path (relative to the skill root, or `payload/…`) names an [`EXCLUDED`] file, or a file
/// inside an excluded directory.
pub fn is_excluded(path: &str) -> bool {
    let lower = path.to_lowercase();
    let segments: Vec<&str> = lower.split('/').collect();
    let (name, dirs) = segments
        .split_last()
        .map_or(("", &[][..]), |(n, d)| (*n, d));
    if name == ".git" || dirs.iter().any(|d| *d == ".git" || *d == ".ds_store") {
        return true;
    }
    EXCLUDED.iter().any(|pat| {
        if pat.ends_with('/') {
            return false;
        }
        let pat = pat.to_lowercase();
        match (pat.strip_prefix('*'), pat.strip_suffix('*')) {
            (Some(suffix), _) => name.ends_with(suffix),
            (_, Some(prefix)) => name.starts_with(prefix),
            _ => name == pat,
        }
    })
}

/// The frontmatter fields the harness uses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillFront {
    pub name: String,
    pub description: String,
    pub license: Option<String>,
    /// The frontmatter `version`, else `metadata.version`.
    pub version: Option<String>,
}

fn invalid(detail: impl Into<String>) -> Refusal {
    Refusal::invalid(reason::PACKAGE_INVALID, detail)
}

/// Agent Skills `name`: 1–64 characters, `a-z0-9-`, no leading, trailing or double hyphen.
fn valid_skill_name(n: &str) -> bool {
    !n.is_empty()
        && n.len() <= 64
        && !n.starts_with('-')
        && !n.ends_with('-')
        && !n.contains("--")
        && n.bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}

/// Leading ASCII spaces and tabs only, so slicing by it never lands inside a multibyte character (Unicode whitespace
/// such as U+3000 is content, not indentation). Tabs are accepted as indentation, which YAML does not allow: the
/// reader is lenient where that cannot change the meaning of the fields it reads.
fn indent_of(l: &str) -> usize {
    l.bytes().take_while(|b| *b == b' ' || *b == b'\t').count()
}

/// A YAML null (`~`, `null`, `Null`, `NULL`) reads as an absent value.
fn is_null(s: &str) -> bool {
    matches!(s, "~" | "null" | "Null" | "NULL")
}

/// A parsed top-level entry: its key, its inline value and its indented continuation lines.
struct Entry<'a> {
    key: &'a str,
    inline: &'a str,
    body: Vec<&'a str>,
}

fn split_frontmatter(raw: &str) -> Result<Vec<&str>, Refusal> {
    let raw = raw.strip_prefix('\u{feff}').unwrap_or(raw);
    let mut lines = raw.lines();
    if lines.next().map(str::trim_end) != Some("---") {
        return Err(invalid(
            "SKILL.md has no YAML frontmatter (it must start with ---)",
        ));
    }
    let mut out = Vec::new();
    for l in lines {
        if l.trim_end() == "---" {
            return Ok(out);
        }
        out.push(l);
    }
    Err(invalid("the SKILL.md frontmatter is not closed with ---"))
}

fn entries<'a>(lines: &[&'a str]) -> Result<Vec<Entry<'a>>, Refusal> {
    let mut out: Vec<Entry<'a>> = Vec::new();
    for l in lines {
        let indented = l.starts_with(' ') || l.starts_with('\t');
        if l.trim().is_empty() {
            if let Some(last) = out.last_mut() {
                last.body.push("");
            }
        } else if indented {
            match out.last_mut() {
                Some(last) => last.body.push(l),
                None => {
                    return Err(invalid(
                        "the SKILL.md frontmatter starts with an indented line",
                    ))
                }
            }
        } else if l.trim_start().starts_with('#') {
            continue;
        } else if l.starts_with("- ") {
            // An unindented sequence belongs to the key above it (`allowed-tools:\n- Bash`); before any key the
            // frontmatter is a sequence, not a mapping.
            match out.last_mut() {
                Some(last) => last.body.push(l),
                None => return Err(invalid("the SKILL.md frontmatter is not a mapping")),
            }
        } else {
            let Some((key, rest)) = l.split_once(':') else {
                return Err(invalid(format!(
                    "the SKILL.md frontmatter line {l:?} is not `key: value`"
                )));
            };
            if !rest.is_empty() && !rest.starts_with(' ') {
                // `a:b` is a plain scalar without a key in YAML; treat it as a malformed line.
                return Err(invalid(format!(
                    "the SKILL.md frontmatter line {l:?} is not `key: value`"
                )));
            }
            out.push(Entry {
                key: key.trim(),
                inline: rest.trim(),
                body: Vec::new(),
            });
        }
    }
    Ok(out)
}

/// Removes an unquoted trailing ` # comment`.
fn strip_comment(s: &str) -> &str {
    let mut quote: Option<char> = None;
    let bytes: Vec<(usize, char)> = s.char_indices().collect();
    for (i, &(pos, c)) in bytes.iter().enumerate() {
        match quote {
            Some(q) => {
                if c == q {
                    quote = None;
                }
            }
            None => {
                if (c == '"' || c == '\'') && i == 0 {
                    quote = Some(c);
                } else if c == '#' && (i == 0 || bytes[i - 1].1.is_whitespace()) {
                    return s[..pos].trim_end();
                }
            }
        }
    }
    s
}

fn unquote(s: &str) -> Result<String, Refusal> {
    if let Some(inner) = s.strip_prefix('\'') {
        let inner = inner
            .strip_suffix('\'')
            .ok_or_else(|| invalid(format!("unterminated quoted value {s:?}")))?;
        return Ok(inner.replace("''", "'"));
    }
    if s.starts_with('"') {
        return serde_json::from_str::<String>(s)
            .map_err(|_| invalid(format!("unsupported double-quoted value {s:?}")));
    }
    Ok(s.to_string())
}

/// The value of an entry as a string: an inline scalar, a block scalar, or a multi-line plain scalar. `None` for a
/// nested mapping or sequence (no inline value and a body that is not text).
fn text_value(e: &Entry<'_>) -> Result<Option<String>, Refusal> {
    let inline = strip_comment(e.inline);
    if let Some(style) = inline.chars().next().filter(|c| *c == '|' || *c == '>') {
        let indent = e
            .body
            .iter()
            .filter(|l| !l.trim().is_empty())
            .map(|l| indent_of(l))
            .min()
            .unwrap_or(0);
        let lines: Vec<&str> = e
            .body
            .iter()
            .map(|l| l.get(indent..).unwrap_or(""))
            .collect();
        let text = if style == '|' {
            lines.join("\n")
        } else {
            lines
                .split(|l| l.trim().is_empty())
                .map(|para| para.iter().map(|l| l.trim()).collect::<Vec<_>>().join(" "))
                .collect::<Vec<_>>()
                .join("\n")
        };
        return Ok(Some(text.trim().to_string()));
    }
    if inline.is_empty() {
        // A nested mapping or list, or an empty value.
        return Ok(if e.body.iter().all(|l| l.trim().is_empty()) {
            Some(String::new())
        } else {
            None
        });
    }
    if is_null(inline) && e.body.iter().all(|l| l.trim().is_empty()) {
        return Ok(Some(String::new()));
    }
    let mut parts = vec![unquote(inline)?];
    if !inline.starts_with('"') && !inline.starts_with('\'') {
        parts.extend(
            e.body
                .iter()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty()),
        );
    }
    Ok(Some(parts.join(" ")))
}

/// `metadata.<key>` as a string, from the nested mapping's direct children.
fn nested_text(e: &Entry<'_>, key: &str) -> Result<Option<String>, Refusal> {
    let base = e
        .body
        .iter()
        .filter(|l| !l.trim().is_empty())
        .map(|l| indent_of(l))
        .min()
        .unwrap_or(0);
    for l in &e.body {
        if l.trim().is_empty() || indent_of(l) != base {
            continue;
        }
        if let Some((k, v)) = l.trim().split_once(':') {
            if k.trim() == key {
                let v = strip_comment(v.trim());
                if v.is_empty() || is_null(v) || v.starts_with(['|', '>', '[', '{']) {
                    return Ok(None);
                }
                return Ok(Some(unquote(v)?));
            }
        }
    }
    Ok(None)
}

/// Validates a `SKILL.md` against the Agent Skills rules (`name` is 1–64 characters of `a-z0-9-` without a leading,
/// trailing or double hyphen and equals `dir_name`; `description` is 1–1024 characters; `compatibility`, when present,
/// is at most 500) and returns the fields the harness uses. Every violation is `package-invalid`.
pub fn validate_skill_md(raw: &str, dir_name: &str) -> Result<SkillFront, Refusal> {
    let front = parse_skill_md(raw)?;
    if front.name != dir_name {
        return Err(invalid(format!(
            "name {:?} must match the skill's directory name {dir_name:?}",
            front.name
        )));
    }
    Ok(front)
}

/// [`validate_skill_md`] without the directory-name match, for an archive whose files sit at its root (there is no
/// directory to compare with).
pub fn parse_skill_md(raw: &str) -> Result<SkillFront, Refusal> {
    let lines = split_frontmatter(raw)?;
    let all = entries(&lines)?;
    let mut seen = std::collections::HashSet::new();
    for e in &all {
        if !seen.insert(e.key) {
            return Err(invalid(format!(
                "the SKILL.md frontmatter repeats the key {:?}",
                e.key
            )));
        }
    }
    let get = |key: &str| all.iter().find(|e| e.key == key);
    let text = |key: &str| -> Result<Option<String>, Refusal> {
        match get(key) {
            None => Ok(None),
            Some(e) => text_value(e)?
                .map(Some)
                .ok_or_else(|| invalid(format!("the frontmatter key {key:?} must be a string"))),
        }
    };

    let name = text("name")?.ok_or_else(|| invalid("the SKILL.md frontmatter has no name"))?;
    if !valid_skill_name(&name) {
        return Err(invalid(format!(
            "name {name:?} breaks the Agent Skills rule (1-64 characters of a-z, 0-9 and -, no leading, trailing or double hyphen)"
        )));
    }
    let description = text("description")?
        .ok_or_else(|| invalid("the SKILL.md frontmatter has no description"))?;
    let dlen = description.chars().count();
    if dlen == 0 || dlen > 1024 {
        return Err(invalid(format!(
            "description is {dlen} characters (1-1024 required)"
        )));
    }
    if let Some(c) = text("compatibility")? {
        let n = c.chars().count();
        if n > 500 {
            return Err(invalid(format!(
                "compatibility is {n} characters (at most 500)"
            )));
        }
    }
    let license = text("license")?.filter(|s| !s.is_empty());
    let version = match text("version")?.filter(|s| !s.is_empty()) {
        Some(v) => Some(v),
        None => match get("metadata") {
            Some(e) => nested_text(e, "version")?.filter(|s| !s.is_empty()),
            None => None,
        },
    };
    Ok(SkillFront {
        name,
        description,
        license,
        version,
    })
}
