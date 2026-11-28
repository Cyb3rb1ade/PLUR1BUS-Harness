use super::is_loopback;
use crate::{Adapter, Config, ErrorKind, HttpCancellation, Ports, ProviderError, Timeouts, Wire};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use std::io::{Read, Take};
use std::time::Duration;
use url::Url;

const MAX_BODY_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Dialect {
    Ollama,
    OpenAi,
}

impl Dialect {
    fn list_path(self) -> &'static str {
        match self {
            Self::Ollama => "/api/tags",
            Self::OpenAi => "/v1/models",
        }
    }

    fn model_fields(self) -> (&'static str, &'static str) {
        match self {
            Self::Ollama => ("models", "name"),
            Self::OpenAi => ("data", "id"),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProbeState {
    Refused,
    Unreachable,
    Timeout,
    Protocol,
    Empty,
    Ok,
}

#[derive(Debug, Serialize)]
pub struct LocalModel {
    pub id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub state: ProbeState,
    pub base_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dialect: Option<Dialect>,
    pub models: Vec<LocalModel>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http_status: Option<u16>,
}

impl ProbeResult {
    fn failure(base_url: &str, state: ProbeState, detail: impl Into<String>) -> Self {
        Self {
            state,
            base_url: base_url.into(),
            dialect: None,
            models: Vec::new(),
            detail: Some(detail.into()),
            http_status: None,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct ProbeOptions {
    pub timeout: Duration,
    pub allow_non_loopback: bool,
}

impl Default for ProbeOptions {
    fn default() -> Self {
        Self {
            timeout: Duration::from_millis(1500),
            allow_non_loopback: false,
        }
    }
}

/// Probe a local model server with keyless, pinned GETs in the caller's dialect order.
pub fn probe_endpoint(
    origin: &str,
    dialects: &[Dialect],
    options: ProbeOptions,
    ports: &dyn Ports,
) -> Result<ProbeResult, ProviderError> {
    let refused = |detail| ProbeResult::failure(origin, ProbeState::Refused, detail);
    let mut uri = match Url::parse(origin) {
        Ok(uri)
            if matches!(uri.scheme(), "http" | "https")
                && uri.username().is_empty()
                && uri.password().is_none()
                && uri.query().is_none()
                && uri.fragment().is_none()
                && uri.path() == "/" =>
        {
            uri
        }
        _ => return Ok(refused("not a plain http(s) origin")),
    };
    let loopback = is_loopback(&uri);
    if !loopback && !options.allow_non_loopback {
        return Ok(refused("not a loopback address"));
    }
    uri.set_path("/v1");
    let base_url = uri.as_str().to_owned();
    let adapter = if loopback {
        Adapter::keyless_loopback(&base_url, Config::default())?
    } else {
        Adapter::new(Wire::ChatCompletions, &base_url, Config::default())?
    };
    let timeout = if options.timeout.is_zero() {
        ProbeOptions::default().timeout
    } else {
        options.timeout.min(Duration::from_millis(i32::MAX as u64))
    };
    let timeouts = Timeouts {
        headers: Some(timeout),
        idle: Some(timeout),
        total: Some(timeout),
    };
    let mut best: Option<ProbeResult> = None;
    for &dialect in dialects {
        uri.set_path(dialect.list_path());
        let signal = HttpCancellation::default();
        let result = match adapter.probe_get(&uri, ports, timeouts, &signal) {
            Ok(response) => {
                let status = response.status().as_u16();
                if (300..400).contains(&status) {
                    let mut error = ProbeResult::failure(
                        &base_url,
                        ProbeState::Protocol,
                        "redirect not followed",
                    );
                    error.http_status = Some(status);
                    error
                } else if !response.status().is_success() {
                    let mut error = ProbeResult::failure(
                        &base_url,
                        ProbeState::Protocol,
                        format!("HTTP {status}"),
                    );
                    error.http_status = Some(status);
                    error
                } else {
                    let mut reader = signal
                        .reader(response.into_body(), || ports.cancelled())
                        .map_err(|error| crate::response::read_error(&error))?
                        .take(MAX_BODY_BYTES + 1);
                    let result = read_models(&mut reader, dialect, status, &base_url, timeout);
                    crate::transport::abort(ports)?;
                    result
                }
            }
            Err(error) if error.kind == ErrorKind::Aborted => return Err(error),
            Err(error) if error.kind == ErrorKind::Timeout => ProbeResult::failure(
                &base_url,
                ProbeState::Timeout,
                format!("no answer within {} ms", timeout.as_millis()),
            ),
            Err(error) if error.kind == ErrorKind::Network => {
                ProbeResult::failure(&base_url, ProbeState::Unreachable, "connection failed")
            }
            Err(_) => return Ok(refused("blocked by egress policy")),
        };
        if ports.cancelled() {
            return Err(ProviderError::new(
                ErrorKind::Aborted,
                "call aborted by the caller",
            ));
        }
        let terminal = matches!(
            result.state,
            ProbeState::Ok | ProbeState::Unreachable | ProbeState::Timeout
        );
        if best
            .as_ref()
            .is_none_or(|previous| previous.state < result.state)
        {
            best = Some(result);
        }
        if terminal {
            break;
        }
    }
    Ok(best.unwrap_or_else(|| refused("no dialect to try")))
}

fn parse_model_list(dialect: Dialect, bytes: &[u8]) -> Result<Vec<LocalModel>, String> {
    let body = serde_json::from_str::<Value>(&String::from_utf8_lossy(bytes))
        .map_err(|_| "response is not JSON")?;
    let (list_field, id_field) = dialect.model_fields();
    let list = body[list_field]
        .as_array()
        .ok_or_else(|| format!("response has no {list_field} array"))?;
    let mut ids = HashSet::new();
    let models: Vec<_> = list
        .iter()
        .take(1000)
        .filter_map(|item| {
            let id = item[id_field].as_str()?;
            (!id.is_empty() && id.encode_utf16().count() <= 256 && ids.insert(id))
                .then(|| LocalModel { id: id.into() })
        })
        .collect();
    if !list.is_empty() && models.is_empty() {
        return Err("model entries carry no ids".into());
    }
    Ok(models)
}

fn read_models(
    reader: &mut Take<impl Read>,
    dialect: Dialect,
    status: u16,
    base_url: &str,
    timeout: Duration,
) -> ProbeResult {
    let mut bytes = Vec::new();
    if let Err(error) = reader.read_to_end(&mut bytes) {
        if crate::response::read_error(&error).kind == ErrorKind::Timeout {
            return ProbeResult::failure(
                base_url,
                ProbeState::Timeout,
                format!("no answer within {} ms", timeout.as_millis()),
            );
        }
        return ProbeResult::failure(base_url, ProbeState::Unreachable, "connection failed");
    }
    if bytes.len() as u64 > MAX_BODY_BYTES {
        return ProbeResult::failure(base_url, ProbeState::Protocol, "response body too large");
    }
    match parse_model_list(dialect, &bytes) {
        Ok(models) => ProbeResult {
            state: if models.is_empty() {
                ProbeState::Empty
            } else {
                ProbeState::Ok
            },
            base_url: base_url.into(),
            dialect: Some(dialect),
            models,
            detail: None,
            http_status: Some(status),
        },
        Err(detail) => ProbeResult::failure(base_url, ProbeState::Protocol, detail),
    }
}
