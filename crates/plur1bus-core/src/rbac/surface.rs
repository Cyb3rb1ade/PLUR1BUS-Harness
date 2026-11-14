//! D109 §5 "Surfaces and channel trust": the trust level (T0 to T3) of the surface a decision arrives on, as a pure function of
//! facts the core itself established, never of anything a client or the model claims. Anything the table does not name is T0,
//! and so is any input that is not well formed. Port of `rbac/surface.ts` and `rbac/connection-surface.ts`.
//!
//! ```text
//!   T3  desktop app; CLI on a TTY of the owning OS user; web with a step-up (WebAuthn/TOTP) within the last 5 minutes
//!   T2  web session without step-up; a private chat with a D24-linked identity and a valid one-time nonce on a first-party
//!       channel module (a third-party module only when the person opted that module into T2)
//!   T1  the inbound ACP editor that started the session; a person on a token connection without attestation
//!   T0  group chats, unlinked identities, MCP clients, A2A peers, other agents, model output, tool results, everything else
//! ```
//!
//! The typed functions take facts the way the TypeScript types describe them; the `_js` twins take any [`Js`] and read it the
//! way the TypeScript does (`=== true` for flags, `typeof x === "number"` plus `Number.isFinite` for times, own members only).
use super::loose::Js;
use super::types::{Principal, PrincipalKind};

/// `STEP_UP_WINDOW_MS`: a web step-up counts for five minutes.
pub const STEP_UP_WINDOW_MS: f64 = 5.0 * 60_000.0;

/// `SurfaceTrustLevel` (0 to 3).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum SurfaceTrustLevel {
    /// T0
    T0 = 0,
    /// T1
    T1 = 1,
    /// T2
    T2 = 2,
    /// T3
    T3 = 3,
}

impl SurfaceTrustLevel {
    /// The number the TypeScript returns.
    pub fn as_u8(self) -> u8 {
        self as u8
    }
    /// `0..=3` as a number; anything else (including `NaN`, `1.5`, `4`) is not a level. `-0` is `0`.
    pub fn from_f64(n: f64) -> Option<SurfaceTrustLevel> {
        [
            SurfaceTrustLevel::T0,
            SurfaceTrustLevel::T1,
            SurfaceTrustLevel::T2,
            SurfaceTrustLevel::T3,
        ]
        .into_iter()
        .find(|l| f64::from(l.as_u8()) == n)
    }
}

/// `UNATTESTED_LOCAL_SURFACE`: what the core grants a person on a token-authenticated local connection without attestation.
pub const UNATTESTED_LOCAL_SURFACE: SurfaceTrustLevel = SurfaceTrustLevel::T1;

/// Where a channel message came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChatKind {
    /// `private`
    Private,
    /// Anything that is not `private` (the TypeScript only tests `=== "private"`).
    Group,
}

/// `SurfaceFacts`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum SurfaceFacts {
    /// `desktop-app`
    DesktopApp,
    /// `cli`
    Cli {
        /// Stdin and stdout are a terminal.
        tty: bool,
        /// The OS user is the one that owns the installation.
        os_user_is_owner: bool,
    },
    /// `web`
    Web {
        /// A live session of a person.
        authenticated: bool,
        /// Epoch ms of the last step-up, when there is one.
        step_up_at: Option<f64>,
        /// Epoch ms; a value that is not finite makes the level T0.
        now: f64,
    },
    /// `channel`
    Channel {
        /// A first-party channel module.
        first_party: bool,
        /// The person opted this module into T2.
        opted_into_t2: bool,
        /// Private or group chat.
        chat: ChatKind,
        /// The identity is linked (D24).
        identity_linked: bool,
        /// The one-time nonce was issued to this person and chat and is unused and unexpired.
        nonce_valid: bool,
    },
    /// `acp-editor`
    AcpEditor {
        /// The editor started the session.
        started_session: bool,
    },
    /// `mcp-client`, `a2a-peer`, `agent`, `model-output`, `tool-result`, `unknown` and anything else.
    Other,
}

/// `surfaceTrust`.
pub fn surface_trust(facts: &SurfaceFacts) -> SurfaceTrustLevel {
    use SurfaceTrustLevel::{T0, T1, T2, T3};
    match *facts {
        SurfaceFacts::DesktopApp => T3,
        SurfaceFacts::Cli {
            tty,
            os_user_is_owner,
        } => {
            if tty && os_user_is_owner {
                T3
            } else {
                T0
            }
        }
        SurfaceFacts::Web {
            authenticated,
            step_up_at,
            now,
        } => {
            if !authenticated || !now.is_finite() {
                return T0;
            }
            match step_up_at {
                Some(up) if up.is_finite() && up <= now && now - up <= STEP_UP_WINDOW_MS => T3,
                _ => T2,
            }
        }
        SurfaceFacts::Channel {
            first_party,
            opted_into_t2,
            chat,
            identity_linked,
            nonce_valid,
        } => {
            if (first_party || opted_into_t2)
                && chat == ChatKind::Private
                && identity_linked
                && nonce_valid
            {
                T2
            } else {
                T0
            }
        }
        SurfaceFacts::AcpEditor { started_session } => {
            if started_session {
                T1
            } else {
                T0
            }
        }
        SurfaceFacts::Other => T0,
    }
}

/// Reads facts of any shape the way the TypeScript does. Not an object: [`SurfaceFacts::Other`] (T0).
pub fn surface_facts_from_js(facts: &Js) -> SurfaceFacts {
    if !facts.is_plain_object() {
        return SurfaceFacts::Other;
    }
    let flag = |k: &str| facts.get(k).is_true();
    match facts.get("kind").as_str() {
        Some("desktop-app") => SurfaceFacts::DesktopApp,
        Some("cli") => SurfaceFacts::Cli {
            tty: flag("tty"),
            os_user_is_owner: flag("osUserIsOwner"),
        },
        Some("web") => SurfaceFacts::Web {
            authenticated: flag("authenticated"),
            step_up_at: match facts.get("stepUpAt") {
                Js::Num(n) => Some(*n),
                _ => None,
            },
            // `typeof now !== "number" || !Number.isFinite(now)` is T0: NaN says so to `surface_trust`.
            now: facts.get("now").as_finite().unwrap_or(f64::NAN),
        },
        Some("channel") => SurfaceFacts::Channel {
            first_party: flag("firstParty"),
            opted_into_t2: flag("optedIntoT2"),
            chat: if facts.get("chat").as_str() == Some("private") {
                ChatKind::Private
            } else {
                ChatKind::Group
            },
            identity_linked: flag("identityLinked"),
            nonce_valid: flag("nonceValid"),
        },
        Some("acp-editor") => SurfaceFacts::AcpEditor {
            started_session: flag("startedSession"),
        },
        _ => SurfaceFacts::Other,
    }
}

/// `surfaceTrust` for input of any shape.
pub fn surface_trust_js(facts: &Js) -> SurfaceTrustLevel {
    surface_trust(&surface_facts_from_js(facts))
}

/// `surfaceSatisfies`: does a decision made on a surface of level `have` meet what the request needs? T0 satisfies nothing,
/// and `None` (a capability that never asks) cannot be decided anywhere.
pub fn surface_satisfies(have: SurfaceTrustLevel, required: Option<SurfaceTrustLevel>) -> bool {
    match required {
        None => false,
        Some(_) if have == SurfaceTrustLevel::T0 => false,
        Some(r) => have >= r,
    }
}

/// `surfaceSatisfies` for input of any shape: a `have` that is not one of 1, 2, 3 or a `required` that is not `null` or one of
/// 0 to 3 (a string, `undefined`, `NaN`, 1.5) satisfies nothing.
pub fn surface_satisfies_js(have: &Js, required: &Js) -> bool {
    let level = |v: &Js| match v {
        Js::Num(n) => SurfaceTrustLevel::from_f64(*n),
        _ => None,
    };
    match (level(have), level(required)) {
        (Some(h), Some(r)) => surface_satisfies(h, Some(r)),
        _ => false,
    }
}

/// A fact about the connection that the core verified itself (`ConnectionAttestation`). Anything else is ignored.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ConnectionAttestation {
    /// `desktop-app`
    DesktopApp,
    /// `cli`
    Cli {
        /// Terminal.
        tty: bool,
        /// Owning OS user.
        os_user_is_owner: bool,
    },
    /// `web-step-up`
    WebStepUp {
        /// Epoch ms of a step-up the core verified (a non-finite value is no step-up).
        step_up_at: Option<f64>,
    },
}

/// `ConnectionFacts`, with the principal reduced to the one thing `connectionSurface` reads of it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ConnectionFacts {
    /// The principal is an object whose `kind` is `person`.
    pub is_person: bool,
    /// Epoch ms, from the core's clock; a value that is not finite makes the level T0.
    pub now: f64,
    /// What the core verified about the connection, if anything.
    pub attestation: Option<ConnectionAttestation>,
}

impl ConnectionFacts {
    /// Facts for an RBAC principal (`None`: no principal, T0).
    pub fn for_principal(
        principal: Option<&Principal>,
        now: f64,
        attestation: Option<ConnectionAttestation>,
    ) -> ConnectionFacts {
        ConnectionFacts {
            is_person: principal.is_some_and(|p| p.kind == Some(PrincipalKind::Person)),
            now,
            attestation,
        }
    }
}

/// `connectionSurface`: a person on a token connection is [`UNATTESTED_LOCAL_SURFACE`] (T1) unless an attestation lifts them
/// to T3. An attestation can only raise a person above the unattested level, never lower it; T2 is not reachable here.
pub fn connection_surface(facts: &ConnectionFacts) -> SurfaceTrustLevel {
    if !facts.is_person || !facts.now.is_finite() {
        return SurfaceTrustLevel::T0;
    }
    let level = match facts.attestation {
        Some(ConnectionAttestation::DesktopApp) => surface_trust(&SurfaceFacts::DesktopApp),
        Some(ConnectionAttestation::Cli {
            tty,
            os_user_is_owner,
        }) => surface_trust(&SurfaceFacts::Cli {
            tty,
            os_user_is_owner,
        }),
        Some(ConnectionAttestation::WebStepUp { step_up_at }) => {
            surface_trust(&SurfaceFacts::Web {
                authenticated: true,
                step_up_at,
                now: facts.now,
            })
        }
        None => SurfaceTrustLevel::T0,
    };
    if level == SurfaceTrustLevel::T3 {
        SurfaceTrustLevel::T3
    } else {
        UNATTESTED_LOCAL_SURFACE
    }
}

/// `connectionSurface` for input of any shape.
pub fn connection_surface_js(facts: &Js) -> SurfaceTrustLevel {
    if !facts.is_plain_object() {
        return SurfaceTrustLevel::T0;
    }
    let principal = facts.get("principal");
    let is_person = principal.is_plain_object() && principal.get("kind").as_str() == Some("person");
    let now = match facts.get("now").as_finite() {
        Some(n) => n,
        None => return SurfaceTrustLevel::T0,
    };
    let att = facts.get("attestation");
    let attestation = if att.is_plain_object() {
        match att.get("kind").as_str() {
            Some("desktop-app") => Some(ConnectionAttestation::DesktopApp),
            Some("cli") => Some(ConnectionAttestation::Cli {
                tty: att.get("tty").is_true(),
                os_user_is_owner: att.get("osUserIsOwner").is_true(),
            }),
            Some("web-step-up") => Some(ConnectionAttestation::WebStepUp {
                step_up_at: match att.get("stepUpAt") {
                    Js::Num(n) => Some(*n),
                    _ => None,
                },
            }),
            _ => None,
        }
    } else {
        None
    };
    connection_surface(&ConnectionFacts {
        is_person,
        now,
        attestation,
    })
}
