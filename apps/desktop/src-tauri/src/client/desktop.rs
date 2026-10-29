//! Current API attach contract, kept separate from the older preview protocol.
use super::{ClientError, HarnessClient, Meta, Redeemed, Ticket};
use crate::{connections::Origin, secrets::SecretString};
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use ring::{
    rand::SystemRandom,
    signature::{Ed25519KeyPair, KeyPair},
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::{Duration, UNIX_EPOCH};

impl Meta {
    pub(crate) fn current_identity(origin: &Origin) -> String {
        format!(
            "desktop-origin:{:x}",
            Sha256::digest(format!("desktop-api-v1:{}", origin.as_str()))
        )
    }
    pub fn current_desktop(&self) -> bool {
        self.capabilities
            .iter()
            .any(|value| value == "desktop-pair-v1")
            && self
                .capabilities
                .iter()
                .any(|value| value == "desktop-ticket-v1")
    }
}

pub(super) fn meta(raw: Value, origin: &Origin) -> Result<Meta, ClientError> {
    if raw.get("apiVersion").is_some() {
        return serde_json::from_value(raw).map_err(|_| ClientError::Protocol);
    }
    let version = raw["version"].as_str().ok_or(ClientError::Protocol)?;
    let capabilities: Vec<String> =
        serde_json::from_value(raw["capabilities"].clone()).map_err(|_| ClientError::Protocol)?;
    if raw["pairingRequired"].as_bool().is_none()
        || raw.as_object().is_none_or(|map| map.len() != 3)
        || capabilities.len() > 64
        || capabilities.iter().any(|value| value.len() > 128)
    {
        return Err(ClientError::Protocol);
    }
    // A local connection key, never a server installation attestation or an authorization input.
    let identity = Meta::current_identity(origin);
    let meta = Meta {
        api_version: version.into(),
        version: version.into(),
        installation_id: identity,
        capabilities,
    };
    if !meta.current_desktop() {
        return Err(ClientError::MissingCapability);
    }
    Ok(meta)
}

fn credential(value: &Value, field: &str) -> Result<SecretString, ClientError> {
    let value = value[field].as_str().ok_or(ClientError::Protocol)?;
    let decoded = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| ClientError::Protocol)?;
    if decoded.len() != 32 || URL_SAFE_NO_PAD.encode(decoded) != value {
        return Err(ClientError::Protocol);
    }
    Ok(SecretString::new(value.into()))
}

fn expiry(raw: &Value) -> Result<std::time::SystemTime, ClientError> {
    let millis = raw["expiresAt"].as_u64().ok_or(ClientError::Protocol)?;
    let date = UNIX_EPOCH
        .checked_add(Duration::from_millis(millis))
        .ok_or(ClientError::Protocol)?;
    if date <= std::time::SystemTime::now() {
        return Err(ClientError::Protocol);
    }
    Ok(date)
}

impl HarnessClient {
    pub(super) async fn desktop_pair(
        &self,
        code: &str,
        name: &str,
    ) -> Result<Redeemed, ClientError> {
        if URL_SAFE_NO_PAD.decode(code).is_err()
            || code.len() != 43
            || name.trim().is_empty()
            || name.len() > 120
        {
            return Err(ClientError::Protocol);
        }
        let private = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
            .map_err(|_| ClientError::Protocol)?;
        let key =
            Ed25519KeyPair::from_pkcs8(private.as_ref()).map_err(|_| ClientError::Protocol)?;
        let mut spki = vec![
            0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
        ];
        spki.extend_from_slice(key.public_key().as_ref());
        let wire: Value = self
            .request(
                "/api/v1/desktop/pair",
                Some(&json!({
                    "code":code,"kind":"desktop","name":name,"publicKey":STANDARD.encode(spki)
                })),
                None,
            )
            .await?;
        if wire["schema"] != "desktop.pair/1" {
            return Err(ClientError::Protocol);
        }
        expiry(&wire)?;
        let device_id = wire["device"]["id"]
            .as_str()
            .filter(|id| {
                !id.is_empty()
                    && id.len() <= 256
                    && id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
            })
            .ok_or(ClientError::Protocol)?
            .to_owned();
        Ok(Redeemed {
            device_id,
            token: credential(&wire, "token")?,
            signing_key: Some(SecretString::new(STANDARD.encode(private.as_ref()))),
        })
    }

    pub(super) async fn desktop_ticket(&self, token: &SecretString) -> Result<Ticket, ClientError> {
        let wire: Value = self
            .protected_request(
                "/api/v1/desktop/redeem",
                &json!({
                    "token":token.expose(),"origin":self.origin.as_str()
                }),
                token,
                None,
            )
            .await?;
        if wire["schema"] != "desktop.redeem/1" || !wire["deviceId"].is_string() {
            return Err(ClientError::Protocol);
        }
        Ok(Ticket {
            ticket: credential(&wire, "ticket")?,
            expires_at: expiry(&wire)?,
            desktop: true,
        })
    }

    /// Redeem directly in Rust, so neither credentials nor session tickets enter a renderer or browser URL.
    pub async fn desktop_cookie(
        &self,
        ticket: &Ticket,
        device_id: &str,
    ) -> Result<reqwest::header::HeaderMap, ClientError> {
        for attempt in 0..3 {
            let response = self
                .http()?
                .post(format!("{}/api/v1/desktop/ticket", self.origin.as_str()))
                .header(reqwest::header::ORIGIN, self.origin.as_str())
                .json(&json!({"ticket":ticket.ticket.expose(),"deviceId":device_id}))
                .send()
                .await
                .map_err(|_| self.error())?;
            let headers = response.headers().clone();
            let result = self.bytes(response, 65536).await;
            if let Err(ClientError::RateLimited { retry_after_secs }) = result {
                let delay = Duration::from_secs(retry_after_secs);
                if attempt < 2
                    && std::time::SystemTime::now()
                        .checked_add(delay)
                        .is_some_and(|until| until < ticket.expires_at)
                {
                    tokio::time::sleep(delay).await;
                    continue;
                }
            }
            result?;
            if headers
                .get_all(reqwest::header::SET_COOKIE)
                .iter()
                .next()
                .is_none()
            {
                return Err(ClientError::Protocol);
            }
            return Ok(headers);
        }
        Err(ClientError::Protocol)
    }
}
