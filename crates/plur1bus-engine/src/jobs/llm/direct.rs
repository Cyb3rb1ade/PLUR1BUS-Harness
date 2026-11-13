//! Guarded OpenAI-compatible feature route. Credentials are resolved per call.
use super::{disable_reasoning, feature_credential};
use crate::{
    contract::{Cancel, HostError, HostServices, LlmParams, LlmPort, LlmResult, LlmResultUsage},
    text::js::js_trim,
    transport::{guarded::bounded, GuardedClient, HttpRequest, TransportError},
};
use serde_json::{json, Value};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

const DEFAULT_BASE: &str = "https://api.openai.com/v1";
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

pub(crate) struct DirectCompletion<'a> {
    host: Arc<dyn HostServices>,
    settings: &'a Value,
    endpoint: String,
    model: &'a str,
}

impl<'a> DirectCompletion<'a> {
    pub(super) fn model(&self) -> &str {
        self.model
    }

    pub(super) fn from_settings(host: Arc<dyn HostServices>, settings: &'a Value) -> Option<Self> {
        let model = nonempty(&settings["model"])?;
        let base = nonempty(&settings["baseUrl"]).unwrap_or(DEFAULT_BASE);
        let mut endpoint = url::Url::parse(base).ok()?;
        let (_, target) = crate::transport::target::parse_url(base).ok()?;
        if target.scheme == crate::contract::Scheme::Http
            && !crate::transport::target::loopback_host(&target.host)
        {
            return None;
        }
        endpoint
            .path_segments_mut()
            .ok()?
            .pop_if_empty()
            .extend(["chat", "completions"]);
        Some(Self {
            host,
            settings,
            endpoint: endpoint.into(),
            model,
        })
    }

    pub(super) fn request(
        &self,
        params: LlmParams,
        cancel: &Cancel,
        json_mode: bool,
    ) -> Result<LlmResult, HostError> {
        cancel.check()?;
        let timeout = self.settings["timeoutMs"]
            .as_f64()
            .filter(|value| value.is_finite() && *value > 0.)
            .map_or(DEFAULT_TIMEOUT, |value| {
                Duration::from_millis(value.max(1.) as u64)
            });
        let deadline = Instant::now()
            .checked_add(timeout)
            .ok_or(HostError::Unavailable)?;
        let host = self.host.clone();
        let reference = nonempty(&self.settings["apiKeyRef"]).map(str::to_owned);
        let literal = nonempty(&self.settings["apiKey"]).map(str::to_owned);
        let credential = bounded(deadline, cancel, move || {
            feature_credential(host.secrets(), reference.as_deref(), literal.as_deref())
        })
        .map_err(host_error)??;
        let mut headers: Vec<(String, String)> = vec![
            ("accept".into(), "application/json".into()),
            ("content-type".into(), "application/json".into()),
        ];
        if let Some(credential) = credential {
            headers.push((
                "authorization".into(),
                format!("Bearer {}", credential.expose()),
            ));
        }
        if let Some(configured) = self.settings["headers"].as_object() {
            for (name, value) in configured {
                if [
                    "authorization",
                    "proxy-authorization",
                    "x-api-key",
                    "api-key",
                    "cookie",
                    "host",
                    "content-length",
                    "transfer-encoding",
                ]
                .iter()
                .any(|reserved| name.eq_ignore_ascii_case(reserved))
                {
                    return Err(HostError::Denied);
                }
                let value = value.as_str().ok_or(HostError::InvalidResponse)?;
                headers.retain(|(existing, _)| !existing.eq_ignore_ascii_case(name));
                headers.push((name.clone(), value.to_owned()));
            }
        }
        let model = self.model;
        let mut body = json!({
            "model":model,"messages":params.messages,
            "max_tokens":params.max_tokens.unwrap_or_else(|| 300.into()),
        });
        if json_mode {
            body["response_format"] = json!({"type":"json_object"});
        }
        if let Some(temperature) = params.temperature {
            body["temperature"] = temperature.into();
        }
        if disable_reasoning(model, self.settings["disableThinking"].as_bool(), None) {
            body["thinking"] = json!({"type":"disabled"});
        }
        let request = HttpRequest {
            method: "POST".into(),
            url: self.endpoint.clone(),
            headers,
            body: serde_json::to_vec(&body).map_err(|_| HostError::InvalidResponse)?,
            max_response_bytes: 1024 * 1024,
            max_error_response_bytes: 64 * 1024,
            auth_rejection_counter: None,
        };
        let response = GuardedClient::for_host(self.host.clone())
            .request_at_endpoint(request, deadline, cancel)
            .map_err(host_error)?;
        if !(200..300).contains(&response.status) {
            return Err(HostError::Failed);
        }
        let value: Value =
            serde_json::from_slice(&response.body).map_err(|_| HostError::InvalidResponse)?;
        let message = &value["choices"][0]["message"];
        let text = nonempty(&message["content"])
            .or_else(|| nonempty(&message["reasoning_content"]))
            .ok_or(HostError::InvalidResponse)?;
        let usage = &value["usage"];
        Ok(LlmResult {
            model: nonempty(&value["model"]).map(str::to_owned),
            text: text.to_owned(),
            usage: usage.is_object().then(|| LlmResultUsage {
                input_tokens: tokens(usage, "prompt_tokens", "input_tokens"),
                output_tokens: tokens(usage, "completion_tokens", "output_tokens"),
            }),
        })
    }
}

impl LlmPort for DirectCompletion<'_> {
    fn complete(&self, params: LlmParams, cancel: &Cancel) -> Result<LlmResult, HostError> {
        self.request(params, cancel, false)
    }
}

fn nonempty(value: &Value) -> Option<&str> {
    value
        .as_str()
        .map(js_trim)
        .filter(|value| !value.is_empty())
}

fn tokens(value: &Value, standard: &str, alternative: &str) -> Option<serde_json::Number> {
    let number = if value[standard].is_null() {
        &value[alternative]
    } else {
        &value[standard]
    };
    number.as_number().cloned()
}

fn host_error(error: TransportError) -> HostError {
    match error {
        TransportError::Cancelled(reason) => HostError::Cancelled(reason),
        TransportError::Denied | TransportError::AddressDenied | TransportError::Redirect => {
            HostError::Denied
        }
        TransportError::InvalidRequest | TransportError::ResponseTooLarge => {
            HostError::InvalidResponse
        }
        _ => HostError::Failed,
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, reason = "local HTTP fixtures")]
mod tests {
    use super::*;
    use crate::contract::{testing::FakeHost, AddressRules, Decision, Message, MessageRole};
    use std::{
        io::{BufRead, BufReader, Read, Write},
        net::TcpListener,
    };

    fn params() -> LlmParams {
        LlmParams {
            messages: vec![Message {
                role: MessageRole::User,
                content: "Owned evidence".into(),
            }],
            model: None,
            max_tokens: Some(16.into()),
            temperature: None,
        }
    }

    #[test]
    fn resolves_each_credential_and_stops_before_io_on_an_unresolved_reference() {
        let root = tempfile::tempdir().unwrap();
        let host = Arc::new(FakeHost::new(
            root.path().to_owned(),
            serde_json::from_value(json!({})).unwrap(),
        ));
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/v1/", listener.local_addr().unwrap());
        let settings = json!({
            "baseUrl":url,"model":"anthropic/claude-haiku-fixture","timeoutMs":3000,
            "apiKey":"literal fixture","apiKeyRef":"job/fixture","headers":{"X-Feature":"owned"},
        });
        let route = DirectCompletion::from_settings(host.clone(), &settings).unwrap();
        host.set_egress(Decision::Allow {
            address_rules: AddressRules {
                allow_loopback: true,
                ..Default::default()
            },
        });
        assert!(matches!(
            route.complete(params(), &Cancel::never()),
            Err(HostError::Unavailable)
        ));
        listener.set_nonblocking(true).unwrap();
        assert!(
            matches!(listener.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock)
        );
        listener.set_nonblocking(false).unwrap();
        let server = std::thread::spawn(move || {
            for (credential, redirect) in [("first fixture", false), ("rotated fixture", true)] {
                let (socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut socket = BufReader::new(socket);
                let mut request = String::new();
                socket.read_line(&mut request).unwrap();
                assert_eq!(request, "POST /v1/chat/completions HTTP/1.1\r\n");
                let mut headers = std::collections::BTreeMap::new();
                loop {
                    let mut line = String::new();
                    assert!(socket.read_line(&mut line).unwrap() > 0);
                    if line == "\r\n" {
                        break;
                    }
                    let (name, value) = line.trim_end().split_once(':').unwrap();
                    headers.insert(name.to_ascii_lowercase(), value.trim().to_owned());
                }
                assert_eq!(headers["authorization"], format!("Bearer {credential}"));
                assert_eq!(headers["x-feature"], "owned");
                let mut body = vec![0; headers["content-length"].parse().unwrap()];
                socket.read_exact(&mut body).unwrap();
                let body: Value = serde_json::from_slice(&body).unwrap();
                assert_eq!(body["thinking"]["type"], "disabled");
                assert_eq!(body["messages"][0]["content"], "Owned evidence");
                assert_eq!(body["max_tokens"], 16);
                if redirect {
                    write!(socket.get_mut(), "HTTP/1.1 307 Temporary Redirect\r\nLocation: /other\r\nContent-Length: 0\r\n\r\n").unwrap();
                } else {
                    let answer = r#"{"choices":[{"message":{"reasoning_content":"  answer  "}}],"usage":{"input_tokens":21,"output_tokens":5}}"#;
                    write!(
                        socket.get_mut(),
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{answer}",
                        answer.len()
                    )
                    .unwrap();
                }
            }
            listener.set_nonblocking(true).unwrap();
            assert!(
                matches!(listener.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock)
            );
        });
        host.set_secret("job/fixture", "first fixture");
        let answer = route.complete(params(), &Cancel::never()).unwrap();
        assert_eq!(answer.text, "answer");
        assert_eq!(
            answer.usage.unwrap().input_tokens.unwrap().as_u64(),
            Some(21)
        );
        host.set_secret("job/fixture", "rotated fixture");
        assert!(matches!(
            route.complete(params(), &Cancel::never()),
            Err(HostError::Denied)
        ));
        server.join().unwrap();
    }
}
