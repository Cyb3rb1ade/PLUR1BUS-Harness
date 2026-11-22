use crate::http::{Error, Kind};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashSet, VecDeque};
use std::io::Read;
use subtle::ConstantTimeEq;

const DEDUPE_LIMIT: usize = 4096;
const MAX_SAFE_ID: u64 = (1 << 53) - 1;

/// Per-channel webhook authentication and duplicate suppression. The host owns HTTPS
/// ingress deadlines, readiness, and authorization when it dispatches an update.
pub struct Webhook {
    secret: [u8; 32],
    limit: usize,
    seen: HashSet<u64>,
    order: VecDeque<u64>,
}

impl Webhook {
    pub fn new(secret: &str, limit: usize) -> Result<Self, Error> {
        if !(1..=256).contains(&secret.len())
            || secret
                .bytes()
                .any(|b| !b.is_ascii_alphanumeric() && !b"_-".contains(&b))
        {
            return Err(Error::new(
                Kind::Protocol,
                "valid webhook secret is required",
            ));
        }
        Ok(Self {
            secret: Sha256::digest(secret).into(),
            limit,
            seen: HashSet::new(),
            order: VecDeque::new(),
        })
    }

    pub fn handle(
        &mut self,
        ready: bool,
        method: &str,
        token: &str,
        body: Option<&mut dyn Read>,
        dispatch: impl FnOnce(Value) -> bool,
    ) -> u16 {
        if !ready {
            return 503;
        }
        if method != "POST" {
            return 405;
        }
        let provided: [u8; 32] = Sha256::digest(token).into();
        if !bool::from(self.secret.ct_eq(&provided)) {
            return 403;
        }
        let Some(body) = body else { return 400 };
        let mut bytes = Vec::new();
        if body
            .take((self.limit as u64).saturating_add(1))
            .read_to_end(&mut bytes)
            .is_err()
        {
            return 400;
        }
        if bytes.len() > self.limit {
            return 413;
        }
        let Ok(update) = serde_json::from_str::<Value>(&String::from_utf8_lossy(&bytes)) else {
            return 400;
        };
        let Some(id) = update["update_id"]
            .as_f64()
            .filter(|id| (0. ..=MAX_SAFE_ID as f64).contains(id) && id.fract() == 0.)
            .map(|id| id as u64)
        else {
            return 400;
        };
        if !present(&update["message"]) && !present(&update["callback_query"]) {
            return 400;
        }
        if self.seen.contains(&id) {
            return 200;
        }
        if !dispatch(update) {
            return 503;
        }
        self.seen.insert(id);
        self.order.push_back(id);
        if self.order.len() > DEDUPE_LIMIT {
            if let Some(expired) = self.order.pop_front() {
                self.seen.remove(&expired);
            }
        }
        200
    }
}

fn present(value: &Value) -> bool {
    !value.is_null() && *value != false && value.as_str() != Some("") && value.as_f64() != Some(0.)
}
