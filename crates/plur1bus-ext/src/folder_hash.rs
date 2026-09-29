//! The skill folder hash `plur1bus-skill-sha256/v1` (docs/import.md §9.2; X1-R14), ported from
//! `packages/core/src/import/skills-scan.ts` `folderHash`, which is the reference. Both are checked against one
//! vector (`tests/fixtures/skill-hash/expected.json`).
use sha2::{Digest, Sha256};

/// `"sha256:" + hex(SHA-256(Σ relpath "\0" hex "\n"))` over `(POSIX relative path, SHA-256 of the file as lower-case
/// hex)` pairs sorted by path. The order is the one JavaScript's `<` gives strings (UTF-16 code units), so a path
/// with a character above U+FFFF sorts the same in both implementations.
pub fn skill_folder_hash(files: &[(String, String)]) -> String {
    let mut sorted: Vec<&(String, String)> = files.iter().collect();
    sorted.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
    let mut h = Sha256::new();
    for (rel, hex) in sorted {
        h.update(rel.as_bytes());
        h.update([0u8]);
        h.update(hex.as_bytes());
        h.update([b'\n']);
    }
    format!("sha256:{}", crate::zipaudit::hex(&h.finalize()))
}
