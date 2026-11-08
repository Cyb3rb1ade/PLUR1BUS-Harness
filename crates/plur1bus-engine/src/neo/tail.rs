//! Bounded backward byte reads, decoded only after complete LF segments are assembled.
use crate::{contract::StoreError, store::directory::TrustedDirectory};
use std::io::{Read, Seek, SeekFrom};
pub(super) const MAX_LINES: usize = 50_000;
const MAX_BYTES: usize = 64 * 1024 * 1024;
const CHUNK: usize = 64 * 1024;
pub(super) fn read(
    dir: Option<&TrustedDirectory>,
    name: &str,
    limit: usize,
) -> Result<Vec<String>, StoreError> {
    let Some(dir) = dir else {
        return Ok(Vec::new());
    };
    let Some(mut file) = super::merged::optional(dir.open_file(name))? else {
        return Ok(Vec::new());
    };
    let metadata = file.metadata()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.nlink() != 1 {
            return Err(StoreError::UntrustedPath);
        }
    }
    let mut pos = metadata.len();
    let mut chunks = Vec::new();
    let mut count = 0;
    let mut nonempty = false;
    let mut total = 0;
    while pos > 0 && count < limit {
        let size = pos.min(CHUNK as u64) as usize;
        total += size;
        if total > MAX_BYTES {
            return Err(StoreError::InvalidInput);
        }
        pos -= size as u64;
        file.seek(SeekFrom::Start(pos))?;
        let mut chunk = vec![0; size];
        file.read_exact(&mut chunk)?;
        for byte in chunk.iter().rev() {
            if *byte == b'\n' {
                if nonempty {
                    count += 1;
                }
                nonempty = false;
            } else {
                nonempty = true;
            }
        }
        chunks.push(chunk);
    }
    // Appends cannot alter the already read suffix; replacement, truncation and in-place
    // edits are not a coherent revision window and must be retried by the caller.
    let after = file.metadata()?;
    if after.len() != metadata.len() || after.modified()? != metadata.modified()? {
        return Err(StoreError::Busy);
    }
    dir.assert_unchanged()?;
    let bytes: Vec<u8> = chunks.into_iter().rev().flatten().collect();
    let start = if pos == 0 {
        0
    } else {
        bytes
            .iter()
            .position(|b| *b == b'\n')
            .map_or(bytes.len(), |i| i + 1)
    };
    let text = String::from_utf8_lossy(&bytes[start..]);
    let lines: Vec<_> = text.split('\n').filter(|line| !line.is_empty()).collect();
    Ok(lines[lines.len().saturating_sub(limit)..]
        .iter()
        .map(|s| (*s).to_owned())
        .collect())
}
