//! Descriptive names from the already authorized physical workspace, never identity grants.
use super::merged::optional;
use crate::{
    contract::{Cancel, EngineError, StoreError},
    store::directory::{regular_file_identity, TrustedDirectory},
    text::js::{is_js_whitespace, JsString},
};
use std::io::Read;

pub(super) struct ParticipantNames {
    pub user: JsString,
    pub assistant: JsString,
}
fn space(unit: u16) -> bool {
    char::from_u32(u32::from(unit)).is_some_and(is_js_whitespace)
}
fn extract(text: &str) -> Option<JsString> {
    let units = text.encode_utf16().take(4000).collect::<Vec<_>>();
    let marker = JsString::from("**Name:**");
    let mut start = units
        .windows(marker.as_utf16_units().len())
        .position(|w| w == marker.as_utf16_units())?
        + marker.as_utf16_units().len();
    while start < units.len() && space(units[start]) {
        start += 1;
    }
    let end = units[start..]
        .iter()
        .position(|u| *u == 10)
        .map_or(units.len(), |n| start + n);
    let stripped = units[start..end]
        .iter()
        .copied()
        .filter(|u| ![42, 95, 96].contains(u))
        .collect::<Vec<_>>();
    let first = stripped.iter().position(|u| !space(*u))?;
    let last = stripped.iter().rposition(|u| !space(*u))? + 1;
    let raw = &stripped[first..last];
    if raw == [45] || raw == [0x2014] {
        return None;
    }
    let mut name = raw[..raw.len().min(60)].to_vec();
    // F3 / RE-D17: display text must not end with half an emoji. The input prefix can also
    // split a pair at unit 4000. An empty surviving fragment uses the ordinary fallback.
    if name.last().is_some_and(|u| (0xd800..=0xdbff).contains(u)) {
        name.pop();
    }
    (!name.is_empty()).then(|| JsString::from_utf16_units(name))
}
fn read(
    workspace: &TrustedDirectory,
    name: &str,
    cancel: &Cancel,
) -> Result<Option<JsString>, EngineError> {
    cancel.check()?;
    let Some(mut file) = optional(workspace.open_file(name))? else {
        return Ok(None);
    };
    super::vectors::ordinary(&file)?;
    let identity = regular_file_identity(&file)?;
    // 16 KiB contains every possible UTF-8 encoding of the first 4000 UTF-16 units,
    // including a complete final code point. Reading an entire oversized document is unnecessary.
    let mut bytes = Vec::new();
    file.by_ref()
        .take(16 * 1024)
        .read_to_end(&mut bytes)
        .map_err(StoreError::from)?;
    cancel.check()?;
    let current = workspace.open_file(name)?;
    super::vectors::ordinary(&current)?;
    if regular_file_identity(&current)? != identity {
        return Err(StoreError::UntrustedPath.into());
    }
    workspace.assert_unchanged()?;
    Ok(extract(&String::from_utf8_lossy(&bytes)))
}
/// The caller checks original current policy before/after this closed two-file read.
/// No mtime-only cache survives callers or conceals an in-place content change.
pub(super) fn resolve(
    workspace: &TrustedDirectory,
    agent: &str,
    cancel: &Cancel,
) -> Result<ParticipantNames, EngineError> {
    workspace.assert_unchanged()?;
    let user = read(workspace, "USER.md", cancel)?.unwrap_or_else(|| JsString::from("Nutzer"));
    let assistant = read(workspace, "IDENTITY.md", cancel)?
        .unwrap_or_else(|| JsString::from(if agent.is_empty() { "agent" } else { agent }));
    workspace.assert_unchanged()?;
    cancel.check()?;
    Ok(ParticipantNames { user, assistant })
}
