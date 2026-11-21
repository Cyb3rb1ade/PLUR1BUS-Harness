//! The named exception for the engine's model artifacts (TypeScript: `egress/model-downloads.ts`): credential-free reads of
//! model repository files from the public model catalogue. Provider inference and arbitrary URLs never qualify.
use super::{read_url, Url};
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
///
/// Host, port, credentials, path and query all come from one parse of the URL (the gate's reader), as they come from one
/// `new URL(request.url)` in TypeScript: a second reader for the path could place the end of the authority elsewhere.
pub fn is_model_artifact_request(request: &ModelRequest) -> bool {
    let Some(parsed) = read_url(&request.url) else {
        return false;
    };
    let url = Url::of(&parsed);
    let method = normalise_method(&request.method);
    // `URL.search` is empty for a URL without a query and for a bare `?`.
    let search = parsed.query().is_some_and(|q| !q.is_empty());
    if !matches!(method.as_str(), "GET" | "HEAD")
        || request.has_body
        || url.scheme != "https"
        || url.port.is_some()
        || !url.username.is_empty()
        || !url.password.is_empty()
        || search
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
    let pathname = parsed.path();
    safe && artifact_path(pathname) && !pathname.split('/').any(|p| p == ".." || p == ".")
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
