//! Bounded native uploads use the real person-bound device bearer and opaque server receipts.
use super::{ClientError, HarnessClient};
use crate::secrets::SecretString;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use futures_util::{stream, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnapshotUpload {
    pub snapshot_id: String,
    pub expires_at: u64,
    pub sha256: String,
}

fn opaque_id(value: &Value, field: &str) -> Result<String, ClientError> {
    let value = value[field].as_str().ok_or(ClientError::Protocol)?;
    let decoded = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| ClientError::Protocol)?;
    if decoded.len() != 32 || URL_SAFE_NO_PAD.encode(decoded) != value {
        return Err(ClientError::Protocol);
    }
    Ok(value.into())
}

impl HarnessClient {
    async fn upload_stream<S>(
        &self,
        token: &SecretString,
        payload: S,
        hash: String,
        snapshot: bool,
    ) -> Result<Value, ClientError>
    where
        S: futures_util::Stream<Item = Result<Vec<u8>, std::io::Error>> + Send + 'static,
    {
        if !self.meta().await?.current_desktop() {
            return Err(ClientError::MissingCapability);
        }
        let boundary = format!("p1b-{}", uuid::Uuid::now_v7());
        let (path, filename, content_type) = if snapshot {
            (
                "/api/v1/import/snapshots",
                "snapshot.tar.gz",
                "application/gzip",
            )
        } else {
            (
                "/api/v1/extensions/upload",
                "package.p1x",
                "application/vnd.plur1bus.extension+zip",
            )
        };
        let prefix = format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\nContent-Type: {content_type}\r\n\r\n").into_bytes();
        let suffix = format!("\r\n--{boundary}--\r\n").into_bytes();
        let body = reqwest::Body::wrap_stream(
            stream::iter([Ok::<_, std::io::Error>(prefix)])
                .chain(payload)
                .chain(stream::iter([Ok::<_, std::io::Error>(suffix)])),
        );
        let proof = self
            .operation_proof(
                token,
                Some(if snapshot {
                    super::StepUpPurpose::Imports
                } else {
                    super::StepUpPurpose::Extensions
                }),
            )
            .await?;
        let mut request = self
            .http()?
            .post(format!("{}{path}", self.origin.as_str()))
            .timeout(Duration::from_secs(300))
            .bearer_auth(token.expose())
            .header(
                reqwest::header::CONTENT_TYPE,
                format!("multipart/form-data; boundary={boundary}"),
            )
            .body(body);
        if let Some(proof) = proof.as_ref() {
            request = request.header(super::stepup::HEADER, super::stepup::sensitive(proof)?);
        }
        let response = request.send().await.map_err(|_| self.error())?;
        let bytes = self.bytes(response, 16 * 1024).await;
        if matches!(
            bytes,
            Err(ClientError::Revoked
                | ClientError::Unauthorized
                | ClientError::SecondFactorRequired)
        ) {
            self.clear_step_up(token);
        }
        let wire: Value = serde_json::from_slice(&bytes?).map_err(|_| ClientError::Protocol)?;
        let expires = wire["expiresAt"].as_u64().ok_or(ClientError::Protocol)?;
        if wire["sha256"] != hash
            || UNIX_EPOCH
                .checked_add(Duration::from_millis(expires))
                .is_none_or(|date| date <= SystemTime::now())
        {
            return Err(ClientError::Protocol);
        }
        Ok(wire)
    }

    /// Upload and inspect only; installation remains the explicit confirmation page's responsibility.
    pub async fn upload_extension(
        &self,
        token: &SecretString,
        bytes: Vec<u8>,
    ) -> Result<String, ClientError> {
        if bytes.is_empty() || bytes.len() > 256 * 1024 * 1024 {
            return Err(ClientError::Protocol);
        }
        let hash = format!("{:x}", Sha256::digest(&bytes));
        let wire = self
            .upload_stream(token, stream::iter([Ok(bytes)]), hash, false)
            .await?;
        let id = opaque_id(&wire, "uploadId")?;
        let inspection: Value = self
            .protected_request(
                "/api/v1/extensions/inspect",
                &json!({"source":{"upload":id}}),
                token,
                Some(super::StepUpPurpose::Extensions),
            )
            .await?;
        inspection["inspectionId"]
            .as_str()
            .filter(|id| {
                !id.is_empty()
                    && id.len() <= 128
                    && id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
            })
            .map(str::to_owned)
            .ok_or(ClientError::Protocol)
    }

    pub async fn upload_snapshot_file(
        &self,
        token: &SecretString,
        path: &std::path::Path,
        hash: &str,
    ) -> Result<SnapshotUpload, ClientError> {
        let metadata = std::fs::symlink_metadata(path).map_err(|_| ClientError::Protocol)?;
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || metadata.len() == 0
            || metadata.len() > 1024 * 1024 * 1024
        {
            return Err(ClientError::Protocol);
        }
        let file = tokio::fs::File::open(path)
            .await
            .map_err(|_| ClientError::Protocol)?;
        let payload = tokio_util::io::ReaderStream::new(file)
            .map(|result| result.map(|bytes| bytes.to_vec()));
        let wire = self
            .upload_stream(token, payload, hash.into(), true)
            .await?;
        Ok(SnapshotUpload {
            snapshot_id: opaque_id(&wire, "snapshotId")?,
            expires_at: wire["expiresAt"].as_u64().ok_or(ClientError::Protocol)?,
            sha256: wire["sha256"].as_str().ok_or(ClientError::Protocol)?.into(),
        })
    }
}
