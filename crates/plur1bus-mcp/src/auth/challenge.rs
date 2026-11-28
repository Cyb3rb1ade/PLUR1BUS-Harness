//! Challenge metadata crosses only the authorization port, never diagnostics.
use url::Url;

use super::{scopes, secure_url};

#[derive(Default)]
pub struct Challenge {
    metadata: Option<Url>,
    scope: Option<String>,
    insufficient_scope: bool,
}

impl Challenge {
    pub fn metadata(&self) -> Option<&Url> {
        self.metadata.as_ref()
    }
    pub fn scope(&self) -> Option<&str> {
        self.scope.as_deref()
    }
    pub fn insufficient_scope(&self) -> bool {
        self.insufficient_scope
    }

    pub(crate) fn parse(raw: &str) -> Option<Self> {
        if raw.len() > 8192 {
            return None;
        }
        let (scheme, rest) = raw.trim_start().split_once(' ')?;
        if !scheme.eq_ignore_ascii_case("Bearer") {
            return None;
        }
        let mut challenge = Self::default();
        let mut fields = rest;
        for _ in 0..32 {
            fields = fields.trim_start_matches([' ', '\t', ',']);
            if fields.is_empty() {
                return Some(challenge);
            }
            let (name, value) = fields.split_once('=')?;
            let (value, remaining) = item(value.trim_start())?;
            match name.trim().to_ascii_lowercase().as_str() {
                "resource_metadata" => challenge.metadata = secure_url(value).ok(),
                "scope" if scopes(Some(value)).is_ok() => challenge.scope = Some(value.to_owned()),
                "error" => challenge.insufficient_scope = value == "insufficient_scope",
                _ => {}
            }
            fields = remaining;
        }
        None
    }
}

fn item(raw: &str) -> Option<(&str, &str)> {
    if let Some(rest) = raw.strip_prefix('"') {
        let (value, tail) = rest.split_once('"')?;
        if value
            .bytes()
            .any(|byte| byte == b'\\' || byte.is_ascii_control())
            || !tail.trim_start().is_empty() && !tail.trim_start().starts_with(',')
        {
            return None;
        }
        Some((value, tail))
    } else {
        let (value, remaining) = raw.split_once(',').unwrap_or((raw, ""));
        Some((value.trim_end(), remaining))
    }
}

pub trait Observer: Send + Sync {
    fn required(&self, resource: &Url, challenge: Challenge);
}
