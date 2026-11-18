//! The named exception for the engine's model artifacts (TypeScript: `egress/model-downloads.ts`): credential-free reads of
//! model repository files from the public model catalogue. Provider inference and arbitrary URLs never qualify.
use crate::config::endpoint::Url;
use serde_json::{Map, Value};

/// Named public model-catalogue destinations observed for the engine's pinned artifacts. No API or provider wildcard.
pub const MODEL_DOWNLOAD_HOSTS: [&str; 2] = ["huggingface.co", "us.aws.cdn.hf.co"];

/// The parts of a fetch `Request` the exception reads.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ModelRequest {
    /// The method as given (normalised like `Request` does: the six standard methods are upper-cased).
    pub method: String,
    /// The URL as given to `new Request`.
    pub url: String,
    /// Header names as given (`Headers` lower-cases them).
    pub header_names: Vec<String>,
    /// Whether the request carries a body.
    pub has_body: bool,
}

/// `Request`'s method normalisation: `DELETE`, `GET`, `HEAD`, `OPTIONS`, `POST` and `PUT` match without regard to ASCII
/// case and are upper-cased; any other method stays as written.
pub fn normalise_method(m: &str) -> String {
    let up = m.to_ascii_uppercase();
    if matches!(
        up.as_str(),
        "DELETE" | "GET" | "HEAD" | "OPTIONS" | "POST" | "PUT"
    ) {
        up
    } else {
        m.to_owned()
    }
}

/// The path percent-encode set of the URL Standard (C0 controls, space, `"`, `#`, `<`, `>`, `?`, `` ` ``, `{`, `}`, and
/// everything above `~`).
fn encode_path_char(c: char, out: &mut String) {
    if c.is_ascii()
        && !(c <= '\u{1f}'
            || matches!(
                c,
                ' ' | '"' | '#' | '<' | '>' | '?' | '`' | '{' | '}' | '\u{7f}'
            ))
    {
        out.push(c);
        return;
    }
    let mut buf = [0u8; 4];
    for b in c.encode_utf8(&mut buf).bytes() {
        out.push_str(&format!("%{b:02X}"));
    }
}

fn single_dot(s: &str) -> bool {
    s == "." || s.eq_ignore_ascii_case("%2e")
}

fn double_dot(s: &str) -> bool {
    let l = s.to_ascii_lowercase();
    matches!(l.as_str(), ".." | ".%2e" | "%2e." | "%2e%2e")
}

/// `URL.pathname` and `URL.search` of a URL with a special scheme (`https:`), from the text after the authority. Tabs and
/// newlines are already removed. The dot segments are resolved as the URL Standard's path state resolves them.
fn path_and_search(raw: &str) -> Option<(String, String)> {
    let text: String = raw
        .trim_matches(|c: char| c <= '\u{20}')
        .chars()
        .filter(|c| !matches!(c, '\t' | '\n' | '\r'))
        .collect();
    let colon = text.find(':')?;
    let rest = text[colon + 1..].trim_start_matches(['/', '\\']);
    let end_auth = rest.find(['/', '\\', '?', '#']).unwrap_or(rest.len());
    let after = &rest[end_auth..];
    let after = after.split('#').next().unwrap_or("");
    let (path, query) = match after.find('?') {
        Some(q) => (&after[..q], &after[q + 1..]),
        None => (after, ""),
    };
    let mut segments: Vec<String> = Vec::new();
    let body = path.strip_prefix(['/', '\\']).unwrap_or(path);
    let parts: Vec<&str> = body.split(['/', '\\']).collect();
    for (i, seg) in parts.iter().enumerate() {
        let last = i + 1 == parts.len();
        let mut enc = String::new();
        for c in seg.chars() {
            encode_path_char(c, &mut enc);
        }
        if double_dot(&enc) {
            segments.pop();
            if last {
                segments.push(String::new());
            }
        } else if single_dot(&enc) {
            if last {
                segments.push(String::new());
            }
        } else {
            segments.push(enc);
        }
    }
    let search = if query.is_empty() {
        String::new()
    } else {
        format!("?{query}")
    };
    Some((format!("/{}", segments.join("/")), search))
}

/// `/^\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/resolve\/[A-Za-z0-9._-]+\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.(?:json|onnx|onnx_data|txt|model)$/`
fn artifact_path(p: &str) -> bool {
    let name = |s: &str| {
        !s.is_empty()
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    };
    let Some(body) = p.strip_prefix('/') else {
        return false;
    };
    let segs: Vec<&str> = body.split('/').collect();
    if segs.len() < 5 || segs[2] != "resolve" || !segs.iter().all(|s| name(s)) {
        return false;
    }
    let file = segs[segs.len() - 1];
    // The last segment is `stem.ext` with a non-empty stem: the regex needs one name character before the final dot.
    ["json", "onnx", "onnx_data", "txt", "model"]
        .iter()
        .any(|ext| {
            file.strip_suffix(ext)
                .and_then(|s| s.strip_suffix('.'))
                .is_some_and(|stem| !stem.is_empty())
        })
}

/// `isModelArtifactRequest`: only a credential-free GET or HEAD of a repository file on the catalogue host qualifies.
pub fn is_model_artifact_request(request: &ModelRequest) -> bool {
    let Some(url) = Url::parse(&request.url) else {
        return false;
    };
    let Some((pathname, search)) = path_and_search(&request.url) else {
        return false;
    };
    let method = normalise_method(&request.method);
    if !matches!(method.as_str(), "GET" | "HEAD")
        || request.has_body
        || url.scheme != "https"
        || url.port.is_some()
        || !url.username.is_empty()
        || !url.password.is_empty()
        || !search.is_empty()
    {
        return false;
    }
    if url.hostname != "huggingface.co" {
        return false;
    }
    let safe = request.header_names.iter().all(|n| {
        let n = n.to_ascii_lowercase();
        matches!(n.as_str(), "accept" | "user-agent" | "range")
    });
    safe && artifact_path(&pathname) && !pathname.split('/').any(|p| p == ".." || p == ".")
}

/// `modelDownloadPolicy`: for artifact requests this host list is authoritative, even when ordinary egress permits `*`.
/// `Err` where the TypeScript function throws a `TypeError` (a `modelDownloads` member that is `null`).
pub fn model_download_policy(config: &Value) -> Result<Value, &'static str> {
    let raw = config.get("modelDownloads");
    let default_hosts = || Value::from(MODEL_DOWNLOAD_HOSTS.to_vec());
    let entries = match raw.and_then(|r| r.get("allowHosts")) {
        None | Some(Value::Null) => default_hosts(),
        Some(v) => v.clone(),
    };
    let enabled = match raw {
        None => true,
        Some(Value::Null) => return Err("TypeError"),
        Some(r) => r.get("enabled") == Some(&Value::Bool(true)),
    };
    let valid = entries.as_array().is_some_and(|a| {
        a.iter().all(|h| {
            h.as_str()
                .is_some_and(|s| MODEL_DOWNLOAD_HOSTS.contains(&s))
        })
    });
    let mut out: Map<String, Value> = config.as_object().cloned().unwrap_or_default();
    out.insert(
        "allowHosts".to_owned(),
        if enabled && valid {
            entries
        } else {
            Value::Array(Vec::new())
        },
    );
    Ok(Value::Object(out))
}
