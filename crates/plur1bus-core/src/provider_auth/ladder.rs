//! `auth/ladder.ts`: the headless ladder. RULING (TypeScript, ADR-005 "decided per environment probe"): without a
//! reachable graphical browser the order is device code, then loopback with an `ssh -L` hint, then paste-callback; with a
//! local browser the profile's loopback flow comes first and device code is the first fallback. `--paste-callback` always
//! wins for flows that have a callback.
use super::env::{can_open_graphical_browser, EnvSnapshot};
use super::profile::{AuthKind, AuthProfile};

/// `LoginMethod`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LoginMethod {
    /// `enter_key`
    EnterKey,
    /// `federated_token`
    FederatedToken,
    /// `adc`
    Adc,
    /// `delegated_cli`
    DelegatedCli,
    /// `device_code`
    DeviceCode,
    /// `loopback_pkce`: a browser on this machine.
    LoopbackPkce,
    /// `loopback_ssh`: loopback PKCE with an `ssh -L` hint.
    LoopbackSsh,
    /// `paste_callback`
    PasteCallback,
}

impl LoginMethod {
    /// The TypeScript string.
    pub fn as_str(self) -> &'static str {
        match self {
            LoginMethod::EnterKey => "enter_key",
            LoginMethod::FederatedToken => "federated_token",
            LoginMethod::Adc => "adc",
            LoginMethod::DelegatedCli => "delegated_cli",
            LoginMethod::DeviceCode => "device_code",
            LoginMethod::LoopbackPkce => "loopback_pkce",
            LoginMethod::LoopbackSsh => "loopback_ssh",
            LoginMethod::PasteCallback => "paste_callback",
        }
    }

    /// The method a string names.
    pub fn parse(s: &str) -> Option<LoginMethod> {
        [
            LoginMethod::EnterKey,
            LoginMethod::FederatedToken,
            LoginMethod::Adc,
            LoginMethod::DelegatedCli,
            LoginMethod::DeviceCode,
            LoginMethod::LoopbackPkce,
            LoginMethod::LoopbackSsh,
            LoginMethod::PasteCallback,
        ]
        .into_iter()
        .find(|m| m.as_str() == s)
    }
}

/// `LoginPlan`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LoginPlan {
    /// The method the CLI starts with.
    pub method: LoginMethod,
    /// Methods to fall back to, in order.
    pub fallbacks: Vec<LoginMethod>,
    /// Whether `sshHint` is offered.
    pub ssh_hint: bool,
    /// No graphical browser reachable.
    pub headless: bool,
}

impl LoginPlan {
    /// `sshHint(port)`.
    pub fn ssh_hint(&self, port: u16) -> Option<String> {
        self.ssh_hint
            .then(|| format!("ssh -L {port}:127.0.0.1:{port} <this-host>"))
    }

    /// Whether `m` is the method or one of the fallbacks.
    pub fn offers(&self, m: LoginMethod) -> bool {
        self.method == m || self.fallbacks.contains(&m)
    }
}

/// `planLogin(profile, snap, { pasteCallback })`.
pub fn plan_login(profile: &AuthProfile, snap: &EnvSnapshot, paste_callback: bool) -> LoginPlan {
    let headless = !can_open_graphical_browser(snap);
    let plain = |method| LoginPlan {
        method,
        fallbacks: Vec::new(),
        ssh_hint: false,
        headless,
    };
    match profile.kind {
        AuthKind::ApiKey => plain(LoginMethod::EnterKey),
        AuthKind::FederatedToken => plain(LoginMethod::FederatedToken),
        AuthKind::Adc => plain(LoginMethod::Adc),
        AuthKind::ExternalCli => plain(LoginMethod::DelegatedCli),
        AuthKind::DeviceCode => plain(LoginMethod::DeviceCode),
        AuthKind::OauthPkce => {
            let has_device = profile.device_url().is_some();
            if paste_callback {
                return plain(LoginMethod::PasteCallback);
            }
            if !headless {
                let mut fallbacks = Vec::new();
                if has_device {
                    fallbacks.push(LoginMethod::DeviceCode);
                }
                fallbacks.push(LoginMethod::PasteCallback);
                return LoginPlan {
                    method: LoginMethod::LoopbackPkce,
                    fallbacks,
                    ssh_hint: false,
                    headless,
                };
            }
            if has_device {
                return LoginPlan {
                    method: LoginMethod::DeviceCode,
                    fallbacks: vec![LoginMethod::LoopbackSsh, LoginMethod::PasteCallback],
                    ssh_hint: true,
                    headless,
                };
            }
            LoginPlan {
                method: LoginMethod::LoopbackSsh,
                fallbacks: vec![LoginMethod::PasteCallback],
                ssh_hint: true,
                headless,
            }
        }
    }
}
