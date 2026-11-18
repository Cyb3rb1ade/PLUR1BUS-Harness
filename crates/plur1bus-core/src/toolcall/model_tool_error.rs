//! The model-only failure boundary (`model-tool-error.ts`, N1): the failed tool envelope the model sees, separate from
//! the one logs and audit keep. Every string passes the log redactor (exact secret values and their encodings, the key,
//! pattern, URL and path rules) and then the home step: the process's home directory (and its resolved spelling) becomes
//! `~`, any other user's home folder name becomes `<user>`. An internal failure category shows only a fixed sentence; a
//! tool exception shows its first line, at most 300 characters; a typed failure keeps its details under the dispatcher's
//! code, with its own code as `sourceCode` when that is a plain identifier. The whole envelope stays within 4096
//! characters as JSON.
//!
//! The envelope (`ToolFailure` of the dispatcher, P4-43) is a JSON value here. The process's home directory and its
//! resolved spelling are given to [`ModelToolErrors::new`] (TypeScript reads `os.homedir()` and resolves it once at
//! module load); a call may override them, as the tests do. Regular expressions run as JavaScript runs them: without the
//! `u` flag, over UTF-16 code units, case-insensitive (non-Unicode `Canonicalize`) on Windows and macOS.
use super::json::{JsStr, Obj, V};
use super::validation::Thrown;
use crate::js;
use crate::metrics::registry::js_number_to_string;
use plur1bus_log_schema::redact::{
    is_secret_key, well_formed_prefix_units, RedactOptions, Redactor, SecretFormsCache,
    SecretMatcher, MAX_DEPTH,
};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, OnceLock};

const MAX_DETAIL_CHARS: usize = 4096;
const MAX_STRING_CHARS: usize = 500;
const MAX_EXCEPTION_CHARS: usize = 300;
const MAX_ID_CHARS: usize = 128;
/// The replacement of a value under a credential-looking key (`tag("key")` of the redaction data's template).
const KEY_TAG: &str = "[REDACTED:key]";

/// The fixed sentence of an internal failure category (`FIXED_MESSAGES`).
pub fn fixed_message(category: &str) -> Option<&'static str> {
    match category {
        "internal-error" => Some("The tool call failed because of an internal error."),
        "classification-failure" => Some("The tool call could not be classified safely."),
        "approval-port-failure" => {
            Some("The approval service is unavailable; the tool did not run.")
        }
        "audit-unavailable" => Some("The audit trail is unavailable; the tool did not run."),
        _ => None,
    }
}

const NAME: &str = r#"[^\\/\r\n"'<>|:;,()[\]{}]+"#;
const BEFORE: &str = r"(?:(?<![A-Za-z0-9_./\\~-])|(?<=file://)|(?<=file:///))";

/// `USER_HOME`: a home folder of any user on any platform, with the user's name as the third group.
fn user_home() -> Option<&'static regress::Regex> {
    static PATTERN: OnceLock<Option<regress::Regex>> = OnceLock::new();
    PATTERN
        .get_or_init(|| {
            let pattern = format!(
                "{BEFORE}{}{}{}{}{}{}([\\\\/]+)({NAME})",
                r#"(/(?:var/)?home|/Users|/mnt/[A-Za-z]/Users|/Volumes/[^/\\\r\n"'<>|:;,()[\]{}]+/Users"#,
                r"|(?:[\\/]{2,4}\?[\\/]{1,2})?[A-Za-z]:[\\/]+Users",
                r"|[\\/]{2,}wsl(?:\$|\.localhost)[\\/]+",
                r#"[^\\/\r\n"'<>|:;,()[\]{}]+"#,
                r"[\\/]+(?:var[\\/]+)?home",
                ")",
            );
            // `gi`: the global part is the replace loop, the case-insensitive part is spelled out (see `fold_pattern`).
            regress::Regex::with_flags(&fold_pattern(&pattern), "").ok()
        })
        .as_ref()
}

/// The units that JavaScript's non-Unicode case-insensitive matching treats as one (`Canonicalize`: upper-case a unit,
/// but keep it where the result is not one unit or would turn a non-ASCII unit into an ASCII one), by canonical unit.
fn case_classes() -> &'static HashMap<u16, Vec<u16>> {
    static CLASSES: OnceLock<HashMap<u16, Vec<u16>>> = OnceLock::new();
    CLASSES.get_or_init(|| {
        let mut classes: HashMap<u16, Vec<u16>> = HashMap::new();
        for u in 0..=u16::MAX {
            classes.entry(js::canonicalize_unit(u)).or_default().push(u);
        }
        classes
    })
}

/// One code unit as a pattern without the `u` flag: `\uXXXX`, or under `i` the class of every unit that matches it.
/// The engine's own `i` is not used: `regress` folds `ſ` (U+017F) into `s` and the Kelvin sign into `k`, which
/// JavaScript does not without `u`.
fn literal_unit(u: u16, icase: bool) -> String {
    let escape = |x: &u16| format!("\\u{x:04X}");
    match case_classes().get(&js::canonicalize_unit(u)) {
        Some(class) if icase && class.len() > 1 => {
            format!("[{}]", class.iter().map(escape).collect::<String>())
        }
        // A surrogate stands in a class of its own: `regress` would read two escaped halves as one code point, which
        // without `u` JavaScript never does.
        _ if (0xd800..=0xdfff).contains(&u) => format!("[{}]", escape(&u)),
        _ => escape(&u),
    }
}

/// `escapePattern(segment)` of a home directory's segment, as literal units (each case-folded under `i`).
fn literal(text: &str, icase: bool) -> String {
    text.encode_utf16()
        .map(|u| literal_unit(u, icase))
        .collect()
}

/// A pattern's letters outside classes and escapes as explicit case classes (`[fF]`): what `i` does to the ASCII
/// letters of a fixed pattern. Classes here hold no letter that `i` would widen (`[A-Za-z]` already has both cases).
fn fold_pattern(pattern: &str) -> String {
    let mut out = String::new();
    let mut chars = pattern.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\\' => {
                out.push(c);
                if let Some(next) = chars.next() {
                    out.push(next);
                }
            }
            '[' => {
                out.push(c);
                while let Some(d) = chars.next() {
                    out.push(d);
                    if d == '\\' {
                        if let Some(next) = chars.next() {
                            out.push(next);
                        }
                    } else if d == ']' {
                        break;
                    }
                }
            }
            c if c.is_ascii_alphabetic() => {
                out.push('[');
                out.push(c.to_ascii_lowercase());
                out.push(c.to_ascii_uppercase());
                out.push(']');
            }
            c => out.push(c),
        }
    }
    out
}

fn is_drive(text: &str) -> bool {
    let b = text.as_bytes();
    b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':'
}

/// `homePatterns`: the home directory and its resolved spelling (each once, longer first), as patterns that match the
/// directory where it starts a path and ends at a separator, white space, punctuation or the end.
fn home_patterns(home: &str, real_home: &str, platform: &str) -> Vec<regress::Regex> {
    // `gi` / `g`: the global part is the replace loop, the case-insensitive part is spelled out.
    let icase = platform == "win32" || platform == "darwin";
    let fold = |p: &str| if icase { fold_pattern(p) } else { p.to_owned() };
    let mut paths: Vec<&str> = Vec::new();
    for p in [home, real_home] {
        if !paths.contains(&p) && p.encode_utf16().count() > 1 {
            paths.push(p);
        }
    }
    // A stable sort, longest first.
    paths.sort_by_key(|p| std::cmp::Reverse(p.encode_utf16().count()));
    paths
        .iter()
        .filter_map(|path| {
            let normal = path.strip_prefix(r"\\?\").unwrap_or(path);
            let normal = normal.trim_end_matches(['\\', '/']);
            let prefix = if is_drive(normal) {
                r"(?:[\\/]{2,4}\?[\\/]{1,2})?"
            } else {
                ""
            };
            let body = normal
                .split(['\\', '/'])
                .map(|segment| literal(segment, icase))
                .collect::<Vec<_>>()
                .join(r"[\\/]+");
            let pattern = format!(
                "{}{}{body}{}",
                fold(BEFORE),
                fold(prefix),
                fold(r#"(?=$|[\\/\s"'<>|:;,()[\]{}])"#)
            );
            regress::Regex::with_flags(&pattern, "").ok()
        })
        .collect()
}

/// `text.replace(regex, ...)` of a global regular expression without the `u` flag: every match from left to right, an
/// empty match stepping one code unit on.
fn replace_all(
    regex: &regress::Regex,
    units: &[u16],
    replacement: impl Fn(&regress::Match, &[u16]) -> Vec<u16>,
) -> Vec<u16> {
    let mut out = Vec::with_capacity(units.len());
    let mut last = 0;
    let mut position = 0;
    while position <= units.len() {
        let Some(m) = regex.find_from_ucs2(units, position).next() else {
            break;
        };
        out.extend_from_slice(&units[last..m.start()]);
        out.extend(replacement(&m, units));
        last = m.end();
        position = if m.end() == m.start() {
            m.end() + 1
        } else {
            m.end()
        };
    }
    out.extend_from_slice(&units[last.min(units.len())..]);
    out
}

/// `clip(text, limit)`: at most `limit` code units, the last one `…` when cut, without a lone surrogate.
fn clip(units: &[u16], limit: usize) -> JsStr {
    if units.len() > limit {
        JsStr::from(well_formed_prefix_units(units, limit - 1) + "…")
    } else {
        JsStr::from(String::from_utf16_lossy(units))
    }
}

fn type_error(message: &str) -> Thrown {
    Thrown {
        name: "TypeError",
        message: message.to_owned(),
    }
}

fn clip_v(v: Option<&V>, limit: usize) -> Result<V, Thrown> {
    match v {
        Some(V::Str(s)) => Ok(V::Str(clip(s.units(), limit))),
        _ => Err(type_error("text.toWellFormed is not a function")),
    }
}

/// Which secret source a call masks with (`secretMatcher`, `secretForms`, or the raw `secrets`).
pub enum SecretSource<'a> {
    /// A compiled matcher from the current secret set; takes precedence.
    Matcher(Arc<SecretMatcher>),
    /// Precomputed forms from the current secret source (masked as they are, not encoded again).
    Forms(&'a [String]),
    /// The raw values (their encodings are derived, and reused while the membership is the same).
    Raw(&'a [&'a str]),
}

/// The per-call options (`ModelToolErrorOptions`): `home` and `real_home` override the process's, `platform` is
/// `process.platform` (`win32` and `darwin` compare paths without case).
pub struct ModelToolErrorOptions<'a> {
    /// Where the secrets come from.
    pub secrets: SecretSource<'a>,
    /// The home directory, instead of the process's.
    pub home: Option<&'a str>,
    /// Its resolved spelling.
    pub real_home: Option<&'a str>,
    /// `process.platform`.
    pub platform: &'a str,
}

/// The boundary with its two caches: the raw secret values' forms by membership, and the matcher of the last legacy
/// form list (TypeScript keeps both at module level).
pub struct ModelToolErrors {
    process_home: String,
    process_real_home: String,
    raw: SecretFormsCache,
    legacy: Option<(HashSet<String>, Arc<SecretMatcher>)>,
}

impl ModelToolErrors {
    /// The boundary for a process whose home directory is `home`, resolved `real_home` (the home itself where it
    /// cannot be resolved).
    pub fn new(home: &str, real_home: &str) -> Self {
        ModelToolErrors {
            process_home: home.to_owned(),
            process_real_home: real_home.to_owned(),
            raw: SecretFormsCache::default(),
            legacy: None,
        }
    }

    /// The matcher of the last legacy form list (tests check that equal membership reuses it).
    #[cfg(test)]
    pub(super) fn legacy_matcher(&self) -> Option<Arc<SecretMatcher>> {
        self.legacy.as_ref().map(|(_, m)| Arc::clone(m))
    }

    fn matcher(&mut self, source: &SecretSource<'_>) -> Arc<SecretMatcher> {
        match source {
            SecretSource::Matcher(m) => Arc::clone(m),
            SecretSource::Raw(values) => {
                Arc::clone(&self.raw.snapshot(values.iter().copied()).matcher)
            }
            SecretSource::Forms(forms) => {
                let members: HashSet<String> = forms.iter().cloned().collect();
                if let Some((known, matcher)) = &self.legacy {
                    if *known == members {
                        return Arc::clone(matcher);
                    }
                }
                let mut ordered: Vec<Vec<u16>> = Vec::new();
                let mut seen = HashSet::new();
                for form in forms.iter() {
                    if seen.insert(form.as_str()) {
                        ordered.push(form.encode_utf16().collect());
                    }
                }
                let matcher = Arc::new(SecretMatcher::new(ordered));
                self.legacy = Some((members, Arc::clone(&matcher)));
                matcher
            }
        }
    }

    /// `modelToolError(output, secrets, options)`: the model-safe copy of a failed envelope. Throws (a `TypeError`)
    /// where the envelope does not have the dispatcher's shape, as TypeScript does.
    pub fn model_tool_error(
        &mut self,
        output: &V,
        options: &ModelToolErrorOptions<'_>,
    ) -> Result<V, Thrown> {
        let matcher = self.matcher(&options.secrets);
        let redactor = Redactor::new(RedactOptions {
            secret_matcher: Some(Arc::clone(&matcher)),
            ..RedactOptions::default()
        })
        .map_err(|e| Thrown::error(e.0))?;
        let home = options.home.unwrap_or(&self.process_home);
        let real_home = options.real_home.unwrap_or(match options.home {
            None => &self.process_real_home,
            Some(home) => home,
        });
        let patterns = home_patterns(home, real_home, options.platform);
        let text = |input: &JsStr| -> JsStr {
            let mut result = input.units().to_vec();
            for pattern in &patterns {
                result = replace_all(pattern, &result, |_, _| vec![u16::from(b'~')]);
            }
            if let Some(user) = user_home() {
                result = replace_all(user, &result, |m, units| {
                    let mut out = Vec::new();
                    for group in [1, 2] {
                        if let Some(r) = m.group(group) {
                            out.extend_from_slice(&units[r]);
                        }
                    }
                    out.extend("<user>".encode_utf16());
                    out
                });
            }
            clip(&result, MAX_STRING_CHARS)
        };
        let mut safe = map_strings(&redact(&redactor, &matcher, output, 0), &text);

        let original_error = output.get("error").ok_or_else(|| {
            type_error("Cannot read properties of undefined (reading 'internalFailure')")
        })?;
        let code = original_error.get("code").cloned();
        let internal = original_error.get("internalFailure").cloned();
        let V::Obj(envelope) = &mut safe else {
            return Err(type_error("Cannot read properties of undefined"));
        };
        let mut error = match envelope.get("error") {
            Some(V::Obj(e)) => e.clone(),
            _ => return Err(type_error("Cannot convert undefined or null to object")),
        };
        error.remove("internalFailure");
        let typed = error.remove("typedFailure");
        let error = if let Some(internal) = internal {
            let mut fixed = Obj::new();
            if let Some(code) = code {
                fixed.set("code", code);
            }
            match internal.as_js().map(JsStr::lossy).as_deref() {
                Some(category) if fixed_message(category).is_some() => {
                    fixed.set("message", V::s(fixed_message(category).unwrap_or_default()));
                }
                // `FIXED_MESSAGES["__proto__"]` is `Object.prototype`, which `JSON.stringify` writes as `{}`; any other
                // name is `undefined` or a function, which it leaves out.
                Some("__proto__") => fixed.set("message", V::Obj(Obj::new())),
                _ => {}
            }
            fixed
        } else {
            if let Some(typed) = typed.filter(V::truthy) {
                error = spread(&typed);
                match &code {
                    Some(c) => error.set("code", c.clone()),
                    None => {
                        error.remove("code");
                    }
                }
                match typed.get("code") {
                    Some(c) => error.set("sourceCode", c.clone()),
                    None => {
                        error.remove("sourceCode");
                    }
                }
            }
            let limit = if code.as_ref().is_some_and(|c| c.is_str("tool-failed")) {
                MAX_EXCEPTION_CHARS
            } else {
                MAX_STRING_CHARS
            };
            let first_line = match error.get("message") {
                Some(V::Str(m)) => m
                    .units()
                    .split(|u| matches!(*u, 0x0a | 0x0d | 0x2028 | 0x2029))
                    .next()
                    .unwrap_or(&[])
                    .to_vec(),
                Some(_) => return Err(type_error("safe.error.message.split is not a function")),
                None => {
                    return Err(type_error(
                        "Cannot read properties of undefined (reading 'split')",
                    ))
                }
            };
            error.set("message", V::Str(clip(&first_line, limit)));
            if let Some(source) = error.get("sourceCode") {
                if !source_code_ok(&source.to_js_string()) {
                    error.remove("sourceCode");
                }
            }
            error
        };
        envelope.set("error", V::Obj(error));
        bounded_failure(safe)
    }
}

/// `SOURCE_CODE`: `/^[a-z0-9_.-]{1,64}$/`.
fn source_code_ok(text: &JsStr) -> bool {
    let units = text.units();
    (1..=64).contains(&units.len())
        && units.iter().all(|u| {
            u8::try_from(*u).is_ok_and(|b| {
                b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'_' | b'.' | b'-')
            })
        })
}

/// `{ ...value }`: an object's own members, a string's or an array's indices; nothing for anything else.
fn spread(value: &V) -> Obj {
    match value {
        V::Obj(o) => o.clone(),
        V::Arr(a) => Obj::from_pairs(
            a.iter()
                .enumerate()
                .map(|(i, v)| (JsStr::from(i.to_string()), v.clone()))
                .collect(),
        ),
        V::Str(s) => Obj::from_pairs(
            s.units()
                .iter()
                .enumerate()
                .map(|(i, u)| (JsStr::from(i.to_string()), V::Str(JsStr::new(vec![*u]))))
                .collect(),
        ),
        _ => Obj::new(),
    }
}

/// `redactor.value(v)` of a redactor with the exact-value matcher and no other option: every string through the rules, a
/// number whose text is a registered secret becomes 0, a value under a credential-looking key (not `null`) becomes the key
/// tag, and nesting beyond the bound becomes a marker.
fn redact(redactor: &Redactor, matcher: &SecretMatcher, v: &V, depth: usize) -> V {
    match v {
        V::Str(s) => V::Str(JsStr::from(redactor.text_units(s.units()))),
        V::Num(n) if !matcher.find_text_spans(&js_number_to_string(*n)).is_empty() => V::Num(0.0),
        V::Arr(a) => {
            if depth >= MAX_DEPTH {
                return V::s("[TRUNCATED:depth]");
            }
            V::Arr(
                a.iter()
                    .map(|x| redact(redactor, matcher, x, depth + 1))
                    .collect(),
            )
        }
        V::Obj(o) => {
            if depth >= MAX_DEPTH {
                return V::s("[TRUNCATED:depth]");
            }
            let mut out = Obj::new();
            for (k, x) in o.entries() {
                // A key the data cannot judge counts as a credential: fail closed.
                let secret = is_secret_key(&k.lossy()).unwrap_or(true);
                let value = if secret && !matches!(x, V::Null) {
                    V::s(KEY_TAG)
                } else {
                    redact(redactor, matcher, x, depth + 1)
                };
                out.set(k.clone(), value);
            }
            V::Obj(out)
        }
        other => other.clone(),
    }
}

/// `mapStrings(value, text)`: every string value (not the keys) through `text`.
fn map_strings(v: &V, text: &dyn Fn(&JsStr) -> JsStr) -> V {
    match v {
        V::Str(s) => V::Str(text(s)),
        V::Arr(a) => V::Arr(a.iter().map(|x| map_strings(x, text)).collect()),
        V::Obj(o) => {
            let mut out = Obj::new();
            for (k, x) in o.entries() {
                out.set(k.clone(), map_strings(x, text));
            }
            V::Obj(out)
        }
        other => other.clone(),
    }
}

/// `boundedFailure(output)`: the envelope where its JSON fits 4096 characters, else its identity clipped and its details
/// dropped.
fn bounded_failure(output: V) -> Result<V, Thrown> {
    if output.stringify().encode_utf16().count() <= MAX_DETAIL_CHARS {
        return Ok(output);
    }
    let get = |path: &[&str]| -> Option<&V> {
        let mut v = &output;
        for key in path {
            v = v.get(key)?;
        }
        Some(v)
    };
    let missing = || type_error("Cannot read properties of undefined");
    let error = get(&["error"]).ok_or_else(missing)?;
    let origin = get(&["provenance", "origin"]).ok_or_else(missing)?;
    let mut e = Obj::new();
    for key in ["code", "message", "sourceCode"] {
        if let Some(v) = error.get(key) {
            e.set(key, v.clone());
        }
    }
    let mut o = Obj::new();
    o.set("system", clip_v(origin.get("system"), MAX_ID_CHARS)?);
    o.set(
        "agent",
        match origin.get("agent") {
            Some(V::Null) => V::Null,
            agent => clip_v(agent, MAX_ID_CHARS)?,
        },
    );
    o.set("principal", clip_v(origin.get("principal"), MAX_ID_CHARS)?);
    if let Some(trust) = origin.get("trust") {
        o.set("trust", trust.clone());
    }
    let mut provenance = Obj::new();
    provenance.set("origin", V::Obj(o));
    if let Some(hops) = get(&["provenance", "hops"]) {
        provenance.set("hops", hops.clone());
    }
    provenance.set("transformedBy", V::Arr(Vec::new()));
    let mut out = Obj::new();
    out.set("callId", clip_v(output.get("callId"), MAX_ID_CHARS)?);
    out.set("tool", clip_v(output.get("tool"), MAX_ID_CHARS)?);
    out.set("isError", V::Bool(true));
    out.set("error", V::Obj(e));
    out.set("provenance", V::Obj(provenance));
    if let Some(meta) = output.get("meta") {
        out.set("meta", meta.clone());
    }
    Ok(V::Obj(out))
}
