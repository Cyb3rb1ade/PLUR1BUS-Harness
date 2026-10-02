//! Runtime-generated TLS and provisional proof/trust routes. No private keys are persisted.
use super::*;
use plur1bus_desktop_contract::trust as wire;
use rcgen::{BasicConstraints, CertificateParams, IsCa, KeyPair};
use rustls::pki_types::{CertificateDer, PrivatePkcs8KeyDer};
#[derive(Clone)]
pub struct Identity {
    pub leaf: Vec<u8>,
    pub ca: Option<Vec<u8>>,
    key: Arc<zeroize::Zeroizing<Vec<u8>>>,
}
impl Identity {
    pub fn self_signed() -> Self {
        Self::self_signed_for(vec![
            "harness.test".into(),
            "localhost".into(),
            "127.0.0.1".into(),
        ])
    }
    pub fn self_signed_for(names: Vec<String>) -> Self {
        let key = KeyPair::generate().unwrap();
        let cert = CertificateParams::new(names)
            .unwrap()
            .self_signed(&key)
            .unwrap();
        Self {
            leaf: cert.der().to_vec(),
            ca: None,
            key: Arc::new(zeroize::Zeroizing::new(key.serialize_der())),
        }
    }
    pub fn pin(&self) -> String {
        fingerprint(&self.leaf)
    }
    pub fn ca_pin(&self) -> Option<String> {
        self.ca.as_deref().map(fingerprint)
    }
    fn config(&self) -> Arc<rustls::ServerConfig> {
        let mut certs = vec![CertificateDer::from(self.leaf.clone())];
        if let Some(ca) = &self.ca {
            certs.push(CertificateDer::from(ca.clone()))
        }
        Arc::new(
            rustls::ServerConfig::builder_with_provider(Arc::new(
                rustls::crypto::ring::default_provider(),
            ))
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(certs, PrivatePkcs8KeyDer::from(self.key.to_vec()).into())
            .unwrap(),
        )
    }
}
pub struct CompanyCa {
    params: CertificateParams,
    key: KeyPair,
    der: Vec<u8>,
}
impl Default for CompanyCa {
    fn default() -> Self {
        Self::new()
    }
}
impl CompanyCa {
    pub fn new() -> Self {
        let key = KeyPair::generate().unwrap();
        let mut params = CertificateParams::new(vec!["company.harness.test".into()]).unwrap();
        params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        params.key_usages = vec![
            rcgen::KeyUsagePurpose::KeyCertSign,
            rcgen::KeyUsagePurpose::DigitalSignature,
            rcgen::KeyUsagePurpose::CrlSign,
        ];
        let der = params.self_signed(&key).unwrap().der().to_vec();
        Self { params, key, der }
    }
    pub fn issue(&self) -> Identity {
        self.issue_for(vec![
            "harness.test".into(),
            "localhost".into(),
            "127.0.0.1".into(),
        ])
    }
    pub fn issue_for(&self, names: Vec<String>) -> Identity {
        let key = KeyPair::generate().unwrap();
        let issuer = rcgen::Issuer::from_params(&self.params, &self.key);
        let cert = CertificateParams::new(names)
            .unwrap()
            .signed_by(&key, &issuer)
            .unwrap();
        Identity {
            leaf: cert.der().to_vec(),
            ca: Some(self.der.clone()),
            key: Arc::new(zeroize::Zeroizing::new(key.serialize_der())),
        }
    }
}
fn fingerprint(bytes: &[u8]) -> String {
    format!("sha256:{}", URL_SAFE_NO_PAD.encode(Sha256::digest(bytes)))
}
pub(super) struct TlsState {
    current: Identity,
    next: Option<Identity>,
    cas: BTreeMap<String, Vec<u8>>,
    acks: usize,
    proof_wrong_leaf: Option<String>,
    proof_wrong_ca: Option<String>,
    wrong_ca_bytes: bool,
    ca_response: Option<(u16, Vec<u8>, u64)>,
    os_trust: bool,
}
impl TlsState {
    pub(super) fn new(current: Identity) -> Self {
        let mut cas = BTreeMap::new();
        if let Some(ca) = &current.ca {
            cas.insert(fingerprint(ca), ca.clone());
        }
        Self {
            current,
            next: None,
            cas,
            acks: 0,
            proof_wrong_leaf: None,
            proof_wrong_ca: None,
            wrong_ca_bytes: false,
            ca_response: None,
            os_trust: false,
        }
    }
    fn wire(&self) -> wire::Trust {
        wire::Trust {
            cert_pin: if !self.os_trust && self.current.ca.is_none() {
                Some(self.current.pin())
            } else {
                None
            },
            ca_pin: if self.os_trust {
                None
            } else {
                self.current.ca_pin()
            },
            next_cert_pin: self
                .next
                .as_ref()
                .filter(|v| v.ca.is_none())
                .map(Identity::pin),
            next_ca_pin: self.next.as_ref().and_then(Identity::ca_pin),
        }
    }
}
pub(super) struct ProofOffer {
    salt: String,
    key: zeroize::Zeroizing<[u8; 32]>,
    expires: i64,
}
impl ProofOffer {
    pub(super) fn new(code: &str, expires: i64) -> Self {
        let mut salt = [0; 16];
        rand::rng().fill_bytes(&mut salt);
        let salt = URL_SAFE_NO_PAD.encode(salt);
        let key = wire::key(code, &salt).unwrap();
        Self { salt, key, expires }
    }
}
impl MockControl {
    pub fn advertise_os_trust(&self) {
        self.shared.tls.lock().unwrap().as_mut().unwrap().os_trust = true;
    }
    pub fn clear_ca_response(&self) {
        self.shared
            .tls
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .ca_response = None;
    }
    pub fn ca_response(&self, status: u16, body: Vec<u8>, delay_ms: u64) {
        self.shared
            .tls
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .ca_response = Some((status, body, delay_ms));
    }

    pub fn announce_unapplied_trust(&self, value: wire::Trust) {
        self.shared
            .publish(wire::EVENT, serde_json::to_value(value).unwrap());
    }

    pub fn stage_trust(&self, next: Identity) {
        let mut tls = self.shared.tls.lock().unwrap();
        let tls = tls.as_mut().unwrap();
        if let Some(ca) = &next.ca {
            tls.cas.insert(fingerprint(ca), ca.clone());
        }
        tls.next = Some(next);
        let next = tls.wire();
        self.shared
            .publish(wire::EVENT, serde_json::to_value(next).unwrap());
    }
    pub fn switch_trust(&self) {
        let mut tls = self.shared.tls.lock().unwrap();
        let tls = tls.as_mut().unwrap();
        tls.current = tls.next.take().expect("stage first");
        tls.os_trust = false;
    }
    pub fn renew_leaf(&self, identity: Identity) {
        self.shared.tls.lock().unwrap().as_mut().unwrap().current = identity;
    }
    pub fn trust_ack_count(&self) -> usize {
        self.shared.tls.lock().unwrap().as_ref().unwrap().acks
    }
    pub fn proof_for_wrong_leaf(&self, pin: String) {
        self.shared
            .tls
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .proof_wrong_leaf = Some(pin)
    }
    pub fn proof_with_substituted_ca(&self, pin: String) {
        self.shared
            .tls
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .proof_wrong_ca = Some(pin)
    }
    pub fn wrong_ca_response(&self) {
        self.shared
            .tls
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .wrong_ca_bytes = true
    }
}
pub(super) async fn serve(listener: TcpListener, shared: Arc<Shared>, test_control: bool) {
    let mut tasks = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
         accepted=listener.accept()=>{let Ok((stream,peer))=accepted else {break};let config=shared.tls.lock().unwrap().as_ref().unwrap().current.config();let service=router(shared.clone(),test_control).layer(axum::Extension(ConnectInfo(peer)));
          tasks.spawn(async move{if let Ok(Ok(stream))=tokio::time::timeout(std::time::Duration::from_secs(10),tokio_rustls::TlsAcceptor::from(config).accept(stream)).await{let _=hyper::server::conn::http1::Builder::new().serve_connection(hyper_util::rt::TokioIo::new(stream),hyper_util::service::TowerToHyperService::new(service)).with_upgrades().await;}});
         },
         _=tasks.join_next(),if !tasks.is_empty()=>{}
        }
    }
}
pub(super) async fn proof(
    State(s): State<Arc<Shared>>,
    Json(body): Json<wire::ProofRequest>,
) -> Response {
    {
        let mut attempts = s.proof_attempts.lock().unwrap();
        if s.now() - attempts.0 >= 60 {
            *attempts = (s.now(), 0)
        }
        if attempts.1 >= 10 {
            return StatusCode::TOO_MANY_REQUESTS.into_response();
        }
        attempts.1 += 1;
    }
    if wire::decode(&body.client_nonce, 32).is_err() {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let tls = s.tls.lock().unwrap();
    let Some(tls) = tls.as_ref() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let offer = s.proof_offer.lock().unwrap();
    let Some(offer) = offer.as_ref().filter(|p| p.expires > s.now()) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let mut nonce = [0; 32];
    rand::rng().fill_bytes(&mut nonce);
    let server_nonce = URL_SAFE_NO_PAD.encode(nonce);
    let fp = tls
        .proof_wrong_leaf
        .clone()
        .unwrap_or_else(|| tls.current.pin());
    let ca = tls.current.ca_pin();
    let proof = wire::sign(
        &*offer.key,
        &fp,
        ca.as_deref(),
        s.origin.lock().unwrap().as_deref().unwrap(),
        &body.client_nonce,
        &server_nonce,
    );
    Json(wire::Proof {
        salt: offer.salt.clone(),
        server_nonce,
        proof,
        ca_pin: tls.proof_wrong_ca.clone().or(ca),
    })
    .into_response()
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CaQuery {
    pin: String,
}
pub(super) async fn ca(State(s): State<Arc<Shared>>, Query(query): Query<CaQuery>) -> Response {
    let response = s
        .tls
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|tls| tls.ca_response.clone());
    if let Some((status, body, delay)) = response {
        tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
        return (StatusCode::from_u16(status).unwrap(), body).into_response();
    }
    let tls = s.tls.lock().unwrap();
    let Some(tls) = tls.as_ref() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Some(ca) = tls.cas.get(&query.pin) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if tls.wrong_ca_bytes {
        return vec![0u8; 32].into_response();
    }
    (
        [(header::CONTENT_TYPE, "application/pkix-cert")],
        ca.clone(),
    )
        .into_response()
}
pub(super) async fn trust(State(s): State<Arc<Shared>>, headers: HeaderMap) -> Response {
    if let Err(e) = auth(&headers, &s.store.lock().unwrap(), Some(scope::UI_SESSION)) {
        return e.response();
    }
    let tls = s.tls.lock().unwrap();
    Json(tls.as_ref().map(TlsState::wire).unwrap_or_default()).into_response()
}
pub(super) async fn ack(
    State(s): State<Arc<Shared>>,
    headers: HeaderMap,
    Json(body): Json<wire::Ack>,
) -> Response {
    if let Err(e) = auth(&headers, &s.store.lock().unwrap(), Some(scope::UI_SESSION)) {
        return e.response();
    }
    let mut tls = s.tls.lock().unwrap();
    let Some(tls) = tls.as_mut() else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let expected = tls.wire();
    if body.next_cert_pin != expected.next_cert_pin || body.next_ca_pin != expected.next_ca_pin {
        return StatusCode::CONFLICT.into_response();
    }
    tls.acks += 1;
    Json(json!({"ok":true})).into_response()
}
