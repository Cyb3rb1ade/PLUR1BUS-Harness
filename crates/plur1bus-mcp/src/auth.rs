//! Resource-bound OAuth. The caller supplies the admission, secret and interaction ports.
use std::{
    collections::BTreeSet,
    fmt,
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{de::DeserializeOwned, Deserialize};
use sha2::{Digest, Sha256};
use ureq::http::{header, Method, Request};
use url::{form_urlencoded, Url};

use crate::http::{checked_url, pinned_run, read_bounded, Admission, MAX_DIAGNOSTIC_BYTES};

const MAX_ISSUERS: usize = 8;
const MAX_OAUTH_JSON: usize = 1024 * 1024;
const MAX_AUTH_MS: u64 = 600_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    Binding,
    Metadata,
    Interaction,
    Callback,
    Network,
    Expired,
    Token,
    AuthorizationPending,
    SlowDown,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Binding => "MCP OAuth binding refused",
            Self::Metadata => "MCP OAuth metadata unavailable",
            Self::Interaction => "MCP authorization is required",
            Self::Callback => "MCP OAuth callback refused",
            Self::Network => "MCP OAuth exchange failed",
            Self::Expired => "MCP OAuth deadline reached",
            Self::Token => "MCP OAuth token response refused",
            Self::AuthorizationPending => "MCP authorization pending",
            Self::SlowDown => "MCP authorization polling must slow down",
        })
    }
}
impl std::error::Error for Error {}

pub trait Clock {
    fn now_ms(&self) -> u64;
}

pub trait Entropy {
    fn verifier(&self) -> Result<[u8; 32], Error>;
    fn state(&self) -> Result<[u8; 32], Error>;
    /// Register these values at the host redaction boundary before releasing them.
    fn protect(&self, value: &str);
}

pub trait Interaction {
    fn approve(&self, prompt: &Prompt, deadline: Instant) -> Result<Callback, Error>;

    fn show_device(&self, _prompt: &DevicePrompt, _deadline: Instant) -> Result<(), Error> {
        Err(Error::Interaction)
    }

    fn wait(&self, _delay_ms: u64, _deadline: Instant) -> Result<(), Error> {
        Err(Error::Interaction)
    }
}

#[derive(Clone, Copy)]
pub enum Authorization<'a> {
    Pkce {
        metadata: Option<&'a str>,
        scope: Option<&'a str>,
    },
    Device {
        metadata: Option<&'a str>,
        scope: Option<&'a str>,
    },
}

pub struct Callback {
    code: String,
    state: String,
    issuer: Option<String>,
}

impl Callback {
    pub fn new(code: String, state: String, issuer: Option<String>) -> Self {
        Self {
            code,
            state,
            issuer,
        }
    }
}

pub struct Prompt {
    url: Url,
    redirect: Url,
}

impl Prompt {
    pub fn authorization_url(&self) -> &Url {
        &self.url
    }
    pub fn redirect_uri(&self) -> &Url {
        &self.redirect
    }
}

pub struct DevicePrompt {
    user_code: String,
    verification: Url,
    complete: Option<Url>,
}

impl DevicePrompt {
    pub fn user_code(&self) -> &str {
        &self.user_code
    }
    pub fn verification_uri(&self) -> &Url {
        &self.verification
    }
    pub fn verification_uri_complete(&self) -> Option<&Url> {
        self.complete.as_ref()
    }
}

pub struct Tokens {
    resource: Url,
    issuer: String,
    endpoint: Url,
    client_id: String,
    access: String,
    refresh: Option<String>,
    expires_ms: u64,
    scopes: BTreeSet<String>,
}

impl fmt::Debug for Tokens {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Tokens").finish_non_exhaustive()
    }
}

impl Tokens {
    pub fn access_for(&self, resource: &str, now_ms: u64) -> Option<&str> {
        (checked_url(resource).is_ok_and(|value| value == self.resource)
            && self.expires_ms > now_ms.saturating_add(5_000))
        .then_some(&self.access)
    }

    pub fn scopes(&self) -> impl Iterator<Item = &str> {
        self.scopes.iter().map(String::as_str)
    }
}

pub struct Client<'a> {
    resource: Url,
    client_id: &'a str,
    redirect: Url,
    admission: &'a dyn Admission,
}

#[derive(Deserialize)]
struct ResourceMetadata {
    resource: String,
    authorization_servers: Vec<String>,
}

#[derive(Deserialize)]
struct ServerMetadata {
    issuer: String,
    authorization_endpoint: Option<String>,
    token_endpoint: String,
    device_authorization_endpoint: Option<String>,
    #[serde(default)]
    code_challenge_methods_supported: Vec<String>,
    #[serde(default)]
    client_id_metadata_document_supported: bool,
    #[serde(default)]
    authorization_response_iss_parameter_supported: bool,
}

#[derive(Deserialize)]
struct Registration {
    client_id: String,
    redirect_uris: Vec<String>,
    token_endpoint_auth_method: Option<String>,
}

struct Issuer {
    name: String,
    authorization: Option<Url>,
    token: Url,
    device: Option<Url>,
    require_callback_issuer: bool,
    client_metadata: bool,
}

#[derive(Deserialize)]
struct TokenReply {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<f64>,
    scope: Option<String>,
    token_type: String,
}

#[derive(Deserialize)]
struct DeviceReply {
    device_code: String,
    user_code: String,
    verification_uri: String,
    verification_uri_complete: Option<String>,
    expires_in: u64,
    #[serde(default = "default_poll_interval")]
    interval: u64,
}

fn default_poll_interval() -> u64 {
    5
}

impl<'a> Client<'a> {
    pub fn new(
        resource: &str,
        client_id: &'a str,
        redirect_uri: &str,
        admission: &'a dyn Admission,
    ) -> Result<Self, Error> {
        if client_id.is_empty() || client_id.len() > 8192 || client_id.chars().any(char::is_control)
        {
            return Err(Error::Binding);
        }
        Ok(Self {
            resource: secure_url(resource)?,
            client_id,
            redirect: secure_url(redirect_uri)?,
            admission,
        })
    }

    pub fn authorize(
        &self,
        grant: Authorization<'_>,
        clock: &dyn Clock,
        entropy: &dyn Entropy,
        interaction: &dyn Interaction,
        deadline: Instant,
    ) -> Result<Tokens, Error> {
        let deadline = deadline.min(Instant::now() + Duration::from_millis(MAX_AUTH_MS));
        let (metadata, scope, device) = match grant {
            Authorization::Pkce { metadata, scope } => (metadata, scope, false),
            Authorization::Device { metadata, scope } => (metadata, scope, true),
        };
        let scopes = scopes(scope)?;
        let issuer = self.discover(metadata, device, deadline)?;
        self.check_registration(&issuer, deadline)?;
        if device {
            self.device(&issuer, scopes, clock, entropy, interaction, deadline)
        } else {
            self.pkce(&issuer, scopes, clock, entropy, interaction, deadline)
        }
    }

    pub fn refresh(
        &self,
        tokens: &Tokens,
        clock: &dyn Clock,
        entropy: &dyn Entropy,
        deadline: Instant,
    ) -> Result<Tokens, Error> {
        if tokens.resource != self.resource || tokens.client_id != self.client_id {
            return Err(Error::Binding);
        }
        let refresh = tokens.refresh.as_deref().ok_or(Error::Interaction)?;
        let data = self.post(
            &tokens.endpoint,
            &[
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh),
                ("client_id", self.client_id),
                ("resource", self.resource.as_str()),
            ],
            deadline,
        )?;
        self.accept(
            data,
            TokenContext {
                issuer: &tokens.issuer,
                endpoint: &tokens.endpoint,
                scopes: tokens.scopes.clone(),
                refresh: Some(refresh),
            },
            clock,
            entropy,
        )
    }

    fn discover(
        &self,
        hint: Option<&str>,
        device: bool,
        deadline: Instant,
    ) -> Result<Issuer, Error> {
        let resource_meta: ResourceMetadata = if let Some(hint) = hint {
            self.get(&secure_url(hint)?, deadline)?
        } else {
            let path = well_known(&self.resource, "oauth-protected-resource", true);
            let root = well_known(&self.resource, "oauth-protected-resource", false);
            self.get(&path, deadline).or_else(|error| {
                if path == root || error == Error::Expired {
                    Err(error)
                } else {
                    self.get(&root, deadline)
                }
            })?
        };
        if secure_url(&resource_meta.resource)? != self.resource
            || resource_meta.authorization_servers.is_empty()
            || resource_meta.authorization_servers.len() > MAX_ISSUERS
        {
            return Err(Error::Metadata);
        }
        let mut seen = BTreeSet::new();
        for raw in resource_meta.authorization_servers {
            if !seen.insert(raw.clone()) {
                continue;
            }
            let Ok(base) = secure_url(&raw) else {
                continue;
            };
            if base.query().is_some() {
                continue;
            }
            let metadata = self
                .get::<ServerMetadata>(
                    &well_known(&base, "oauth-authorization-server", true),
                    deadline,
                )
                .or_else(|error| {
                    if error == Error::Expired {
                        return Err(error);
                    }
                    let mut oidc = base.clone();
                    let path = format!(
                        "{}/.well-known/openid-configuration",
                        base.path().trim_end_matches('/')
                    );
                    oidc.set_path(&path);
                    self.get(&oidc, deadline)
                });
            let metadata = match metadata {
                Ok(metadata) => metadata,
                Err(Error::Expired) => return Err(Error::Expired),
                Err(_) => continue,
            };
            if metadata.issuer != raw {
                continue;
            }
            let Ok(token) = secure_url(&metadata.token_endpoint) else {
                continue;
            };
            let authorization = metadata
                .authorization_endpoint
                .as_deref()
                .and_then(|value| secure_url(value).ok());
            let device_endpoint = metadata
                .device_authorization_endpoint
                .as_deref()
                .and_then(|value| secure_url(value).ok());
            let pkce = metadata
                .code_challenge_methods_supported
                .iter()
                .any(|method| method == "S256");
            if (device && device_endpoint.is_none())
                || (!device && (!pkce || authorization.is_none()))
            {
                continue;
            }
            if self.client_id.starts_with("https://")
                && !metadata.client_id_metadata_document_supported
            {
                continue;
            }
            return Ok(Issuer {
                name: raw,
                authorization,
                token,
                device: device_endpoint,
                require_callback_issuer: metadata.authorization_response_iss_parameter_supported,
                client_metadata: metadata.client_id_metadata_document_supported,
            });
        }
        Err(Error::Metadata)
    }

    fn check_registration(&self, issuer: &Issuer, deadline: Instant) -> Result<(), Error> {
        let lower = self.client_id.to_ascii_lowercase();
        if !lower.starts_with("http://") && !lower.starts_with("https://") {
            return Ok(());
        }
        let uri = secure_url(self.client_id)?;
        if uri.scheme() != "https" || !issuer.client_metadata {
            return Err(Error::Binding);
        }
        let metadata: Registration = self.get(&uri, deadline)?;
        if metadata.client_id != self.client_id
            || metadata
                .token_endpoint_auth_method
                .as_deref()
                .is_some_and(|method| method != "none")
            || !metadata
                .redirect_uris
                .iter()
                .any(|redirect| redirect == self.redirect.as_str())
        {
            return Err(Error::Binding);
        }
        Ok(())
    }

    fn pkce(
        &self,
        issuer: &Issuer,
        scopes: BTreeSet<String>,
        clock: &dyn Clock,
        entropy: &dyn Entropy,
        interaction: &dyn Interaction,
        deadline: Instant,
    ) -> Result<Tokens, Error> {
        let verifier = URL_SAFE_NO_PAD.encode(entropy.verifier()?);
        let state = URL_SAFE_NO_PAD.encode(entropy.state()?);
        entropy.protect(&verifier);
        entropy.protect(&state);
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let mut url = issuer.authorization.clone().ok_or(Error::Metadata)?;
        let scope = scopes.iter().cloned().collect::<Vec<_>>().join(" ");
        let fixed = [
            ("response_type", "code"),
            ("client_id", self.client_id),
            ("redirect_uri", self.redirect.as_str()),
            ("state", &state),
            ("code_challenge", &challenge),
            ("code_challenge_method", "S256"),
            ("resource", self.resource.as_str()),
        ];
        let extra = url
            .query_pairs()
            .filter(|(key, _)| key != "scope" && !fixed.iter().any(|(replace, _)| key == *replace))
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect::<Vec<_>>();
        url.set_query(None);
        {
            let mut query = url.query_pairs_mut();
            query.extend_pairs(extra);
            query.extend_pairs(fixed);
            if !scope.is_empty() {
                query.append_pair("scope", &scope);
            }
        }
        ensure_time(deadline)?;
        let callback = interaction.approve(
            &Prompt {
                url,
                redirect: self.redirect.clone(),
            },
            deadline,
        )?;
        ensure_time(deadline)?;
        if callback.code.is_empty()
            || callback.code.len() > 8192
            || callback.state != state
            || callback
                .issuer
                .as_ref()
                .is_some_and(|value| value != &issuer.name)
            || issuer.require_callback_issuer && callback.issuer.is_none()
        {
            return Err(Error::Callback);
        }
        entropy.protect(&callback.code);
        let data = self.post(
            &issuer.token,
            &[
                ("grant_type", "authorization_code"),
                ("code", &callback.code),
                ("code_verifier", &verifier),
                ("redirect_uri", self.redirect.as_str()),
                ("client_id", self.client_id),
                ("resource", self.resource.as_str()),
            ],
            deadline,
        )?;
        self.accept(
            data,
            TokenContext {
                issuer: &issuer.name,
                endpoint: &issuer.token,
                scopes,
                refresh: None,
            },
            clock,
            entropy,
        )
    }

    fn device(
        &self,
        issuer: &Issuer,
        scopes: BTreeSet<String>,
        clock: &dyn Clock,
        entropy: &dyn Entropy,
        interaction: &dyn Interaction,
        deadline: Instant,
    ) -> Result<Tokens, Error> {
        let endpoint = issuer.device.as_ref().ok_or(Error::Metadata)?;
        let scope = scopes.iter().cloned().collect::<Vec<_>>().join(" ");
        let mut params = vec![
            ("client_id", self.client_id),
            ("resource", self.resource.as_str()),
        ];
        if !scope.is_empty() {
            params.push(("scope", &scope));
        }
        let data: DeviceReply = self.post(endpoint, &params, deadline)?;
        if data.device_code.is_empty()
            || data.user_code.is_empty()
            || !(1..=3600).contains(&data.expires_in)
            || !(1..=60).contains(&data.interval)
        {
            return Err(Error::Interaction);
        }
        let verification = secure_url(&data.verification_uri)?;
        let complete = data
            .verification_uri_complete
            .as_deref()
            .map(secure_url)
            .transpose()?;
        entropy.protect(&data.device_code);
        entropy.protect(&data.user_code);
        if let Some(url) = &complete {
            entropy.protect(url.as_str());
        }
        let expires = clock
            .now_ms()
            .saturating_add((data.expires_in * 1_000).min(MAX_AUTH_MS));
        interaction.show_device(
            &DevicePrompt {
                user_code: data.user_code,
                verification,
                complete,
            },
            deadline,
        )?;
        let mut interval = data.interval * 1_000;
        for _ in 0..600 {
            let left = expires.saturating_sub(clock.now_ms());
            if left == 0 {
                break;
            }
            ensure_time(deadline)?;
            interaction.wait(interval.min(left), deadline)?;
            if clock.now_ms() >= expires {
                break;
            }
            let result = self.post(
                &issuer.token,
                &[
                    ("client_id", self.client_id),
                    ("resource", self.resource.as_str()),
                    ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                    ("device_code", &data.device_code),
                ],
                deadline,
            );
            match result {
                Ok(token) => {
                    return self.accept(
                        token,
                        TokenContext {
                            issuer: &issuer.name,
                            endpoint: &issuer.token,
                            scopes,
                            refresh: None,
                        },
                        clock,
                        entropy,
                    )
                }
                Err(Error::AuthorizationPending) => {}
                Err(Error::SlowDown) => interval = (interval + 5_000).min(60_000),
                Err(error) => return Err(error),
            }
        }
        Err(Error::Expired)
    }

    fn accept(
        &self,
        data: TokenReply,
        context: TokenContext<'_>,
        clock: &dyn Clock,
        entropy: &dyn Entropy,
    ) -> Result<Tokens, Error> {
        if data.access_token.is_empty()
            || data
                .access_token
                .bytes()
                .any(|byte| byte.is_ascii_whitespace() || byte.is_ascii_control())
            || !data.token_type.eq_ignore_ascii_case("Bearer")
            || data
                .expires_in
                .is_some_and(|seconds| !seconds.is_finite() || seconds <= 0.0)
        {
            return Err(Error::Token);
        }
        let scopes = if data.scope.is_some() {
            scopes(data.scope.as_deref())?
        } else {
            context.scopes
        };
        let refresh = data
            .refresh_token
            .or_else(|| context.refresh.map(ToOwned::to_owned));
        entropy.protect(&data.access_token);
        if let Some(value) = &refresh {
            entropy.protect(value);
        }
        Ok(Tokens {
            resource: self.resource.clone(),
            issuer: context.issuer.to_owned(),
            endpoint: context.endpoint.clone(),
            client_id: self.client_id.to_owned(),
            access: data.access_token,
            refresh,
            expires_ms: clock
                .now_ms()
                .saturating_add((data.expires_in.unwrap_or(60.0) * 1_000.0) as u64),
            scopes,
        })
    }

    fn get<T: DeserializeOwned>(&self, url: &Url, deadline: Instant) -> Result<T, Error> {
        let request = Request::builder()
            .method(Method::GET)
            .uri(url.as_str())
            .header(header::ACCEPT, "application/json")
            .header(header::ACCEPT_ENCODING, "identity")
            .body(())
            .map_err(|_| Error::Metadata)?;
        let response = pinned_run(url, self.admission, deadline, request).map_err(network)?;
        decode(response, deadline)
    }

    fn post<T: DeserializeOwned>(
        &self,
        url: &Url,
        pairs: &[(&str, &str)],
        deadline: Instant,
    ) -> Result<T, Error> {
        let body = form_urlencoded::Serializer::new(String::new())
            .extend_pairs(pairs)
            .finish();
        let request = Request::builder()
            .method(Method::POST)
            .uri(url.as_str())
            .header(header::ACCEPT_ENCODING, "identity")
            .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
            .body(body)
            .map_err(|_| Error::Token)?;
        let response = pinned_run(url, self.admission, deadline, request).map_err(network)?;
        decode(response, deadline)
    }
}

struct TokenContext<'a> {
    issuer: &'a str,
    endpoint: &'a Url,
    scopes: BTreeSet<String>,
    refresh: Option<&'a str>,
}

fn decode<T: DeserializeOwned>(
    mut response: ureq::http::Response<ureq::Body>,
    deadline: Instant,
) -> Result<T, Error> {
    let success = response.status().is_success();
    let limit = if success {
        MAX_OAUTH_JSON
    } else {
        MAX_DIAGNOSTIC_BYTES
    };
    let body = read_bounded(&mut response, deadline, limit).map_err(|error| match error {
        rmcp::transport::streamable_http_client::StreamableHttpError::Client(cause) => {
            network(cause)
        }
        _ => Error::Token,
    })?;
    let value: serde_json::Value = serde_json::from_slice(&body).map_err(|_| Error::Token)?;
    if !success || value.get("error").is_some() {
        return Err(match value["error"].as_str() {
            Some("authorization_pending") => Error::AuthorizationPending,
            Some("slow_down") => Error::SlowDown,
            _ => Error::Token,
        });
    }
    serde_json::from_value(value).map_err(|_| Error::Token)
}

fn network(error: crate::http::Error) -> Error {
    if error == crate::http::Error::Timeout {
        Error::Expired
    } else {
        Error::Network
    }
}

fn ensure_time(deadline: Instant) -> Result<(), Error> {
    if Instant::now() < deadline {
        Ok(())
    } else {
        Err(Error::Expired)
    }
}

fn secure_url(raw: &str) -> Result<Url, Error> {
    let url = checked_url(raw).map_err(|_| Error::Binding)?;
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if url.scheme() == "https" || loopback {
        Ok(url)
    } else {
        Err(Error::Binding)
    }
}

fn well_known(source: &Url, name: &str, retain_path: bool) -> Url {
    let mut url = source.clone();
    let suffix = if retain_path {
        source.path().trim_end_matches('/')
    } else {
        ""
    };
    url.set_path(&format!("/.well-known/{name}{suffix}"));
    url.set_query(None);
    url
}

fn scopes(raw: Option<&str>) -> Result<BTreeSet<String>, Error> {
    let Some(raw) = raw else {
        return Ok(BTreeSet::new());
    };
    raw.split(' ')
        .map(|token| {
            if token.is_empty()
                || !token
                    .bytes()
                    .all(|byte| matches!(byte, 0x21 | 0x23..=0x5b | 0x5d..=0x7e))
            {
                return Err(Error::Binding);
            }
            Ok(token.to_owned())
        })
        .collect()
}
