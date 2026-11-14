//! The pure helpers of `identity/service.ts`: the id validation (`text`, `channelOf`, `identityOf`), `isChannelName`,
//! `v1PrincipalOf`, the `Actor` and `ChannelIdentity` types and the service's constants. The service itself (humans, links,
//! pairings, claim, confirm, the store) is P4-12 task 4 and extends this file.
use super::{error::IdentityError, sha256_hex, utf8_of_units};
use crate::js::{json_stringify_units, utf16};
use crate::rbac::types::{PrincipalKind, Role};

/// `DEFAULT_CODE_TTL_MS`: ten minutes.
pub const DEFAULT_CODE_TTL_MS: i64 = 10 * 60_000;
/// `MAX_CODE_TTL_MS`: one hour.
pub const MAX_CODE_TTL_MS: i64 = 60 * 60_000;
/// `MAX_PENDING_PER_HUMAN_CHANNEL`.
pub const MAX_PENDING_PER_HUMAN_CHANNEL: usize = 3;
/// `MAX_FIELD`: the longest account id, user id and display name, in UTF-16 code units.
pub const MAX_FIELD: usize = 128;
/// `String(CHANNEL)`: the pattern as the refusal message prints it.
pub const CHANNEL_PATTERN: &str = "/^[a-z][a-z0-9._-]{0,31}$/";

/// Who performed an owner-side action (`Actor`): the audit's `actor`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Actor {
    /// The acting harness user id.
    pub user: String,
    /// The host the action came from.
    pub host: String,
    /// `person` or `agent`; `None` is neither.
    pub kind: Option<PrincipalKind>,
    /// The role the caller holds.
    pub role: Option<Role>,
    /// API-token scopes, `None` for a session.
    pub token_scopes: Option<Vec<String>>,
}

/// A channel handle (`ChannelIdentity`). `display_name` is a label for people; it is never matched on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChannelIdentity {
    /// The channel kind.
    pub channel: String,
    /// The account on that channel (bot, guild, workspace).
    pub account_id: String,
    /// The external user id.
    pub user_id: String,
    /// A label.
    pub display_name: Option<String>,
}

fn is_control(u: u16) -> bool {
    u <= 0x1f || u == 0x7f
}

/// `text(v, field, max)` over code units: a non-empty string of at most `max` units without control characters
/// (`/[\u0000-\u001f\u007f]/`). Anything else is `invalid-params` naming `field`.
pub fn text_units(v: &[u16], field: &str, max: usize) -> Result<(), IdentityError> {
    if v.is_empty() || v.len() > max || v.iter().any(|u| is_control(*u)) {
        return Err(IdentityError::bad(
            field,
            format!(
                "{field} must be a non-empty string of at most {max} characters without control characters"
            ),
        ));
    }
    Ok(())
}

/// [`text_units`] of a Rust string.
pub fn text(v: &str, field: &str, max: usize) -> Result<(), IdentityError> {
    text_units(&utf16(v), field, max)
}

/// `isChannelName` over code units: `/^[a-z][a-z0-9._-]{0,31}$/`.
pub fn is_channel_name_units(v: &[u16]) -> bool {
    let valid_first = |u: u16| matches!(u, 0x61..=0x7a);
    let valid_rest = |u: u16| matches!(u, 0x61..=0x7a | 0x30..=0x39 | 0x2e | 0x5f | 0x2d);
    match v.split_first() {
        Some((first, rest)) => {
            valid_first(*first) && rest.len() <= 31 && rest.iter().all(|u| valid_rest(*u))
        }
        None => false,
    }
}

/// `isChannelName` of a Rust string.
pub fn is_channel_name(v: &str) -> bool {
    is_channel_name_units(&utf16(v))
}

/// `channelOf(v, field)`: the channel name or `invalid-params` naming `field` (TypeScript's default is `"channel"`).
pub fn channel_of(v: &str, field: &str) -> Result<(), IdentityError> {
    if is_channel_name(v) {
        Ok(())
    } else {
        Err(IdentityError::bad(
            field,
            format!("{field} must match {CHANNEL_PATTERN}"),
        ))
    }
}

/// `identityOf(i)`: the channel first, then the account id, the user id and, when there is one, the display name; the first that
/// fails decides the error.
pub fn identity_of(i: &ChannelIdentity) -> Result<ChannelIdentity, IdentityError> {
    channel_of(&i.channel, "channel")?;
    text(&i.account_id, "accountId", MAX_FIELD)?;
    text(&i.user_id, "userId", MAX_FIELD)?;
    if let Some(name) = &i.display_name {
        text(name, "displayName", MAX_FIELD)?;
    }
    Ok(i.clone())
}

/// `v1PrincipalOf` over code units: `user:v1:` plus the SHA-256 of `JSON.stringify([channel, accountId, userId])` (a lone
/// surrogate is written as the `\udxxx` escape `JSON.stringify` uses, so the hash input is plain ASCII there).
pub fn v1_principal_of_units(channel: &[u16], account_id: &[u16], user_id: &[u16]) -> String {
    let json = format!(
        "[{},{},{}]",
        json_stringify_units(channel),
        json_stringify_units(account_id),
        json_stringify_units(user_id)
    );
    format!("user:v1:{}", sha256_hex(&[&utf8_of_units(&utf16(&json))]))
}

/// [`v1_principal_of_units`] of Rust strings.
pub fn v1_principal_of(channel: &str, account_id: &str, user_id: &str) -> String {
    v1_principal_of_units(&utf16(channel), &utf16(account_id), &utf16(user_id))
}
