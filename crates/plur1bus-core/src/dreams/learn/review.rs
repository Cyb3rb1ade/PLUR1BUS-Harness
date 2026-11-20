//! Evidence-only learning review and bounded read verification.

use super::{array, equals, string, target_valid, target_value, Error, Target};
use crate::js::{js_trim, sort_default};
use crate::logs::methods::AbortSignal;
use crate::policy::js_value::number_to_string;
use crate::toolcall::json::{parse, Obj, V};

const MAX_BYTES: usize = 32_768;
const MAX_EXCERPT: usize = 4000;

/// Response to a read scoped by the host to a trusted project root.
pub struct ReadResult {
    /// The host verified a complete, successful read.
    pub ok: bool,
    /// Text returned within the request's byte limit.
    pub text: Option<String>,
    /// The result may omit bytes past the limit.
    pub truncated: bool,
}

/// The only operation admitted to automated project verification.
pub trait ReadPort {
    /// Read one relative path inside the configured project, with an exact byte cap.
    fn read(
        &mut self,
        target: &Target,
        path: &str,
        max_bytes: usize,
        abort: &AbortSignal,
    ) -> ReadResult;
}

/// True for canonical, public project-relative evidence paths.
pub fn safe_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    let relative = path.strip_suffix('/').unwrap_or(path);
    !relative.is_empty()
        && path.encode_utf16().count() <= 256
        && !path
            .chars()
            .any(|c| c.is_control() || matches!(c, ':' | '\\'))
        && relative
            .split('/')
            .all(|p| !p.is_empty() && !p.starts_with('.'))
        && [
            "secret",
            "credential",
            "password",
            "privatekey",
            "private-key",
            "private_key",
            "private.key",
        ]
        .iter()
        .all(|name| !lower.contains(name))
}

/// Verify a project's checks. Only a complete, authorized read may support or contradict.
pub fn verify(
    target: &Target,
    finding: &V,
    read: Option<&mut dyn ReadPort>,
    abort: &AbortSignal,
    check: impl Fn() -> Result<(), Error>,
) -> Result<&'static str, Error> {
    if !target_valid(target)
        || !finding
            .get("target")
            .is_some_and(|actual| actual.deep_equal(&target_value(target).unwrap_or(V::Null)))
    {
        return Err(Error::Rights);
    }
    if target.scope != "project" {
        return Ok("not-applicable");
    }
    let Some(read) = read else {
        return Ok("unknown");
    };
    let Some(checks) = finding
        .get("checks")
        .and_then(V::as_arr)
        .filter(|v| !v.is_empty() && v.len() <= 8)
    else {
        return Ok("unknown");
    };
    let mut supported = true;
    for entry in checks {
        if abort.is_aborted() {
            return Err(Error::Interrupted);
        }
        let (Ok(path), Ok(needle)) = (string(entry, "path"), string(entry, "contains")) else {
            return Ok("unknown");
        };
        if !safe_path(&path) || needle.is_empty() || needle.encode_utf16().count() > 1000 {
            return Ok("unknown");
        }
        check()?;
        let got = read.read(target, &path, MAX_BYTES, abort);
        if abort.is_aborted() {
            return Err(Error::Interrupted);
        }
        check()?;
        let Some(text) = got
            .text
            .filter(|s| s.len() <= MAX_BYTES && got.ok && !got.truncated)
        else {
            return Ok("unknown");
        };
        supported &= text.contains(&needle);
    }
    Ok(if supported {
        "supported"
    } else {
        "contradicted"
    })
}

pub(super) fn evidence_view(finding: &V, transcripts: &[V]) -> Result<Vec<V>, Error> {
    let mut evidence = Vec::new();
    for reference in array(finding, "evidence")? {
        let id = string(reference, "sessionId")?;
        let owner = string(reference, "owner")?;
        let agent = string(reference, "agentId")?;
        let turn = string(reference, "turnId")?;
        let sid = string(reference, "sourceId")?;
        let source = transcripts
            .iter()
            .find(|t| {
                t.get("session").is_some_and(|s| {
                    equals(s, "id", &id)
                        && equals(s, "owner", &owner)
                        && equals(s, "agentId", &agent)
                })
            })
            .ok_or(Error::Rights)?;
        let same = |row: &V| equals(row, "sessionId", &id) && equals(row, "turnId", &turn);
        let excerpt = match string(reference, "source")?.as_str() {
            "message" => array(source, "messages")?
                .iter()
                .find(|m| same(m) && equals(m, "id", &sid))
                .map(|m| string(m, "text"))
                .transpose()?,
            "event" => array(source, "events")?
                .iter()
                .find(|e| {
                    same(e)
                        && e.get("seq")
                            .and_then(V::as_f64)
                            .is_some_and(|n| number_to_string(n) == sid)
                })
                .and_then(|e| e.get("data"))
                .map(V::stringify),
            _ => None,
        }
        .ok_or(Error::Rights)?;
        if excerpt.encode_utf16().count() > MAX_EXCERPT {
            return Err(Error::Source);
        }
        evidence.push(V::obj([
            ("ref", reference.clone()),
            ("excerpt", V::s(&excerpt)),
        ]));
    }
    Ok(evidence)
}

fn details(value: &V, pairs: &[&str]) -> Result<Obj, Error> {
    let fields = pairs
        .iter()
        .map(|key| {
            value
                .get(key)
                .cloned()
                .map(|v| ((*key).into(), v))
                .ok_or(Error::InvalidOutput)
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Obj::from_pairs(fields))
}

/// Request payload for the second model, scoped to exact evidence.
pub fn skeptic_data(finding: &V, transcripts: &[V]) -> Result<Option<V>, Error> {
    if equals(finding, "desiredTier", "C") {
        return Ok(None);
    }
    let view = evidence_view(finding, transcripts)?;
    Ok(Some(V::obj([
        ("finding", V::Obj(details(finding, &["text", "change"])?)),
        ("evidence", V::Arr(view)),
        (
            "verify",
            finding.get("verify").cloned().ok_or(Error::InvalidOutput)?,
        ),
    ])))
}

fn single_field(reply: &str, key: &str) -> Result<String, Error> {
    if reply.len() > super::BYTES {
        return Err(Error::InvalidOutput);
    }
    let value = parse(reply).ok_or(Error::InvalidOutput)?;
    if value.as_obj().is_none_or(|obj| obj.len() != 1) {
        return Err(Error::InvalidOutput);
    }
    string(&value, key).map_err(|_| Error::InvalidOutput)
}

fn reviewed(finding: &V, field: &str, value: &str, model: &str) -> Result<V, Error> {
    if model.is_empty() || model.len() > 256 || model.chars().any(char::is_control) {
        return Err(Error::ProviderFailed);
    }
    let mut finding = finding.as_obj().cloned().ok_or(Error::InvalidOutput)?;
    let append = |name: &str, element: &str| {
        let mut values = finding
            .get(name)
            .and_then(V::as_arr)
            .unwrap_or(&[])
            .iter()
            .filter_map(|v| v.as_js().map(|s| s.lossy()))
            .collect::<Vec<_>>();
        values.push(element.into());
        sort_default(&mut values);
        values.dedup();
        V::strs(&values)
    };
    let classes = append("modelClasses", "large");
    let models = append("models", model);
    finding.set(field, V::s(value));
    finding.set("effectiveTier", V::s("C"));
    finding.set("modelClasses", classes);
    finding.set("models", models);
    Ok(V::Obj(finding))
}

/// Apply only an explicit verdict to the already checked finding.
pub fn apply_skeptic(finding: &V, reply: &str, model: &str) -> Result<V, Error> {
    let verdict = single_field(reply, "verdict")?;
    if !matches!(verdict.as_str(), "holds" | "refuted" | "insufficient") {
        return Err(Error::InvalidOutput);
    }
    reviewed(finding, "skeptic", &verdict, model)
}

/// Request payload for the wording stage without raw source evidence.
pub fn wording_data(finding: &V) -> Result<V, Error> {
    Ok(V::Obj(details(
        finding,
        &["text", "change", "verify", "skeptic"],
    )?))
}

/// Apply a bounded wording rewrite without changing scope, evidence or identity.
pub fn apply_wording(finding: &V, reply: &str, model: &str) -> Result<V, Error> {
    let wrote = single_field(reply, "text")?;
    let text = js_trim(&wrote);
    if text.is_empty() || wrote.encode_utf16().count() > MAX_EXCERPT {
        return Err(Error::InvalidOutput);
    }
    reviewed(finding, "text", text, model)
}

#[cfg(test)]
#[path = "review_vectors.rs"]
mod vectors;
