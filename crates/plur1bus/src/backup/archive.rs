//! Reading and writing the `plur1bus.backup/1` archive: a `tar.gz` with `manifest.json` first and `data/<path>` after.
//!
//! RULING R3: the SHA-256 per file detects corruption and truncation, it does not authenticate the archive (it is not
//! signed). [`visit`] is the one reader: `backup verify`, the post-create check and `restore` all go through it, so a
//! file is only ever handed to a consumer after its entry was matched against the manifest, and is checked against its
//! digest and size before [`visit`] returns.
use super::manifest::{FileEntry, Manifest, DATA_PREFIX, MANIFEST_NAME, MAX_MANIFEST_BYTES};
use super::BackupError;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

fn classify(e: io::Error) -> BackupError {
    match e.kind() {
        io::ErrorKind::UnexpectedEof => BackupError::new("truncated", "the archive ends early"),
        _ => BackupError::new("archive-corrupt", e.to_string()),
    }
}

/// `sha256` (lower hex) and size of a file on disk.
pub fn hash_file(path: &Path) -> io::Result<(String, u64)> {
    let mut f = fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    let mut n = 0u64;
    loop {
        let k = f.read(&mut buf)?;
        if k == 0 {
            break;
        }
        h.update(&buf[..k]);
        n += k as u64;
    }
    Ok((hex(&h.finalize()), n))
}

pub fn hex(b: &[u8]) -> String {
    use std::fmt::Write as _;
    b.iter().fold(String::with_capacity(b.len() * 2), |mut s, x| {
        let _ = write!(s, "{x:02x}");
        s
    })
}

/// Writes the archive to `out` (created private, `<out>.partial` until complete). `sources` maps an archive path to the file
/// it is read from; each must match its manifest entry (size and digest), else the write is refused and nothing is left.
pub fn write_archive(
    out: &Path,
    manifest: &Manifest,
    sources: &HashMap<String, PathBuf>,
) -> Result<(), BackupError> {
    if out.exists() {
        return Err(BackupError::new(
            "exists",
            format!("{} already exists; refusing to overwrite it", out.display()),
        ));
    }
    let mut partial = out.as_os_str().to_owned();
    partial.push(".partial");
    let partial = PathBuf::from(partial);
    let result = write_inner(&partial, manifest, sources);
    match result {
        Ok(()) => fs::rename(&partial, out).map_err(|e| {
            let _ = fs::remove_file(&partial);
            BackupError::from(e)
        }),
        Err(e) => {
            let _ = fs::remove_file(&partial);
            Err(e)
        }
    }
}

fn write_inner(
    partial: &Path,
    manifest: &Manifest,
    sources: &HashMap<String, PathBuf>,
) -> Result<(), BackupError> {
    let file = crate::audit::create_private(partial, true)?;
    let mut tar = tar::Builder::new(GzEncoder::new(io::BufWriter::new(file), Compression::default()));
    let json = serde_json::to_vec_pretty(manifest).map_err(|e| BackupError::new("io", e.to_string()))?;
    append(&mut tar, MANIFEST_NAME, json.len() as u64, &mut json.as_slice())?;
    for f in &manifest.files {
        let src = sources
            .get(&f.path)
            .ok_or_else(|| BackupError::new("missing-entry", format!("no source for {}", f.path)))?;
        let mut r = HashingReader::new(fs::File::open(src)?);
        append(&mut tar, &format!("{DATA_PREFIX}{}", f.path), f.bytes, &mut r)?;
        r.check(f)?;
    }
    let enc = tar.into_inner()?;
    let mut w = enc.finish()?;
    w.flush()?;
    w.into_inner()
        .map_err(|e| BackupError::from(e.into_error()))?
        .sync_all()?;
    Ok(())
}

fn append<W: Write>(
    tar: &mut tar::Builder<W>,
    path: &str,
    size: u64,
    data: &mut dyn Read,
) -> Result<(), BackupError> {
    let mut h = tar::Header::new_gnu();
    h.set_size(size);
    h.set_mode(0o600);
    h.set_mtime(0);
    h.set_entry_type(tar::EntryType::Regular);
    // `take` keeps a file that grew after it was hashed from overrunning its header; `check` then reports the mismatch.
    tar.append_data(&mut h, path, data.take(size))
        .map_err(BackupError::from)
}

/// Counts and hashes what passes through it.
struct HashingReader<R> {
    inner: R,
    hash: Sha256,
    count: u64,
}

impl<R: Read> HashingReader<R> {
    fn new(inner: R) -> Self {
        HashingReader { inner, hash: Sha256::new(), count: 0 }
    }
    fn check(self, f: &FileEntry) -> Result<(), BackupError> {
        if self.count != f.bytes || hex(&self.hash.finalize()) != f.sha256 {
            return Err(BackupError::new(
                "source-busy",
                format!("{} changed while it was being archived", f.path),
            ));
        }
        Ok(())
    }
}

impl<R: Read> Read for HashingReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.hash.update(&buf[..n]);
        self.count += n as u64;
        Ok(n)
    }
}

/// Reads the whole archive once. `sink` receives each file entry (manifest entry and its bytes) in archive order; whatever
/// it does not consume is drained. Returns the validated manifest. Refusals, with their `reason`: `archive-corrupt`,
/// `truncated`, `manifest-invalid`, `unsupported-format`, `unexpected-entry` (an entry the manifest does not list, a
/// duplicate, a non-regular file, an unsafe path), `checksum-mismatch` (size or SHA-256), `missing-entry`.
pub fn visit(
    path: &Path,
    sink: &mut dyn FnMut(&FileEntry, &mut dyn Read) -> Result<(), BackupError>,
) -> Result<Manifest, BackupError> {
    let file = fs::File::open(path)?;
    let mut archive = tar::Archive::new(GzDecoder::new(io::BufReader::new(file)));
    let manifest;
    {
        let mut entries = archive.entries().map_err(classify)?;
        let mut first = entries
            .next()
            .ok_or_else(|| BackupError::new("archive-corrupt", "the archive is empty"))?
            .map_err(classify)?;
        let name = first.path().map_err(classify)?.to_string_lossy().into_owned();
        if name != MANIFEST_NAME || !first.header().entry_type().is_file() {
            return Err(BackupError::new(
                "manifest-invalid",
                format!("the first entry must be {MANIFEST_NAME}, found {name:?}"),
            ));
        }
        if first.size() > MAX_MANIFEST_BYTES {
            return Err(BackupError::new("manifest-invalid", "the manifest is too large"));
        }
        let mut raw = Vec::new();
        first.read_to_end(&mut raw).map_err(classify)?;
        manifest = serde_json::from_slice::<Manifest>(&raw)
            .map_err(|e| BackupError::new("manifest-invalid", e.to_string()))?;
        manifest.validate()?;
        drop(first);

        let wanted: HashMap<&str, &FileEntry> = manifest.files.iter().map(|f| (f.path.as_str(), f)).collect();
        let mut seen = HashSet::new();
        for entry in entries {
            let mut entry = entry.map_err(classify)?;
            let epath = entry.path().map_err(classify)?.to_string_lossy().into_owned();
            let rel = epath.strip_prefix(DATA_PREFIX).unwrap_or("");
            let Some(f) = wanted.get(rel) else {
                return Err(BackupError::new("unexpected-entry", format!("{epath:?} is not in the manifest")));
            };
            if !entry.header().entry_type().is_file() {
                return Err(BackupError::new("unexpected-entry", format!("{epath:?} is not a regular file")));
            }
            if !seen.insert(rel.to_string()) {
                return Err(BackupError::new("unexpected-entry", format!("{epath:?} appears twice")));
            }
            if entry.size() != f.bytes {
                return Err(BackupError::new(
                    "checksum-mismatch",
                    format!("{rel}: {} bytes in the archive, {} in the manifest", entry.size(), f.bytes),
                ));
            }
            let mut r = HashingReader::new((&mut entry).take(f.bytes));
            sink(f, &mut r)?;
            io::copy(&mut r, &mut io::sink()).map_err(classify)?;
            if r.count != f.bytes {
                return Err(BackupError::new("truncated", format!("{rel} ends early")));
            }
            if hex(&r.hash.finalize()) != f.sha256 {
                return Err(BackupError::new("checksum-mismatch", format!("{rel}: SHA-256 differs from the manifest")));
            }
        }
        if let Some(missing) = manifest.files.iter().find(|f| !seen.contains(&f.path)) {
            return Err(BackupError::new("missing-entry", format!("{} is in the manifest but not in the archive", missing.path)));
        }
    }
    // The gzip trailer (CRC and length) is only read at end of stream.
    let mut rest = archive.into_inner();
    io::copy(&mut rest, &mut io::sink()).map_err(classify)?;
    Ok(manifest)
}

/// `backup verify`: [`visit`] with nothing consumed.
pub fn verify(path: &Path) -> Result<Manifest, BackupError> {
    visit(path, &mut |_, _| Ok(()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::manifest::*;

    /// A tiny archive: config.json and store/a, built by hand through the real writer.
    fn fixture(dir: &Path) -> (PathBuf, Manifest) {
        let cfg = dir.join("cfg-src");
        let a = dir.join("a-src");
        fs::write(&cfg, b"{\"x\":1}").unwrap();
        fs::write(&a, b"store bytes").unwrap();
        let entry = |p: &str, src: &Path| {
            let (sha256, bytes) = hash_file(src).unwrap();
            FileEntry { path: p.into(), bytes, sha256, mode: Some(0o600) }
        };
        let m = Manifest {
            schema: SCHEMA.into(),
            created_at_ms: 5,
            harness: Harness { version: "0.1.0".into() },
            platform: Platform { os: "linux".into(), arch: "x86_64".into() },
            engine: Engine { contract: "1.12.0".into(), store_schema: None },
            store_target: "state/lancedb".into(),
            units: vec![
                Unit { archive: "store".into(), target: "state/lancedb".into(), kind: Kind::Dir },
                Unit { archive: "config.json".into(), target: "config.json".into(), kind: Kind::File },
            ],
            absent: vec![],
            dirs: vec![],
            files: vec![entry("store/a", &a), entry("config.json", &cfg)],
            skipped: vec![],
            secrets: Secrets { included: false, note: SECRETS_NOTE.into() },
        };
        let sources = HashMap::from([("store/a".to_string(), a), ("config.json".to_string(), cfg)]);
        let out = dir.join("b.tar.gz");
        write_archive(&out, &m, &sources).unwrap();
        (out, m)
    }

    /// Rewrites `archive` through `f`, which gets every (name, bytes) and may change, drop or add entries.
    fn rewrite(archive: &Path, f: impl FnOnce(&mut Vec<(String, Vec<u8>)>)) {
        let mut ents = Vec::new();
        let mut a = tar::Archive::new(GzDecoder::new(fs::File::open(archive).unwrap()));
        for e in a.entries().unwrap() {
            let mut e = e.unwrap();
            let mut b = Vec::new();
            e.read_to_end(&mut b).unwrap();
            ents.push((e.path().unwrap().to_string_lossy().into_owned(), b));
        }
        f(&mut ents);
        let mut t = tar::Builder::new(GzEncoder::new(fs::File::create(archive).unwrap(), Compression::default()));
        for (n, b) in ents {
            // Raw header name: the tar crate refuses `..` in `set_path`, and a hostile archive would not use it.
            let mut h = tar::Header::new_gnu();
            h.as_gnu_mut().unwrap().name[..n.len()].copy_from_slice(n.as_bytes());
            h.set_size(b.len() as u64);
            h.set_mode(0o600);
            h.set_entry_type(tar::EntryType::Regular);
            h.set_cksum();
            t.append(&h, b.as_slice()).unwrap();
        }
        t.into_inner().unwrap().finish().unwrap();
    }

    #[test]
    fn a_good_archive_verifies_and_yields_its_files_in_order() {
        let d = tempfile::tempdir().unwrap();
        let (a, m) = fixture(d.path());
        let mut got = Vec::new();
        let read = visit(&a, &mut |f, r| {
            let mut b = Vec::new();
            r.read_to_end(&mut b).unwrap();
            got.push((f.path.clone(), b));
            Ok(())
        })
        .unwrap();
        assert_eq!(read, m);
        assert_eq!(got, vec![("store/a".to_string(), b"store bytes".to_vec()), ("config.json".to_string(), b"{\"x\":1}".to_vec())]);
    }

    #[cfg(unix)]
    #[test]
    fn the_archive_is_created_private() {
        use std::os::unix::fs::PermissionsExt;
        let d = tempfile::tempdir().unwrap();
        let (a, _) = fixture(d.path());
        assert_eq!(fs::metadata(&a).unwrap().permissions().mode() & 0o777, 0o600);
    }

    #[test]
    fn a_flipped_data_byte_is_a_checksum_mismatch() {
        let d = tempfile::tempdir().unwrap();
        let (a, _) = fixture(d.path());
        rewrite(&a, |e| e[1].1[0] ^= 1);
        assert_eq!(verify(&a).unwrap_err().reason, "checksum-mismatch");
    }

    #[test]
    fn a_changed_size_is_a_checksum_mismatch() {
        let d = tempfile::tempdir().unwrap();
        let (a, _) = fixture(d.path());
        rewrite(&a, |e| e[1].1.push(b'!'));
        assert_eq!(verify(&a).unwrap_err().reason, "checksum-mismatch");
    }

    #[test]
    fn an_extra_or_unsafe_entry_is_refused() {
        for name in ["data/extra", "data/../../etc/x", "data//abs", "elsewhere"] {
            let d = tempfile::tempdir().unwrap();
            let (a, _) = fixture(d.path());
            rewrite(&a, |e| e.push((name.into(), b"x".to_vec())));
            let err = verify(&a).unwrap_err();
            assert_eq!(err.reason, "unexpected-entry", "{name}: {err}");
        }
    }

    #[test]
    fn a_missing_entry_and_a_duplicate_are_refused() {
        let d = tempfile::tempdir().unwrap();
        let (a, _) = fixture(d.path());
        rewrite(&a, |e| {
            e.pop();
        });
        assert_eq!(verify(&a).unwrap_err().reason, "missing-entry");
        let (a, _) = fixture(&tempfile::tempdir().unwrap().keep());
        rewrite(&a, |e| {
            let dup = e[1].clone();
            e.push(dup);
        });
        assert_eq!(verify(&a).unwrap_err().reason, "unexpected-entry");
    }

    #[test]
    fn a_tampered_manifest_is_refused() {
        let d = tempfile::tempdir().unwrap();
        let (a, _) = fixture(d.path());
        rewrite(&a, |e| {
            let s = String::from_utf8(e[0].1.clone()).unwrap().replace("\"config.json\"", "\"run/core.token\"");
            e[0].1 = s.into_bytes();
        });
        assert_eq!(verify(&a).unwrap_err().reason, "manifest-invalid");
        let (a, _) = fixture(&tempfile::tempdir().unwrap().keep());
        rewrite(&a, |e| e[0].1 = b"not json".to_vec());
        assert_eq!(verify(&a).unwrap_err().reason, "manifest-invalid");
        let (a, _) = fixture(&tempfile::tempdir().unwrap().keep());
        rewrite(&a, |e| e.swap(0, 1));
        assert_eq!(verify(&a).unwrap_err().reason, "manifest-invalid");
    }

    #[test]
    fn truncation_and_garbage_are_refused_at_every_cut() {
        let d = tempfile::tempdir().unwrap();
        let (a, _) = fixture(d.path());
        let full = fs::read(&a).unwrap();
        for cut in [0, 1, 10, full.len() / 2, full.len() - 1] {
            fs::write(&a, &full[..cut]).unwrap();
            let r = verify(&a).unwrap_err().reason;
            assert!(["truncated", "archive-corrupt"].contains(&r), "cut {cut}: {r}");
        }
        fs::write(&a, b"definitely not a gzip file").unwrap();
        assert_eq!(verify(&a).unwrap_err().reason, "archive-corrupt");
        // A flipped byte of the compressed stream is caught somewhere (CRC, tar framing or digest), except the gzip
        // header's mtime/xfl/os bytes (4..10), which carry no content.
        for i in (0..full.len()).step_by(7).filter(|i| !(4..10).contains(i)) {
            let mut b = full.clone();
            b[i] ^= 0x55;
            fs::write(&a, &b).unwrap();
            assert!(verify(&a).is_err(), "flip at {i} went unnoticed");
        }
    }

    #[test]
    fn a_source_that_changed_is_refused_and_leaves_no_file() {
        let d = tempfile::tempdir().unwrap();
        let (_, m) = fixture(d.path());
        fs::write(d.path().join("a-src"), b"CHANGED bytes").unwrap();
        let sources = HashMap::from([
            ("store/a".to_string(), d.path().join("a-src")),
            ("config.json".to_string(), d.path().join("cfg-src")),
        ]);
        let out = d.path().join("c.tar.gz");
        let err = write_archive(&out, &m, &sources).unwrap_err();
        assert_eq!(err.reason, "source-busy");
        assert!(!out.exists() && !d.path().join("c.tar.gz.partial").exists());
    }

    #[test]
    fn an_existing_output_is_never_overwritten() {
        let d = tempfile::tempdir().unwrap();
        let (a, m) = fixture(d.path());
        let sources = HashMap::new();
        assert_eq!(write_archive(&a, &m, &sources).unwrap_err().reason, "exists");
    }
}
