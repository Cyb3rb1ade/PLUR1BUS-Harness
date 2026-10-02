//! Origin-bound, non-redirecting harness transport. The only untrusted TLS requests
//! possible are nonce-only proof and hash-addressed public CA retrieval.
use crate::{
    connections::{CertPin, Connection, Origin},
    secrets::SecretString,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use plur1bus_desktop_contract::{capability, route, trust};
use rand::RngCore;
use rustls::{
    client::{
        danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
        WebPkiServerVerifier,
    },
    pki_types::{CertificateDer, ServerName, UnixTime},
    DigitallySignedStruct, SignatureScheme,
};
use serde::Deserialize;
use std::{
    sync::{Arc, Mutex},
    time::{Duration, SystemTime},
};
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClientError {
    Revoked,
    Unauthorized,
    Incompatible {
        server: String,
        client: &'static str,
    },
    MissingCapability,
    InstallationMismatch,
    CertChanged,
    Untrusted,
    CaNotKnown,
    ProofMismatch,
    Network,
    TrustUnavailable,
    Protocol,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Meta {
    pub api_version: String,
    pub version: String,
    pub installation_id: String,
    pub capabilities: Vec<String>,
}
pub struct Redeemed {
    pub device_id: String,
    pub token: SecretString,
}
pub struct Ticket {
    pub ticket: SecretString,
    pub expires_at: SystemTime,
}
#[derive(Debug, Default)]
struct Observed {
    pin: Option<CertPin>,
    company: bool,
    next: bool,
    rejected: bool,
    leaf: Vec<u8>,
    chain: Vec<Vec<u8>>,
}
#[derive(Debug)]
struct Verifier {
    os: Arc<WebPkiServerVerifier>,
    current_ca: Option<Arc<WebPkiServerVerifier>>,
    next_ca: Option<Arc<WebPkiServerVerifier>>,
    current: Option<CertPin>,
    next: Option<CertPin>,
    bootstrap: bool,
    allow_os: bool,
    observed: Arc<Mutex<Observed>>,
}
impl ServerCertVerifier for Verifier {
    fn verify_server_cert(
        &self,
        leaf: &CertificateDer<'_>,
        chain: &[CertificateDer<'_>],
        name: &ServerName<'_>,
        ocsp: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let pin = CertPin::of(leaf.as_ref());
        let mut seen = self.observed.lock().unwrap();
        seen.leaf = leaf.to_vec();
        seen.chain = chain.iter().map(|c| c.to_vec()).collect();
        seen.pin = Some(pin.clone());
        seen.company = !chain.is_empty()
            || x509_parser::parse_x509_certificate(leaf.as_ref())
                .is_ok_and(|(_, cert)| cert.issuer() != cert.subject());
        seen.next = false;
        seen.rejected = false;
        if self.bootstrap {
            return Ok(ServerCertVerified::assertion());
        }
        if self.current.as_ref() == Some(&pin) {
            return Ok(ServerCertVerified::assertion());
        }
        if self.next.as_ref() == Some(&pin) {
            seen.next = true;
            return Ok(ServerCertVerified::assertion());
        }
        if let Some(ca) = &self.current_ca {
            if let Ok(ok) = ca.verify_server_cert(leaf, chain, name, ocsp, now) {
                return Ok(ok);
            }
        }
        if let Some(ca) = &self.next_ca {
            if let Ok(ok) = ca.verify_server_cert(leaf, chain, name, ocsp, now) {
                seen.next = true;
                return Ok(ok);
            }
        }
        // Exact-leaf pins never silently fall back to a system root.
        if self.allow_os {
            if let Ok(ok) = self.os.verify_server_cert(leaf, chain, name, ocsp, now) {
                return Ok(ok);
            }
        }
        seen.rejected = true;
        Err(rustls::Error::InvalidCertificate(
            rustls::CertificateError::UnknownIssuer,
        ))
    }
    fn verify_tls12_signature(
        &self,
        m: &[u8],
        c: &CertificateDer<'_>,
        d: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.os.verify_tls12_signature(m, c, d)
    }
    fn verify_tls13_signature(
        &self,
        m: &[u8],
        c: &CertificateDer<'_>,
        d: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.os.verify_tls13_signature(m, c, d)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.os.supported_verify_schemes()
    }
}
fn roots(
    extra: Option<&[u8]>,
    system: bool,
    injected: Option<&[Vec<u8>]>,
) -> Result<Arc<WebPkiServerVerifier>, ClientError> {
    let mut store = rustls::RootCertStore::empty();
    if system {
        if let Some(injected) = injected {
            for cert in injected {
                let _ = store.add(CertificateDer::from(cert.clone()));
            }
        } else {
            for cert in rustls_native_certs::load_native_certs().certs {
                let _ = store.add(cert);
            }
        }
    }
    if let Some(cert) = extra {
        store
            .add(CertificateDer::from(cert.to_vec()))
            .map_err(|_| ClientError::Protocol)?;
    }
    WebPkiServerVerifier::builder_with_provider(
        Arc::new(store),
        Arc::new(rustls::crypto::ring::default_provider()),
    )
    .build()
    .map_err(|_| ClientError::Untrusted)
}
#[derive(Clone)]
pub struct HarnessClient {
    origin: Origin,
    cert: Option<CertPin>,
    ca: Option<CertPin>,
    next_cert: Option<CertPin>,
    next_ca: Option<CertPin>,
    http: Option<reqwest::Client>,
    roots: Option<Vec<Vec<u8>>>,
    observed: Arc<Mutex<Observed>>,
}
impl HarnessClient {
    pub fn new(origin: Origin, pin: Option<CertPin>) -> Self {
        Self {
            origin,
            cert: pin,
            ca: None,
            next_cert: None,
            next_ca: None,
            http: None,
            roots: None,
            observed: Arc::default(),
        }
    }
    #[cfg(debug_assertions)]
    pub fn with_trusted_roots(mut self, roots: Vec<Vec<u8>>) -> Self {
        self.roots = Some(roots);
        self
    }
    #[cfg(debug_assertions)]
    pub async fn from_connection_with_roots(
        c: &Connection,
        roots: Vec<Vec<u8>>,
    ) -> Result<Self, ClientError> {
        Self::from_connection_inner(c, Some(roots)).await
    }
    pub async fn from_connection(c: &Connection) -> Result<Self, ClientError> {
        Self::from_connection_inner(c, None).await
    }
    async fn from_connection_inner(
        c: &Connection,
        roots: Option<Vec<Vec<u8>>>,
    ) -> Result<Self, ClientError> {
        let mut client = Self::new(c.origin.clone(), c.cert_pin.clone());
        client.roots = roots;
        client.ca = c.ca_pin.clone();
        client.next_cert = c.next_cert_pin.clone();
        client.next_ca = c.next_ca_pin.clone();
        client.prepare().await.map_err(|e| match e {
            ClientError::ProofMismatch => ClientError::CaNotKnown,
            other => other,
        })?;
        Ok(client)
    }
    fn build(
        &self,
        bootstrap: bool,
        ca: Option<&[u8]>,
        next_ca: Option<&[u8]>,
    ) -> Result<reqwest::Client, ClientError> {
        if self.origin.as_str().starts_with("http://") {
            return reqwest::Client::builder()
                .use_rustls_tls()
                .tls_built_in_root_certs(false)
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(10))
                .connect_timeout(Duration::from_secs(10))
                .pool_max_idle_per_host(0)
                .build()
                .map_err(|_| ClientError::Network);
        }
        let verifier = Verifier {
            os: roots(None, true, self.roots.as_deref())?,
            current_ca: ca.map(|c| roots(Some(c), false, None)).transpose()?,
            next_ca: next_ca.map(|c| roots(Some(c), false, None)).transpose()?,
            current: self.cert.clone(),
            next: self.next_cert.clone(),
            bootstrap,
            allow_os: self.cert.is_none() && self.ca.is_none(),
            observed: self.observed.clone(),
        };
        let tls = rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .map_err(|_| ClientError::Protocol)?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth();
        reqwest::Client::builder()
            .use_preconfigured_tls(tls)
            .tls_info(true)
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(10))
            .connect_timeout(Duration::from_secs(10))
            .pool_max_idle_per_host(0)
            .build()
            .map_err(|_| ClientError::Network)
    }
    async fn prepare(&mut self) -> Result<(), ClientError> {
        // Current and next are alternatives. An unavailable CA must not disable
        // another independently verified candidate. Missing candidates never
        // broaden trust or fall back to OS roots when explicit pins exist.
        let mut failure = ClientError::CaNotKnown;
        let ca = match &self.ca {
            Some(pin) => match self.fetch_ca(pin).await {
                Ok(ca) => Some(ca),
                Err(e) => {
                    failure = e;
                    None
                }
            },
            None => None,
        };
        let next = match &self.next_ca {
            Some(pin) => match self.fetch_ca(pin).await {
                Ok(ca) => Some(ca),
                Err(e) => {
                    failure = e;
                    None
                }
            },
            None => None,
        };
        if self.cert.is_none()
            && self.next_cert.is_none()
            && ca.is_none()
            && next.is_none()
            && self.ca.is_some()
        {
            return Err(failure);
        }
        self.http = Some(self.build(false, ca.as_deref(), next.as_deref())?);
        Ok(())
    }
    fn http(&self) -> Result<reqwest::Client, ClientError> {
        match &self.http {
            Some(v) => Ok(v.clone()),
            None => self.build(false, None, None),
        }
    }
    fn error(&self) -> ClientError {
        let seen = self.observed.lock().unwrap();
        if !seen.rejected {
            return ClientError::Network;
        }
        if self.cert.is_some() || self.next_cert.is_some() {
            ClientError::CertChanged
        } else if self.ca.is_some() || self.next_ca.is_some() || seen.company {
            ClientError::CaNotKnown
        } else {
            ClientError::Untrusted
        }
    }
    pub fn origin(&self) -> &Origin {
        &self.origin
    }
    pub fn observed_pin(&self) -> Option<CertPin> {
        self.observed.lock().unwrap().pin.clone()
    }
    async fn bytes(&self, response: reqwest::Response, max: usize) -> Result<Vec<u8>, ClientError> {
        let status = response.status();
        let mut response = response;
        let mut bytes = zeroize::Zeroizing::new(Vec::new());
        if response.content_length().is_some_and(|n| n > max as u64) {
            return Err(ClientError::Protocol);
        }
        while let Some(chunk) = response.chunk().await.map_err(|_| ClientError::Network)? {
            if bytes.len() + chunk.len() > max {
                return Err(ClientError::Protocol);
            }
            bytes.extend_from_slice(&chunk)
        }
        if status == reqwest::StatusCode::UNAUTHORIZED {
            let v: serde_json::Value =
                serde_json::from_slice(&bytes).map_err(|_| ClientError::Unauthorized)?;
            return Err(if v["reason"] == "device-revoked" {
                ClientError::Revoked
            } else {
                ClientError::Unauthorized
            });
        }
        if !status.is_success() {
            return Err(ClientError::Protocol);
        }
        Ok(bytes.to_vec())
    }
    async fn request<T: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        body: Option<&serde_json::Value>,
        token: Option<&SecretString>,
    ) -> Result<T, ClientError> {
        let http = self.http()?;
        let url = format!("{}{path}", self.origin.as_str());
        let mut request = if let Some(body) = body {
            http.post(url).json(body)
        } else {
            http.get(url)
        };
        if let Some(token) = token {
            request = request.bearer_auth(token.expose())
        }
        let response = request.send().await.map_err(|_| self.error())?;
        let bytes = zeroize::Zeroizing::new(self.bytes(response, trust::MAX_BODY).await?);
        serde_json::from_slice(&bytes).map_err(|_| ClientError::Protocol)
    }
    pub async fn meta(&self) -> Result<Meta, ClientError> {
        let meta: Meta = self.request(route::META, None, None).await?;
        if meta.api_version.split('.').next() != Some("1") {
            // Only the public dotted numeric API version may cross IPC, never an
            // arbitrary server string (which could contain credentials or markup).
            if meta.api_version.len() > 32
                || !meta
                    .api_version
                    .split('.')
                    .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
            {
                return Err(ClientError::Protocol);
            }
            return Err(ClientError::Incompatible {
                server: meta.api_version,
                client: "1.0.0",
            });
        }
        if !meta
            .capabilities
            .iter()
            .any(|v| v == capability::SESSION_TICKET)
        {
            return Err(ClientError::MissingCapability);
        }
        if meta.installation_id.is_empty() || meta.installation_id.len() > 256 {
            return Err(ClientError::Protocol);
        }
        Ok(meta)
    }
    async fn check_meta(&self, id: &str) -> Result<(), ClientError> {
        if self.meta().await?.installation_id != id {
            return Err(ClientError::InstallationMismatch);
        }
        Ok(())
    }
    pub async fn redeem(&self, code: &str, name: &str) -> Result<Redeemed, ClientError> {
        let meta = self.meta().await?;
        self.redeem_for(&meta.installation_id, code, name).await
    }
    pub async fn redeem_for(
        &self,
        installation: &str,
        code: &str,
        name: &str,
    ) -> Result<Redeemed, ClientError> {
        if !trust::valid_code(code) || name.trim().is_empty() || name.len() > 120 {
            return Err(ClientError::Protocol);
        }
        self.check_meta(installation).await?;
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields, rename_all = "camelCase")]
        struct Wire {
            device_id: String,
            token: String,
        }
        let wire: Wire = self
            .request(
                route::DEVICE_REDEEM,
                Some(&serde_json::json!({"code":code,"name":name,"kind":"desktop"})),
                None,
            )
            .await?;
        let token = SecretString::new(wire.token);
        if token.expose().len() < 32
            || token.expose().len() > 512
            || !token
                .expose()
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            || wire.device_id.is_empty()
            || wire.device_id.len() > 256
        {
            return Err(ClientError::Protocol);
        }
        Ok(Redeemed {
            device_id: wire.device_id,
            token,
        })
    }
    pub async fn whoami(&self, id: &str, token: &SecretString) -> Result<(), ClientError> {
        self.check_meta(id).await?;
        let _: serde_json::Value = self.request(route::WHOAMI, None, Some(token)).await?;
        Ok(())
    }
    pub async fn session_ticket(
        &self,
        id: &str,
        token: &SecretString,
    ) -> Result<Ticket, ClientError> {
        self.check_meta(id).await?;
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Wire {
            ticket: String,
            expires_at: String,
        }
        let wire: Wire = self
            .request(
                route::SESSION_TICKET,
                Some(&serde_json::json!({})),
                Some(token),
            )
            .await?;
        let ticket = SecretString::new(wire.ticket);
        if ticket.expose().len() < 32 || ticket.expose().len() > 512 {
            return Err(ClientError::Protocol);
        }
        let expires_at = chrono::DateTime::parse_from_rfc3339(&wire.expires_at)
            .map_err(|_| ClientError::Protocol)?
            .into();
        Ok(Ticket { ticket, expires_at })
    }
    async fn fetch_ca(&self, pin: &CertPin) -> Result<Vec<u8>, ClientError> {
        // A public certificate may be fetched before authentication; its digest is the authority.
        let response = self
            .build(true, None, None)?
            .get(format!("{}{}", self.origin.as_str(), trust::CA))
            .query(&[("pin", pin.as_str())])
            .send()
            .await
            .map_err(|_| ClientError::TrustUnavailable)?;
        // Bootstrap transport is unauthenticated: a failed or malformed response
        // proves nothing about the saved trust. Only a valid CA with a different
        // digest is a cryptographic mismatch. Never persist bootstrap payloads.
        let bytes = self
            .bytes(response, trust::MAX_CA)
            .await
            .map_err(|_| ClientError::TrustUnavailable)?;
        let (remaining, cert) = x509_parser::parse_x509_certificate(&bytes)
            .map_err(|_| ClientError::TrustUnavailable)?;
        if !remaining.is_empty() || !cert.is_ca() || !cert.validity().is_valid() {
            return Err(ClientError::TrustUnavailable);
        }
        if CertPin::of(&bytes) != *pin {
            return Err(ClientError::ProofMismatch);
        }
        Ok(bytes)
    }
    pub async fn pair_proof(&self, code: &str) -> Result<CertPin, ClientError> {
        Ok(self.prove(code).await?.0)
    }
    async fn prove(&self, code: &str) -> Result<(CertPin, Option<CertPin>), ClientError> {
        if !trust::valid_code(code) || !self.origin.as_str().starts_with("https://") {
            return Err(ClientError::Protocol);
        }
        let mut nonce = [0; 32];
        rand::rng().fill_bytes(&mut nonce);
        let nonce = URL_SAFE_NO_PAD.encode(nonce);
        let response = self
            .build(true, None, None)?
            .post(format!("{}{}", self.origin.as_str(), trust::PAIR_PROOF))
            .json(&trust::ProofRequest {
                client_nonce: nonce.clone(),
            })
            .send()
            .await
            .map_err(|_| ClientError::Network)?;
        // Tie the proof to THIS response's TLS connection, not another handshake or DNS lookup.
        let der = response
            .extensions()
            .get::<reqwest::tls::TlsInfo>()
            .and_then(|info| info.peer_certificate())
            .ok_or(ClientError::Protocol)?;
        let pin = CertPin::of(der);
        let bytes = self.bytes(response, 4096).await?;
        let proof: trust::Proof =
            serde_json::from_slice(&bytes).map_err(|_| ClientError::Protocol)?;
        let ca = proof
            .ca_pin
            .as_deref()
            .map(CertPin::parse)
            .transpose()
            .map_err(|_| ClientError::ProofMismatch)?;
        let code = SecretString::new(code.to_owned());
        let salt = proof.salt.clone();
        let key = tokio::task::spawn_blocking(move || trust::key(code.expose(), &salt))
            .await
            .map_err(|_| ClientError::Protocol)?
            .map_err(|_| ClientError::ProofMismatch)?;
        trust::verify(&*key, pin.as_str(), self.origin.as_str(), &nonce, &proof)
            .map_err(|_| ClientError::ProofMismatch)?;
        Ok((pin, ca))
    }
    pub async fn establish_pairing_trust(&mut self, code: &str) -> Result<(), ClientError> {
        match self.meta().await {
            Ok(_) => Ok(()),
            Err(ClientError::Untrusted | ClientError::CaNotKnown) => {
                let (pin, ca) = self.prove(code).await?;
                if let Some(ca) = ca {
                    self.ca = Some(ca)
                } else {
                    self.cert = Some(pin)
                }
                self.prepare().await?;
                self.meta().await?;
                Ok(())
            }
            Err(e) => Err(e),
        }
    }
    pub fn apply_pairing_trust(&self, c: &mut Connection) {
        c.cert_pin = self.cert.clone();
        c.ca_pin = self.ca.clone()
    }
    /// Consume one bounded authenticated trust event. Its data is never an authority:
    /// callers re-pull the closed trust document, persist it and then acknowledge.
    pub async fn trust_event(
        &self,
        installation: &str,
        token: &SecretString,
    ) -> Result<(), ClientError> {
        self.check_meta(installation).await?;
        let mut response = self
            .http()?
            .get(format!("{}{}", self.origin.as_str(), route::EVENTS))
            .query(&[("topics", trust::EVENT)])
            .bearer_auth(token.expose())
            .send()
            .await
            .map_err(|_| self.error())?;
        if !response.status().is_success() {
            self.bytes(response, trust::MAX_BODY).await?;
            return Err(ClientError::Protocol);
        }
        if !response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|h| h.to_str().ok())
            .is_some_and(|v| v.starts_with("text/event-stream"))
        {
            return Err(ClientError::Protocol);
        }
        let mut frame = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| ClientError::Network)? {
            if frame.len() + chunk.len() > trust::MAX_BODY {
                return Err(ClientError::Protocol);
            }
            frame.extend_from_slice(&chunk);
            while let Some((end, separator)) = sse_frame_end(&frame) {
                let event =
                    std::str::from_utf8(&frame[..end]).map_err(|_| ClientError::Protocol)?;
                if event.lines().any(|line| {
                    line.strip_prefix("event:")
                        .is_some_and(|v| v.trim() == trust::EVENT)
                }) {
                    return Ok(());
                }
                frame.drain(..end + separator);
            }
        }
        Err(ClientError::Network)
    }
    pub async fn refresh_trust(
        &self,
        c: &mut Connection,
        token: &SecretString,
    ) -> Result<(), ClientError> {
        if self.origin != c.origin {
            return Err(ClientError::Protocol);
        }
        self.check_meta(&c.installation_id).await?;
        let next: trust::Trust = self.request(trust::TRUST, None, Some(token)).await?;
        let parse = |v: Option<String>| {
            v.map(|s| CertPin::parse(&s))
                .transpose()
                .map_err(|_| ClientError::Protocol)
        };
        let current_cert = parse(next.cert_pin)?;
        let current_ca = parse(next.ca_pin)?;
        let next_cert = parse(next.next_cert_pin)?;
        let next_ca = parse(next.next_ca_pin)?;
        if current_cert.is_some() && current_ca.is_some()
            || next_cert.is_some() && next_ca.is_some()
        {
            return Err(ClientError::Protocol);
        }
        let matches_current = current_cert == c.cert_pin && current_ca == c.ca_pin;
        let matches_next = (c.next_cert_pin.is_some() || c.next_ca_pin.is_some())
            && current_cert == c.next_cert_pin
            && current_ca == c.next_ca_pin;
        let os_initial = c.cert_pin.is_none()
            && c.ca_pin.is_none()
            && c.next_cert_pin.is_none()
            && c.next_ca_pin.is_none();
        if !matches_current && !matches_next && !os_initial {
            return Err(ClientError::CertChanged);
        }
        if os_initial {
            if let Some(pin) = &current_cert {
                if self.observed_pin().as_ref() != Some(pin) {
                    return Err(ClientError::CertChanged);
                }
            }
            if let Some(pin) = &current_ca {
                let (leaf, chain) = {
                    let seen = self.observed.lock().unwrap();
                    (seen.leaf.clone(), seen.chain.clone())
                };
                let ca = self.fetch_ca(pin).await?;
                let url =
                    url::Url::parse(self.origin.as_str()).map_err(|_| ClientError::Protocol)?;
                let host = url
                    .host_str()
                    .ok_or(ClientError::Protocol)?
                    .trim_matches(['[', ']'])
                    .to_owned();
                let name = ServerName::try_from(host).map_err(|_| ClientError::Protocol)?;
                let chain: Vec<_> = chain.into_iter().map(CertificateDer::from).collect();
                roots(Some(&ca), false, None)?
                    .verify_server_cert(
                        &CertificateDer::from(leaf),
                        &chain,
                        &name,
                        &[],
                        UnixTime::now(),
                    )
                    .map_err(|_| ClientError::CaNotKnown)?;
            }
            c.cert_pin = current_cert.clone();
            c.ca_pin = current_ca.clone();
        }
        if matches_next {
            c.cert_pin = current_cert;
            c.ca_pin = current_ca;
        }
        // Already authenticated/stored announcements remain valid metadata even
        // while that candidate is unavailable. New CA announcements still require
        // an exact hash and valid CA before persistence/acknowledgement.
        if let Some(pin) = &next_ca {
            if c.next_ca_pin.as_ref() != Some(pin) {
                self.fetch_ca(pin).await?;
            }
        }
        c.next_cert_pin = next_cert;
        c.next_ca_pin = next_ca;
        Ok(())
    }
    pub async fn ack_trust(&self, c: &Connection, token: &SecretString) -> Result<(), ClientError> {
        if self.origin != c.origin {
            return Err(ClientError::Protocol);
        }
        if c.next_cert_pin.is_none() && c.next_ca_pin.is_none() {
            return Ok(());
        }
        self.check_meta(&c.installation_id).await?;
        let ack = trust::Ack {
            next_cert_pin: c.next_cert_pin.as_ref().map(|p| p.as_str().into()),
            next_ca_pin: c.next_ca_pin.as_ref().map(|p| p.as_str().into()),
        };
        let _: serde_json::Value = self
            .request(
                trust::ACK,
                Some(&serde_json::to_value(ack).map_err(|_| ClientError::Protocol)?),
                Some(token),
            )
            .await?;
        Ok(())
    }
}

fn sse_frame_end(frame: &[u8]) -> Option<(usize, usize)> {
    (0..frame.len()).find_map(|i| {
        if frame[i..].starts_with(b"\r\n\r\n") {
            Some((i, 4))
        } else if frame[i..].starts_with(b"\n\n") {
            Some((i, 2))
        } else {
            None
        }
    })
}
#[cfg(test)]
mod framing_tests {
    #[test]
    fn sse_accepts_lf_and_crlf_including_split_delimiter() {
        assert_eq!(super::sse_frame_end(b"event: x\n\n"), Some((8, 2)));
        assert_eq!(super::sse_frame_end(b"event: x\r\n\r\n"), Some((8, 4)));
        assert_eq!(super::sse_frame_end(b"event: x\r\n\r"), None);
    }
}
