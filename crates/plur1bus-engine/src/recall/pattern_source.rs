//! Read-only, original-request pattern snapshots for prompt recall (S4).
use crate::{
    context::RequestContext,
    contract::{Cancel, EngineError, StoreError},
    neo::merged::{MetadataReader, RecordKind},
};
use serde_json::Value;
use std::path::Path;

/// Existing physical Neo root and original canonical caller, not a caller-supplied pattern list.
pub struct BoundPatternSource {
    reader: MetadataReader,
    context: RequestContext,
}
impl BoundPatternSource {
    /// Opening creates no files or directories. The caller resolves the trusted root.
    pub fn open(root: &Path, context: &RequestContext) -> Result<Self, StoreError> {
        Ok(Self {
            reader: MetadataReader::open(root, &context.workspace_key)?,
            context: context.clone(),
        })
    }
    /// Same 100-record prompt bound as the Node assembler, after latest revision and ACL.
    /// Ambiguous JSON or unrepresentable UTF-16 cannot become prompt authority.
    pub fn read_for(
        &self,
        context: &RequestContext,
        cancel: &Cancel,
    ) -> Result<Vec<Value>, EngineError> {
        cancel.check()?;
        if context != &self.context {
            return Err(StoreError::InvalidInput.into());
        }
        let records = self
            .reader
            .read_metadata(RecordKind::Patterns, 100, context)?;
        let mut output = Vec::new();
        for record in records {
            cancel.check()?;
            if let Some(record) = super::source_record::project(&record) {
                output.push(record);
            }
        }
        self.reader
            .read_metadata(RecordKind::Patterns, 0, context)?;
        cancel.check()?;
        Ok(output)
    }
}
