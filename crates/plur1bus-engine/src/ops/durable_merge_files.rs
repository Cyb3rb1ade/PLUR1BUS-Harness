//! Held archive/audit directories; exact collision checks and bounded atomic publications.
use super::*;
pub(super) struct Files {
    archive: TrustedDirectory,
    audit: TrustedDirectory,
    name: String,
    event: Value,
}
impl Files {
    pub(super) fn open(
        home: &TrustedDirectory,
        workspace: &TrustedDirectory,
        agent: &str,
        r: &MergeRequest,
        create: bool,
        cancel: &Cancel,
    ) -> Result<Self, EngineError> {
        cancel.check()?;
        let child =
            |parent: &TrustedDirectory, name: &str| -> Result<TrustedDirectory, EngineError> {
                Ok(if create {
                    parent.create_child(name)?
                } else {
                    parent.open_child(name)?
                })
            };
        let memory = child(home, "memory")?;
        let root = child(&memory, "_archive")?;
        let archive = child(&root, agent)?;
        archive.restrict_private()?;
        let audit = if create {
            workspace.create_child(".adaptive-learning")?
        } else {
            workspace.open_child(".adaptive-learning")?
        };
        audit.restrict_private()?;
        let timestamp = super::super::archive::iso(r.now_ms)?.replace([':', '.'], "-");
        let name = format!("{timestamp}-{}.json", r.source.row.id);
        let identity = protocol::identity(
            agent,
            &r.source.row.id,
            &JsString::from(effective_key(r)),
            cancel,
        )?;
        let event = json!({"event":"memory.deleted","source":"memory_store_merge","agentId":agent,"via":"merge","archivePath":archive.path().join(&name),"idempotencyKey":identity.idempotency_key,"timestamp":super::super::archive::iso(r.now_ms)?,"memoryId":r.source.row.id});
        Ok(Self {
            archive,
            audit,
            name,
            event,
        })
    }
    pub(super) fn archive_path(&self) -> PathBuf {
        self.archive.path().join(&self.name)
    }
    pub(super) fn check(&self) -> Result<(), EngineError> {
        self.archive.assert_unchanged()?;
        self.audit.assert_unchanged()?;
        Ok(())
    }
    pub(super) fn validate(
        &self,
        row: &MemoryRow,
        stage: u8,
        cancel: &Cancel,
    ) -> Result<(), EngineError> {
        match io::read(&self.archive, &self.name, state::MAX_STATE, cancel)? {
            Some(bytes) => {
                let value: Value =
                    serde_json::from_slice(&bytes).map_err(|_| StoreError::Corrupt)?;
                if value != serde_json::to_value(row).map_err(|_| StoreError::Corrupt)? {
                    return Err(StoreError::Corrupt.into());
                }
            }
            None if stage == 0 => (),
            None => return Err(StoreError::Corrupt.into()),
        }
        let expected = &self.event;
        let key = &expected["idempotencyKey"];
        let bytes = io::read(&self.audit, "destructive-ops.jsonl", io::MAX_BYTES, cancel)?
            .unwrap_or_default();
        let rows = io::records(&bytes)?;
        let mut matches = 0;
        for (r, _) in &rows {
            if &r["idempotencyKey"] == key {
                if r != expected {
                    return Err(StoreError::Corrupt.into());
                }
                matches += 1;
            }
        }
        if matches > 1 || (stage >= 5 && matches != 1) {
            return Err(StoreError::Corrupt.into());
        }
        if matches == 0
            && (rows.len() >= io::MAX_ROWS
                || bytes.len()
                    + serde_json::to_vec(expected)
                        .map_err(|_| StoreError::Corrupt)?
                        .len()
                    + 1
                    > io::MAX_BYTES)
        {
            return Err(StoreError::Unavailable.into());
        }
        Ok(())
    }
    pub(super) fn archive(
        &self,
        row: &MemoryRow,
        cancel: &Cancel,
        check: &dyn Fn() -> Result<(), EngineError>,
    ) -> Result<(), EngineError> {
        let expected = serde_json::to_value(row).map_err(|_| StoreError::Corrupt)?;
        if let Some(bytes) = io::read(&self.archive, &self.name, state::MAX_STATE, cancel)? {
            let actual: Value = serde_json::from_slice(&bytes).map_err(|_| StoreError::Corrupt)?;
            if actual != expected {
                return Err(StoreError::Corrupt.into());
            }
            return Ok(());
        }
        let bytes = serde_json::to_vec_pretty(&expected).map_err(|_| StoreError::Corrupt)?;
        if bytes.len() > state::MAX_STATE {
            return Err(StoreError::InvalidInput.into());
        }
        io::replace(&self.archive, &self.name, None, &bytes, cancel, check)
    }
    pub(super) fn audit(
        &self,
        cancel: &Cancel,
        check: &dyn Fn() -> Result<(), EngineError>,
    ) -> Result<(), EngineError> {
        let expected = &self.event;
        let key = &expected["idempotencyKey"];
        let old = io::read(&self.audit, "destructive-ops.jsonl", io::MAX_BYTES, cancel)?;
        let rows = io::records(old.as_deref().unwrap_or_default())?;
        let matching = rows
            .iter()
            .filter(|(r, _)| &r["idempotencyKey"] == key)
            .collect::<Vec<_>>();
        if !matching.is_empty() {
            if matching.len() != 1 || &matching[0].0 != expected {
                return Err(StoreError::Corrupt.into());
            }
            return Ok(());
        }
        let mut bytes = old.clone().unwrap_or_default();
        bytes.extend(serde_json::to_vec(expected).map_err(|_| StoreError::Corrupt)?);
        bytes.push(b'\n');
        if rows.len() >= io::MAX_ROWS || bytes.len() > io::MAX_BYTES {
            return Err(StoreError::Unavailable.into());
        }
        io::replace(
            &self.audit,
            "destructive-ops.jsonl",
            old.as_deref(),
            &bytes,
            cancel,
            check,
        )
    }
}
