//! Hold the physical source and exact byte digest across caller authorization and publication.
use super::{journal_io, merged::optional};
use crate::{
    contract::{Cancel, EngineError, StoreError},
    store::directory::{regular_file_identity, TrustedDirectory},
};
use sha2::{Digest, Sha256};
use std::{fs::File, time::SystemTime};

pub(super) struct SourceProof {
    file: File,
    pub identity: (u64, u64),
    pub modified: SystemTime,
    digest: [u8; 32],
}
impl SourceProof {
    /// Returns bytes for the caller's ACL checks; reading is not itself authorization.
    pub(super) fn read(
        dir: &TrustedDirectory,
        name: &str,
        cancel: &Cancel,
    ) -> Result<Option<(Self, Vec<u8>)>, EngineError> {
        let Some(file) = optional(dir.open_file(name))? else {
            return Ok(None);
        };
        let identity = regular_file_identity(&file)?;
        let modified = file
            .metadata()
            .map_err(StoreError::from)?
            .modified()
            .map_err(StoreError::from)?;
        let bytes = journal_io::bytes(dir, name, cancel)?.ok_or(StoreError::UntrustedPath)?;
        let proof = Self {
            file,
            identity,
            modified,
            digest: Sha256::digest(&bytes).into(),
        };
        proof.verify(dir, name, &bytes)?;
        Ok(Some((proof, bytes)))
    }
    pub(super) fn verify(
        &self,
        dir: &TrustedDirectory,
        name: &str,
        bytes: &[u8],
    ) -> Result<(), EngineError> {
        if regular_file_identity(&dir.open_file(name)?)? != self.identity
            || regular_file_identity(&self.file)? != self.identity
            || self
                .file
                .metadata()
                .map_err(StoreError::from)?
                .modified()
                .map_err(StoreError::from)?
                != self.modified
            || <[u8; 32]>::from(Sha256::digest(bytes)) != self.digest
        {
            return Err(StoreError::UntrustedPath.into());
        }
        dir.assert_unchanged()?;
        Ok(())
    }
}
