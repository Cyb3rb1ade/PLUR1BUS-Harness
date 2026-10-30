//! Native-only, bounded MFA grants. Public metadata never contains API challenge IDs or proofs.
use super::{ClientError, HarnessClient};
use crate::secrets::SecretString;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub(super) const HEADER: &str = "x-plur1bus-desktop-step-up";
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StepUpPurpose {
    Session,
    Extensions,
    Imports,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StepUpStatus {
    Pending,
    Approved,
    Declined,
    Expired,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StepUpPublic {
    pub handle: String,
    pub user_code: String,
    pub verification_uri: String,
    pub purpose: StepUpPurpose,
    pub expires_at: u64,
    pub state: StepUpStatus,
}
struct Entry {
    origin: String,
    credential: String,
    challenge: SecretString,
    proof: Option<SecretString>,
    public: StepUpPublic,
}
static CACHE: OnceLock<Mutex<Vec<Entry>>> = OnceLock::new();
fn cache() -> Result<std::sync::MutexGuard<'static, Vec<Entry>>, ClientError> {
    CACHE
        .get_or_init(Mutex::default)
        .lock()
        .map_err(|_| ClientError::Protocol)
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis() as u64)
}
fn credential(token: &SecretString) -> String {
    format!("{:x}", Sha256::digest(token.expose()))
}
fn secret(value: &Value, field: &str) -> Result<SecretString, ClientError> {
    let text = value[field].as_str().ok_or(ClientError::Protocol)?;
    let bytes = URL_SAFE_NO_PAD
        .decode(text)
        .map_err(|_| ClientError::Protocol)?;
    if bytes.len() != 32 || URL_SAFE_NO_PAD.encode(bytes) != text {
        return Err(ClientError::Protocol);
    }
    Ok(SecretString::new(text.into()))
}
fn expires(value: &Value) -> Result<u64, ClientError> {
    let value = value["expiresAt"].as_u64().ok_or(ClientError::Protocol)?;
    let clock = now();
    if value <= clock || value > clock.saturating_add(600_000) {
        return Err(ClientError::Protocol);
    }
    Ok(value.min(clock.saturating_add(300_000)))
}
pub(super) fn sensitive(
    secret: &SecretString,
) -> Result<reqwest::header::HeaderValue, ClientError> {
    let mut value = reqwest::header::HeaderValue::from_str(secret.expose())
        .map_err(|_| ClientError::Protocol)?;
    value.set_sensitive(true);
    Ok(value)
}
fn matching(entry: &Entry, client: &HarnessClient, token: &SecretString) -> bool {
    entry.origin == client.origin.as_str() && entry.credential == credential(token)
}
pub(crate) fn forget(origin: &crate::connections::Origin) {
    if let Ok(mut entries) = cache() {
        entries.retain(|entry| entry.origin != origin.as_str());
    }
}
impl HarnessClient {
    async fn step_up_wire(
        &self,
        path: &str,
        token: &SecretString,
        body: &Value,
    ) -> Result<Value, ClientError> {
        let mut result = self.request(path, Some(body), Some(token)).await;
        for _ in 0..2 {
            let Err(ClientError::RateLimited { retry_after_secs }) = result else {
                break;
            };
            self.rate_wait(
                token,
                retry_after_secs,
                path != "/api/v1/desktop/step-up/start",
            )
            .await?;
            result = self.request(path, Some(body), Some(token)).await;
        }
        // Transport loss can be retried. A refused or malformed authority answer cannot retain a usable grant.
        if result.is_err()
            && !matches!(
                result,
                Err(ClientError::Network | ClientError::RateLimited { .. })
            )
        {
            self.clear_step_up(token);
        }
        result
    }
    async fn rate_wait(
        &self,
        token: &SecretString,
        seconds: u64,
        require_grant: bool,
    ) -> Result<(), ClientError> {
        if require_grant {
            let expiry = cache()?
                .iter()
                .find(|entry| matching(entry, self, token))
                .map(|entry| entry.public.expires_at);
            if expiry
                .is_none_or(|expiry| now().saturating_add(seconds.saturating_mul(1000)) >= expiry)
            {
                self.clear_step_up(token);
                return Err(ClientError::SecondFactorRequired);
            }
        }
        tokio::time::sleep(Duration::from_secs(seconds)).await;
        Ok(())
    }
    pub async fn begin_step_up(
        &self,
        token: &SecretString,
        purpose: StepUpPurpose,
    ) -> Result<StepUpPublic, ClientError> {
        if !self
            .meta()
            .await?
            .capabilities
            .iter()
            .any(|capability| capability == "desktop-stepup-v1")
        {
            return Err(ClientError::MissingCapability);
        }
        let wire: Value = self
            .step_up_wire(
                "/api/v1/desktop/step-up/start",
                token,
                &json!({"purpose":purpose}),
            )
            .await?;
        if wire["schema"] != "desktop.step-up.start/1"
            || wire.as_object().is_none_or(|map| map.len() != 6)
            || wire["purpose"]
                != serde_json::to_value(purpose).map_err(|_| ClientError::Protocol)?
        {
            return Err(ClientError::Protocol);
        }
        let code = wire["userCode"].as_str().ok_or(ClientError::Protocol)?;
        if code.len() != 9
            || code.as_bytes()[4] != b'-'
            || !code.bytes().enumerate().all(|(index, byte)| {
                index == 4 || byte.is_ascii_uppercase() || (b'2'..=b'9').contains(&byte)
            })
        {
            return Err(ClientError::Protocol);
        }
        let public = StepUpPublic {
            handle: uuid::Uuid::now_v7().to_string(),
            user_code: code.into(),
            verification_uri: format!("{}/#/desktop/approve", self.origin.as_str()),
            purpose,
            expires_at: expires(&wire)?,
            state: StepUpStatus::Pending,
        };
        let challenge = secret(&wire, "challengeId")?;
        let mut entries = cache()?;
        // One current purpose per credential also determines the next confirmation session's narrowed scopes.
        entries.retain(|entry| entry.public.expires_at > now() && !matching(entry, self, token));
        if entries.len() >= 32 {
            return Err(ClientError::Protocol);
        }
        entries.push(Entry {
            origin: self.origin.as_str().into(),
            credential: credential(token),
            challenge,
            proof: None,
            public: public.clone(),
        });
        Ok(public)
    }
    pub async fn poll_step_up(
        &self,
        token: &SecretString,
        handle: &str,
    ) -> Result<StepUpPublic, ClientError> {
        let (challenge, mut public) = {
            let entries = cache()?;
            let entry = entries
                .iter()
                .find(|entry| entry.public.handle == handle && matching(entry, self, token))
                .ok_or(ClientError::Protocol)?;
            (
                SecretString::new(entry.challenge.expose().into()),
                entry.public.clone(),
            )
        };
        if public.expires_at <= now() {
            public.state = StepUpStatus::Expired;
            self.clear_step_up(token);
            return Ok(public);
        }
        if public.state != StepUpStatus::Pending {
            return Ok(public);
        }
        let wire: Value = self
            .step_up_wire(
                "/api/v1/desktop/step-up/poll",
                token,
                &json!({"challengeId":challenge.expose()}),
            )
            .await?;
        self.accept_poll(token, handle, wire, false)
            .map(|(public, _)| public)
    }
    fn accept_poll(
        &self,
        token: &SecretString,
        handle: &str,
        wire: Value,
        take_proof: bool,
    ) -> Result<(StepUpPublic, Option<SecretString>), ClientError> {
        let state = match wire["state"].as_str() {
            Some("pending") => StepUpStatus::Pending,
            Some("approved") => StepUpStatus::Approved,
            Some("declined") => StepUpStatus::Declined,
            Some("expired") => StepUpStatus::Expired,
            _ => return Err(ClientError::Protocol),
        };
        if wire["schema"] != "desktop.step-up.poll/1"
            || wire.as_object().is_none_or(|map| {
                map.len()
                    != if state == StepUpStatus::Approved {
                        5
                    } else {
                        3
                    }
            })
        {
            return Err(ClientError::Protocol);
        }
        let mut entries = cache()?;
        let entry = entries
            .iter_mut()
            .find(|entry| entry.public.handle == handle && matching(entry, self, token))
            .ok_or(ClientError::Protocol)?;
        entry.public.state = state;
        if state == StepUpStatus::Approved {
            if wire["purpose"]
                != serde_json::to_value(entry.public.purpose).map_err(|_| ClientError::Protocol)?
            {
                return Err(ClientError::Protocol);
            }
            entry.public.expires_at = entry.public.expires_at.min(expires(&wire)?);
            entry.proof = Some(secret(&wire, "proofToken")?);
        } else if state != StepUpStatus::Pending {
            entry.proof = None;
        }
        let proof = if take_proof { entry.proof.take() } else { None };
        Ok((entry.public.clone(), proof))
    }
    pub async fn cancel_step_up(
        &self,
        token: &SecretString,
        handle: &str,
    ) -> Result<(), ClientError> {
        let challenge = {
            let mut entries = cache()?;
            let position = entries
                .iter()
                .position(|entry| entry.public.handle == handle && matching(entry, self, token))
                .ok_or(ClientError::Protocol)?;
            entries.remove(position).challenge
        };
        let _: Value = self
            .request(
                "/api/v1/desktop/step-up/cancel",
                Some(&json!({"challengeId":challenge.expose()})),
                Some(token),
            )
            .await?;
        Ok(())
    }
    pub(super) fn clear_step_up(&self, token: &SecretString) {
        if let Ok(mut entries) = cache() {
            entries.retain(|entry| !matching(entry, self, token));
        }
    }
    pub fn step_up_info(
        &self,
        token: &SecretString,
        handle: &str,
    ) -> Result<StepUpPublic, ClientError> {
        let entries = cache()?;
        let entry = entries
            .iter()
            .find(|entry| {
                entry.public.handle == handle
                    && matching(entry, self, token)
                    && entry.public.expires_at > now()
            })
            .ok_or(ClientError::Protocol)?;
        Ok(entry.public.clone())
    }
    pub(super) async fn operation_proof(
        &self,
        token: &SecretString,
        purpose: Option<StepUpPurpose>,
    ) -> Result<Option<SecretString>, ClientError> {
        let request = {
            let mut entries = cache()?;
            entries.retain(|entry| entry.public.expires_at > now());
            let Some(entry) = entries.iter_mut().find(|entry| {
                matching(entry, self, token)
                    && purpose.is_none_or(|purpose| purpose == entry.public.purpose)
            }) else {
                return Ok(None);
            };
            if let Some(proof) = entry.proof.take() {
                return Ok(Some(proof));
            }
            if entry.public.state != StepUpStatus::Approved {
                return Ok(None);
            }
            (
                entry.public.handle.clone(),
                SecretString::new(entry.challenge.expose().into()),
            )
        };
        let wire: Value = self
            .step_up_wire(
                "/api/v1/desktop/step-up/poll",
                token,
                &json!({"challengeId":request.1.expose()}),
            )
            .await?;
        let (public, proof) = self.accept_poll(token, &request.0, wire, true)?;
        if public.state != StepUpStatus::Approved {
            return Err(ClientError::SecondFactorRequired);
        }
        Ok(proof)
    }
    pub(super) async fn protected_request<T: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        body: &Value,
        token: &SecretString,
        purpose: Option<StepUpPurpose>,
    ) -> Result<T, ClientError> {
        for attempt in 0..3 {
            let proof = self.operation_proof(token, purpose).await?;
            let result = self
                .request_inner(path, Some(body), Some(token), proof.as_ref())
                .await;
            if let Err(ClientError::RateLimited { retry_after_secs }) = result {
                if attempt < 2 {
                    // Acquire a fresh nonce: an application-level 429 may already have consumed the previous proof.
                    self.rate_wait(token, retry_after_secs.saturating_mul(2).min(60), true)
                        .await?;
                    continue;
                }
            }
            if matches!(
                result,
                Err(ClientError::Revoked
                    | ClientError::Unauthorized
                    | ClientError::SecondFactorRequired)
            ) {
                self.clear_step_up(token);
            }
            return result;
        }
        Err(ClientError::Protocol)
    }
}
