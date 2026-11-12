//! Bounded A1 run ledger and start markers. These files carry evidence, never data authority.
use crate::{
    contract::{Cancel, EngineError, StoreError},
    store::{directory::TrustedDirectory, kernel_lease},
    text::{
        js::{js_trim, JsString},
        json::{parse_json, write_json, TolerantJsonValue as Json},
    },
};
use std::{io::Write, path::Path};
pub(crate) mod io;
pub(crate) mod json;
mod session;
pub use session::{JobSession, MigrationReport, RecoveryReport, RunAdmission};
const MAX_BYTES: usize = 64 * 1024 * 1024;
const MAX_RECORD: usize = 1024 * 1024;
const MAX_ROWS: usize = 50_000;
const MAX_MARKERS: usize = 1024;

/// Lossless object rows plus the count of malformed/non-object nonempty lines.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Snapshot {
    /// Raw persisted objects, including unknown legacy fields and UTF-16 strings.
    pub rows: Vec<Json>,
    /// Damaged lines retained in place on disk; never silently repaired or deleted.
    pub unreadable: usize,
}
/// One safe agent's ledger below an already selected, held jobs directory.
/// The caller owns job authorization. Opening/reading does not create agent directories.
pub struct JobLedger {
    root: TrustedDirectory,
    agent: String,
}
impl JobLedger {
    /// Bind an existing physical jobs root and a single ASCII agent segment.
    pub fn open(root: &Path, agent: &str) -> Result<Self, StoreError> {
        safe_name(agent, 64)?;
        Ok(Self {
            root: TrustedDirectory::open(root)?,
            agent: agent.into(),
        })
    }
    fn existing(&self) -> Result<Option<TrustedDirectory>, EngineError> {
        self.root.assert_unchanged()?;
        match self.root.open_child(&self.agent) {
            Ok(dir) => Ok(Some(dir)),
            Err(StoreError::Io {
                kind: std::io::ErrorKind::NotFound,
            }) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }
    fn write<T>(
        &self,
        cancel: &Cancel,
        action: impl FnOnce(&TrustedDirectory) -> Result<T, EngineError>,
    ) -> Result<T, EngineError> {
        cancel.check()?;
        self.root.assert_unchanged()?;
        let dir = self.root.create_child(&self.agent)?;
        dir.restrict_private()?;
        let lease = kernel_lease::acquire(&dir, "job-ledger-writer", cancel, &mut || {})?;
        self.root.assert_unchanged()?;
        lease.check(&dir)?;
        cancel.check()?;
        let result = action(&dir)?;
        lease.check(&dir)?;
        dir.sync_entries()?;
        self.root.sync_entries()?;
        Ok(result)
    }
    /// Read each object in append order. Nonobjects and malformed lines contribute to unreadable.
    pub fn snapshot(&self, cancel: &Cancel) -> Result<Snapshot, EngineError> {
        cancel.check()?;
        let mut out = Snapshot {
            rows: Vec::new(),
            unreadable: 0,
        };
        let Some(dir) = self.existing()? else {
            return Ok(out);
        };
        let bytes = io::read(&dir, "ledger.jsonl", MAX_BYTES, cancel)?.unwrap_or_default();
        let text = String::from_utf8_lossy(&bytes);
        for (index, line) in text.split('\n').enumerate() {
            cancel.check()?;
            if index > MAX_ROWS || line.len() > MAX_RECORD {
                return Err(StoreError::Corrupt.into());
            }
            if js_trim(line).is_empty() {
                continue;
            }
            match parse_json(line) {
                Ok(row @ Json::Object(_)) => out.rows.push(json::node_value(row)),
                _ => out.unreadable += 1,
            }
        }
        dir.assert_unchanged()?;
        self.root.assert_unchanged()?;
        Ok(out)
    }
    /// Append one object with Node's leading v:1 field; an explicit v overrides its value.
    /// A torn tail is preserved and separated. Native writes sync before acknowledging.
    pub fn append(&self, row: &Json, cancel: &Cancel) -> Result<(), EngineError> {
        let Json::Object(fields) = row else {
            return Err(StoreError::InvalidInput.into());
        };
        let mut record = vec![(JsString::from_utf8_str("v"), Json::Number("1".into()))];
        for (key, value) in fields {
            set(&mut record, key.clone(), value.clone());
        }
        let record = json::node_value(Json::Object(record));
        let size = write_json(&record).len();
        if size > MAX_RECORD {
            return Err(StoreError::InvalidInput.into());
        }
        self.write(cancel, |dir| {
            let old = io::read(dir, "ledger.jsonl", MAX_BYTES, cancel)?.unwrap_or_default();
            if old
                .len()
                .checked_add(size + 2)
                .is_none_or(|n| n > MAX_BYTES)
            {
                return Err(StoreError::Corrupt.into());
            }
            if old.iter().filter(|b| **b == b'\n').count() >= MAX_ROWS {
                return Err(StoreError::Corrupt.into());
            }
            cancel.check()?;
            dir.append_jsonl_durable("ledger.jsonl", &record, MAX_RECORD + 2)?;
            Ok(())
        })
    }
    /// Exclusively create a start marker, retaining exactly the five Node marker fields.
    /// Registry composition must validate the job metadata before calling this persistence port.
    pub fn write_marker(&self, marker: &Json, cancel: &Cancel) -> Result<(), EngineError> {
        let (id, bytes) = prepare_marker(marker)?;
        self.write(cancel, |dir| write_marker_at(dir, &id, &bytes, cancel))
    }
    /// Remove a marker only; an absent marker is a no-op. Its run row is never removed.
    pub fn remove_marker(&self, id: &str, cancel: &Cancel) -> Result<(), EngineError> {
        safe_name(id, 128)?;
        cancel.check()?;
        let Some(dir) = self.existing()? else {
            return Ok(());
        };
        if io::child(&dir, "running")?.is_none() {
            return Ok(());
        }
        self.write(cancel, |dir| {
            let Some(markers) = io::child(dir, "running")? else {
                return Ok(());
            };
            let name = format!("{id}.started");
            if io::read(&markers, &name, MAX_RECORD, cancel)?.is_some() {
                io::remove(&markers, &name)?;
            }
            Ok(())
        })
    }
    /// Return retained markers, using each safe filename as authoritative runId.
    /// Malformed JSON becomes a corrupt marker; callers decide recovery without inventing a job.
    pub fn orphan_markers(&self, cancel: &Cancel) -> Result<Vec<Json>, EngineError> {
        cancel.check()?;
        let Some(dir) = self.existing()? else {
            return Ok(Vec::new());
        };
        let Some(markers) = io::child(&dir, "running")? else {
            return Ok(Vec::new());
        };
        let mut out = Vec::new();
        let mut total_bytes = 0;
        for (index, entry) in std::fs::read_dir(markers.path())
            .map_err(StoreError::from)?
            .enumerate()
        {
            cancel.check()?;
            if index >= MAX_MARKERS {
                return Err(StoreError::Corrupt.into());
            }
            let entry = entry.map_err(StoreError::from)?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| StoreError::Corrupt)?;
            let Some(id) = name.strip_suffix(".started") else {
                continue;
            };
            safe_name(id, 128)?;
            let bytes =
                io::read(&markers, &name, MAX_RECORD, cancel)?.ok_or(StoreError::Unavailable)?;
            total_bytes += bytes.len();
            if total_bytes > MAX_BYTES {
                return Err(StoreError::Corrupt.into());
            }
            out.push(marker_value(&bytes, id));
        }
        markers.assert_unchanged()?;
        dir.assert_unchanged()?;
        self.root.assert_unchanged()?;
        Ok(out)
    }
}
fn safe_name(value: &str, max: usize) -> Result<(), StoreError> {
    if value.is_empty()
        || value.len() > max
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(StoreError::InvalidInput);
    }
    Ok(())
}
fn set(fields: &mut Vec<(JsString, Json)>, key: JsString, value: Json) {
    if let Some((_, old)) = fields.iter_mut().find(|(k, _)| *k == key) {
        *old = value;
    } else {
        fields.push((key, value));
    }
}
fn spread(value: Json) -> Vec<(JsString, Json)> {
    match value {
        Json::Object(fields) => fields,
        Json::Array(values) => values
            .into_iter()
            .enumerate()
            .map(|(i, v)| (JsString::from_utf8_str(&i.to_string()), v))
            .collect(),
        Json::String(value) => value
            .as_utf16_units()
            .iter()
            .enumerate()
            .map(|(i, v)| {
                (
                    JsString::from_utf8_str(&i.to_string()),
                    Json::String(JsString::from_utf16_units(vec![*v])),
                )
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn marker_value(bytes: &[u8], id: &str) -> Json {
    let run_id = (
        JsString::from_utf8_str("runId"),
        Json::String(JsString::from_utf8_str(id)),
    );
    let fields = match parse_json(&String::from_utf8_lossy(bytes)) {
        Ok(value) => {
            let mut fields = spread(json::node_value(value));
            set(&mut fields, run_id.0, run_id.1);
            fields
        }
        Err(_) => vec![
            run_id,
            (JsString::from_utf8_str("corrupt"), Json::Bool(true)),
        ],
    };
    Json::Object(fields)
}

fn prepare_marker(marker: &Json) -> Result<(String, String), EngineError> {
    let Json::Object(fields) = marker else {
        return Err(StoreError::InvalidInput.into());
    };
    let id = fields
        .iter()
        .rev()
        .find(|(k, _)| k.to_utf8_lossy() == "runId")
        .and_then(|(_, v)| {
            if let Json::String(s) = v {
                String::from_utf16(s.as_utf16_units()).ok()
            } else {
                None
            }
        })
        .ok_or(StoreError::InvalidInput)?;
    safe_name(&id, 128)?;
    let projected = ["runId", "job", "phase", "trigger", "startedAt"]
        .iter()
        .filter_map(|name| {
            fields
                .iter()
                .rev()
                .find(|(k, _)| k.to_utf8_lossy() == *name)
                .cloned()
        })
        .collect();
    let bytes = write_json(&json::node_value(Json::Object(projected)));
    if bytes.len() > MAX_RECORD {
        return Err(StoreError::InvalidInput.into());
    }
    Ok((id, bytes))
}

fn write_marker_at(
    dir: &TrustedDirectory,
    id: &str,
    bytes: &str,
    cancel: &Cancel,
) -> Result<(), EngineError> {
    let markers = dir.create_child("running")?;
    markers.restrict_private()?;
    for (index, entry) in std::fs::read_dir(markers.path())
        .map_err(StoreError::from)?
        .enumerate()
    {
        cancel.check()?;
        entry.map_err(StoreError::from)?;
        if index >= MAX_MARKERS - 1 {
            return Err(StoreError::Corrupt.into());
        }
    }
    let name = format!("{id}.started");
    let mut file = markers.create_file(&name)?;
    file.write_all(bytes.as_bytes()).map_err(StoreError::from)?;
    file.sync_all().map_err(StoreError::from)?;
    if crate::store::directory::regular_file_identity(&file)?
        != crate::store::directory::regular_file_identity(&markers.open_file(&name)?)?
    {
        return Err(StoreError::UntrustedPath.into());
    }
    io::sync(&markers)?;
    markers.assert_unchanged()?;
    Ok(())
}
