//! The report `doctor.report` returns (`Report`, `Check` of `doctor-report.ts`; `doctor.report`'s result in the RPC
//! schema): one group of checks, each with a status, a summary and perhaps a repair hint.
use serde_json::{json, Map, Value};

/// A check's verdict.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    /// Fine (the probe's `info` is `ok` too).
    Ok,
    /// Works, but not as it should.
    Warn,
    /// Broken.
    Fail,
    /// Not checked (the probe's `skip`).
    Skipped,
}

impl Status {
    /// The word the schema uses.
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Ok => "ok",
            Status::Warn => "warn",
            Status::Fail => "fail",
            Status::Skipped => "skipped",
        }
    }

    /// The status of that word, if it is one of the schema's.
    pub fn parse(word: &str) -> Option<Status> {
        Some(match word {
            "ok" => Status::Ok,
            "warn" => Status::Warn,
            "fail" => Status::Fail,
            "skipped" => Status::Skipped,
            _ => return None,
        })
    }
}

/// What to do about a check.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Repair {
    /// `hint` for the probe's hints.
    pub kind: String,
    /// The text shown.
    pub label: String,
}

/// One check.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Check {
    /// A stable id such as `models.cache`.
    pub id: String,
    /// The verdict.
    pub status: Status,
    /// What was found.
    pub summary: String,
    /// What to do.
    pub repair: Option<Repair>,
}

impl Check {
    /// A check without a repair.
    pub fn new(id: impl Into<String>, status: Status, summary: impl Into<String>) -> Check {
        Check {
            id: id.into(),
            status,
            summary: summary.into(),
            repair: None,
        }
    }

    /// With a repair.
    pub fn with_repair(mut self, kind: impl Into<String>, label: impl Into<String>) -> Check {
        self.repair = Some(Repair {
            kind: kind.into(),
            label: label.into(),
        });
        self
    }

    /// The check as the schema's object.
    pub fn to_value(&self) -> Value {
        let mut out = Map::new();
        out.insert("id".into(), Value::String(self.id.clone()));
        out.insert("status".into(), Value::String(self.status.as_str().into()));
        out.insert("summary".into(), Value::String(self.summary.clone()));
        if let Some(r) = &self.repair {
            out.insert("repair".into(), json!({"kind": r.kind, "label": r.label}));
        }
        Value::Object(out)
    }

    /// A check from the schema's object (the reverse of [`Check::to_value`]); `None` when it is not one.
    pub fn from_value(v: &Value) -> Option<Check> {
        let o = v.as_object()?;
        let repair = match o.get("repair") {
            None | Some(Value::Null) => None,
            Some(r) => Some(Repair {
                kind: r.get("kind")?.as_str()?.to_owned(),
                label: r.get("label")?.as_str()?.to_owned(),
            }),
        };
        Some(Check {
            id: o.get("id")?.as_str()?.to_owned(),
            status: Status::parse(o.get("status")?.as_str()?)?,
            summary: o.get("summary")?.as_str()?.to_owned(),
            repair,
        })
    }
}

/// A titled list of checks.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Group {
    /// `provisioning`.
    pub id: String,
    /// `Provisioning`.
    pub title: String,
    /// The checks, in report order.
    pub checks: Vec<Check>,
}

/// The report.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Report {
    /// When the probe ran, as an ISO 8601 string.
    pub generated_at: String,
    /// The groups (one: `provisioning`).
    pub groups: Vec<Group>,
}

impl Report {
    /// The result of `doctor.report`.
    pub fn to_value(&self) -> Value {
        json!({
            "generatedAt": self.generated_at,
            "groups": self.groups.iter().map(|g| json!({
                "id": g.id,
                "title": g.title,
                "checks": g.checks.iter().map(Check::to_value).collect::<Vec<_>>(),
            })).collect::<Vec<_>>(),
        })
    }

    /// Every check of every group.
    pub fn checks(&self) -> impl Iterator<Item = &Check> {
        self.groups.iter().flat_map(|g| g.checks.iter())
    }
}
