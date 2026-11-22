//! `openai-auth/federated.ts`: an external token supplier (trusted configuration): a file, or a binary run directly with
//! literal arguments and an explicit environment. Its answer is `{ access_token, expires_at }` (seconds); the token is held
//! until `expires_at - skew`, one supply at a time, and a `close` during a supply is not undone by it. Every failure is
//! `auth-required`.
//!
//! Reading the supplier is a port ([`Supplier`]): the file read checks the never-list of foreign credential stores first and
//! reads at most 64 KiB; the command runs without a shell under a deadline. [`FileSupplier`] is the file read over a deny port;
//! the command runner belongs to the flip (it needs the process supervision of the host).
use super::super::ports::Clock;
use super::super::secret::Secret;
use super::ports::{object, text, OpenAIError};
use super::profiles::{credential_access, CredentialDenyPort};
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::{Mutex, PoisonError};

/// `FederatedSource`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FederatedSource {
    /// A file to read.
    pub file: Option<String>,
    /// A binary to run.
    pub command: Option<String>,
    /// Its literal arguments.
    pub args: Vec<String>,
    /// Its whole environment.
    pub environment: BTreeMap<String, String>,
    /// The deadline, 10 s by default.
    pub timeout_ms: Option<u64>,
}

/// Reads what the supplier answers.
pub trait Supplier: Send + Sync {
    /// The supplier's raw answer.
    fn supply(&self, source: &FederatedSource) -> Result<Secret, OpenAIError>;
}

/// The file supplier: the never-list first, then at most 64 KiB of a regular file.
pub struct FileSupplier<'a> {
    deny: &'a dyn CredentialDenyPort,
}

impl<'a> FileSupplier<'a> {
    /// Over `deny`.
    pub fn new(deny: &'a dyn CredentialDenyPort) -> FileSupplier<'a> {
        FileSupplier { deny }
    }
}

impl Supplier for FileSupplier<'_> {
    fn supply(&self, source: &FederatedSource) -> Result<Secret, OpenAIError> {
        let path = source
            .file
            .as_deref()
            .ok_or_else(|| OpenAIError::new("auth-required"))?;
        credential_access(self.deny, path, || {
            use std::io::Read;
            let refuse = || OpenAIError::new("auth-required");
            let name = std::fs::canonicalize(path).map_err(|_| refuse())?;
            let meta = std::fs::metadata(&name).map_err(|_| refuse())?;
            if !meta.is_file() || meta.len() > 65_536 {
                return Err(refuse());
            }
            let mut buf = Vec::new();
            std::fs::File::open(&name)
                .map_err(|_| refuse())?
                .take(65_537)
                .read_to_end(&mut buf)
                .map_err(|_| refuse())?;
            if buf.len() > 65_536 {
                return Err(refuse());
            }
            Ok(Secret::new(String::from_utf8_lossy(&buf).into_owned()))
        })
    }
}

struct State {
    token: Option<(Secret, f64)>,
    epoch: u64,
}

/// `FederatedCredential`.
pub struct FederatedCredential<'a> {
    source: FederatedSource,
    clock: &'a dyn Clock,
    supplier: &'a dyn Supplier,
    skew: f64,
    state: Mutex<State>,
    supply: Mutex<()>,
}

fn env_key_ok(k: &str) -> bool {
    let b = k.as_bytes();
    !b.is_empty()
        && (b[0].is_ascii_uppercase() || b[0] == b'_')
        && b.iter()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || *c == b'_')
}

impl<'a> FederatedCredential<'a> {
    /// `new FederatedCredential(source, clock, skewMs)`: exactly one of file and command; environment names in the portable
    /// form.
    pub fn new(
        source: FederatedSource,
        clock: &'a dyn Clock,
        supplier: &'a dyn Supplier,
        skew_ms: f64,
    ) -> Result<FederatedCredential<'a>, OpenAIError> {
        let has_file = source.file.as_deref().is_some_and(|f| !f.is_empty());
        let has_command = source.command.as_deref().is_some_and(|c| !c.is_empty());
        if has_file == has_command
            || !skew_ms.is_finite()
            || skew_ms < 0.0
            || !source.environment.keys().all(|k| env_key_ok(k))
        {
            return Err(OpenAIError::new("invalid-request"));
        }
        Ok(FederatedCredential {
            source,
            clock,
            supplier,
            skew: skew_ms,
            state: Mutex::new(State {
                token: None,
                epoch: 0,
            }),
            supply: Mutex::new(()),
        })
    }

    fn cached(&self) -> Option<Secret> {
        let st = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        st.token
            .as_ref()
            .filter(|(_, at)| at - self.skew > self.clock.now())
            .map(|(t, _)| t.clone())
    }

    /// `lease()`.
    pub fn lease(&self) -> Result<Secret, OpenAIError> {
        if let Some(t) = self.cached() {
            return Ok(t);
        }
        let _one = self.supply.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(t) = self.cached() {
            return Ok(t);
        }
        let epoch = self
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .epoch;
        let result = (|| -> Option<(Secret, f64)> {
            let raw = self.supplier.supply(&self.source).ok()?;
            if raw.expose().len() > 64 * 1024 {
                return None;
            }
            let v: Value = serde_json::from_str(raw.expose()).ok()?;
            let data = object(&v).ok()?;
            let expiry = data
                .get("expires_at")
                .and_then(Value::as_f64)
                .filter(|e| e.is_finite())?;
            if expiry * 1000.0 <= self.clock.now() + self.skew {
                return None;
            }
            let token = Secret::new(text(data.get("access_token")).ok()?);
            Some((token, expiry * 1000.0))
        })();
        let mut st = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        match result {
            // Closed while the supplier was running: the answer is dropped.
            Some((t, at)) if st.epoch == epoch => {
                st.token = Some((t.clone(), at));
                Ok(t)
            }
            _ => {
                st.token = None;
                Err(OpenAIError::new("auth-required"))
            }
        }
    }

    /// `close()`.
    pub fn close(&self) {
        let mut st = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        st.epoch += 1;
        st.token = None;
    }
}
