//! The script set of a package (spec 2026-09-27 §8.4 step 6): files with the exec bit, a shebang, or under a
//! `scripts/` or `bin/` directory, and native binaries by magic number (ELF, Mach-O, PE). `p1x.json` lists the set in
//! `scripts`, and the verifier derives it again to compare.

/// Native-binary magic numbers: ELF, Mach-O (32/64-bit, both byte orders, and the universal/fat header).
const MAGIC: &[&[u8]] = &[
    &[0x7F, b'E', b'L', b'F'],
    &[0xFE, 0xED, 0xFA, 0xCE],
    &[0xFE, 0xED, 0xFA, 0xCF],
    &[0xCE, 0xFA, 0xED, 0xFE],
    &[0xCF, 0xFA, 0xED, 0xFE],
    &[0xCA, 0xFE, 0xBA, 0xBE],
];

/// Whether the payload file at `path` (`payload/…`, `/`-separated) belongs to the script set. `exec` is the manifest
/// `exec` flag (the Unix exec bit), `head` the file's first bytes (at least 4 when the file has that many).
pub fn is_script(path: &str, exec: bool, head: &[u8]) -> bool {
    if exec || head.starts_with(b"#!") || head.starts_with(b"MZ") {
        return true;
    }
    if MAGIC.iter().any(|m| head.starts_with(m)) {
        return true;
    }
    // A directory segment `scripts` or `bin` anywhere under `payload/` (the file's own name does not count).
    let mut segments: Vec<&str> = path.split('/').collect();
    segments.pop();
    segments
        .iter()
        .skip(usize::from(segments.first() == Some(&"payload")))
        .any(|s| *s == "scripts" || *s == "bin")
}

/// File extensions the TS importer's scan counts as scripts (`SCRIPT_EXT` in `skills-scan.ts`).
pub const SCRIPT_EXT: &[&str] = &[
    "sh", "bash", "zsh", "fish", "py", "js", "mjs", "cjs", "ts", "rb", "pl", "php", "ps1", "psm1",
    "bat", "cmd", "exe", "bin",
];

/// Whether the file name has one of the [`SCRIPT_EXT`] extensions (case-insensitive; a leading dot is not an
/// extension, like Node's `extname`). This widens the capability disclosure only; `scripts` stays [`is_script`].
pub fn has_script_extension(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    match name.rfind('.') {
        Some(i) if i > 0 => SCRIPT_EXT.contains(&name[i + 1..].to_lowercase().as_str()),
        _ => false,
    }
}
