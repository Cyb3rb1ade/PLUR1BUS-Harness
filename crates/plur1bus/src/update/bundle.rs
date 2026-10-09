//! `plur1bus update --from <bundle>`: an offline update bundle, a `.tar.zst` or a `.zip` holding
//!
//! ```text
//! manifest.json            the release manifest (what the feed serves as {channel}.json)
//! manifest.json.minisig    its signature
//! keys.json[.minisig]      optional: a signed key list (rotation, see guard.rs)
//! artefacts/<name>         the files the manifest's asset URLs name (matched by the last path segment)
//! ```
//!
//! The bundle is not trusted: the manifest is verified exactly as the online feed's is, every artefact by the SHA-256
//! (and size, when the manifest says) the *signed* manifest pins, through the same download path. This file only
//! unpacks, and unpacks defensively: only regular files and directories are created (a symlink, hard link, device or
//! other entry is refused), every name is a plain relative path (no `..`, no absolute path, no drive or stream
//! prefix, no backslash, no NUL), a name appears once, the entry count and the extracted size are capped, and the
//! tree is created fresh inside `<home>/update/bundle/`, so nothing is ever written through a link.
use super::state;
use super::UpdateError;
use crate::paths::Layout;
use std::collections::HashSet;
use std::fs;
use std::io::{self, BufReader, Read, Write};
use std::path::{Path, PathBuf};

/// The extracted total may not exceed this (binary + core payload + slack).
pub const MAX_EXTRACTED_BYTES: u64 = 2 << 30;
const MAX_ENTRIES: usize = 4096;
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
const MAX_SIG_BYTES: u64 = 16 * 1024;

/// An opened bundle.
#[derive(Debug)]
pub struct Bundle {
    pub dir: PathBuf,
    pub manifest: Vec<u8>,
    pub sig: String,
    /// `keys.json` and its signature, when the bundle carries a key list.
    pub keys: Option<(Vec<u8>, String)>,
}

fn err(reason: &'static str, message: impl Into<String>) -> UpdateError {
    UpdateError::new(reason, message)
}

/// `<home>/update/bundle`.
pub fn dir(layout: &Layout) -> PathBuf {
    state::dir(layout).join("bundle")
}

/// Removes the extracted bundle.
pub fn cleanup(layout: &Layout) {
    state::remove_dir(&dir(layout));
}

enum Kind {
    TarZst,
    Zip,
}

fn sniff(path: &Path) -> Result<Kind, UpdateError> {
    let mut f = fs::File::open(path)
        .map_err(|e| err("bundle-unreadable", format!("{}: {e}", path.display())))?;
    let mut magic = [0u8; 4];
    let mut got = 0;
    while got < 4 {
        match f.read(&mut magic[got..]) {
            Ok(0) => break,
            Ok(n) => got += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(err("bundle-unreadable", format!("{}: {e}", path.display()))),
        }
    }
    match &magic[..got] {
        [0x28, 0xb5, 0x2f, 0xfd] => Ok(Kind::TarZst),
        [b'P', b'K', 3, 4] | [b'P', b'K', 5, 6] => Ok(Kind::Zip),
        _ => Err(err(
            "archive-unsupported",
            format!("{} is neither a .tar.zst nor a .zip", path.display()),
        )),
    }
}

/// The normal components of an entry name, or a refusal.
fn components(raw: &[u8]) -> Result<Vec<String>, UpdateError> {
    let shown = String::from_utf8_lossy(raw).into_owned();
    let bad = |why: &str| Err(err("archive-unsafe-entry", format!("{shown:?}: {why}")));
    let Ok(name) = std::str::from_utf8(raw) else {
        return bad("not UTF-8");
    };
    if name.contains('\0') || name.contains('\\') {
        return bad("NUL or backslash");
    }
    if name.starts_with('/') {
        return bad("absolute path");
    }
    let mut out = Vec::new();
    for c in name.split('/') {
        match c {
            "" | "." => {}
            ".." => return bad("`..` component"),
            c if c.contains(':') => return bad("drive or stream prefix"),
            c => out.push(c.to_string()),
        }
    }
    if out.is_empty() {
        return bad("empty name");
    }
    Ok(out)
}

struct Sink {
    root: PathBuf,
    total: u64,
    entries: usize,
    names: HashSet<Vec<String>>,
}

impl Sink {
    fn path(&self, comps: &[String]) -> PathBuf {
        let mut p = self.root.clone();
        p.extend(comps);
        p
    }

    fn count(&mut self, comps: &[String]) -> Result<(), UpdateError> {
        self.entries += 1;
        if self.entries > MAX_ENTRIES {
            return Err(err(
                "archive-unsafe-entry",
                format!("more than {MAX_ENTRIES} entries"),
            ));
        }
        if !self.names.insert(comps.to_vec()) {
            return Err(err(
                "archive-unsafe-entry",
                format!("{:?} appears twice", comps.join("/")),
            ));
        }
        Ok(())
    }

    fn dir(&mut self, raw: &[u8]) -> Result<(), UpdateError> {
        let comps = components(raw)?;
        // A directory entry may repeat a directory a file's parent already created; it never clobbers a file.
        let p = self.path(&comps);
        fs::create_dir_all(&p).map_err(|e| err("io", format!("{}: {e}", p.display())))
    }

    fn file(&mut self, raw: &[u8], data: &mut dyn Read) -> Result<(), UpdateError> {
        let comps = components(raw)?;
        self.count(&comps)?;
        let p = self.path(&comps);
        let io_err = |e: io::Error| err("io", format!("{}: {e}", p.display()));
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).map_err(io_err)?;
        }
        // `create_new` refuses an existing file, directory or link.
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&p)
            .map_err(io_err)?;
        let budget = MAX_EXTRACTED_BYTES - self.total;
        let mut limited = data.take(budget + 1);
        let n = io::copy(&mut limited, &mut f).map_err(io_err)?;
        if n > budget {
            return Err(err(
                "download-too-large",
                format!("the bundle extracts to more than {MAX_EXTRACTED_BYTES} bytes"),
            ));
        }
        self.total += n;
        f.flush().map_err(io_err)
    }
}

fn unpack_tar<R: Read>(reader: R, sink: &mut Sink) -> Result<(), UpdateError> {
    let mut ar = tar::Archive::new(reader);
    let entries = ar
        .entries()
        .map_err(|e| err("archive-unsupported", format!("not a readable tar: {e}")))?;
    for entry in entries {
        let mut entry =
            entry.map_err(|e| err("archive-unsupported", format!("corrupt tar: {e}")))?;
        let raw = entry.path_bytes().into_owned();
        let kind = entry.header().entry_type();
        match kind {
            t if t.is_file() => sink.file(&raw, &mut entry)?,
            t if t.is_dir() => sink.dir(&raw)?,
            other => {
                return Err(err(
                    "archive-unsafe-entry",
                    format!(
                        "{:?}: a {other:?} entry (only files and directories are allowed)",
                        String::from_utf8_lossy(&raw)
                    ),
                ))
            }
        }
    }
    Ok(())
}

fn unpack_zip(path: &Path, sink: &mut Sink) -> Result<(), UpdateError> {
    let f = fs::File::open(path)
        .map_err(|e| err("bundle-unreadable", format!("{}: {e}", path.display())))?;
    let mut zip = zip::ZipArchive::new(BufReader::new(f))
        .map_err(|e| err("archive-unsupported", format!("not a readable zip: {e}")))?;
    for i in 0..zip.len() {
        let mut file = zip
            .by_index(i)
            .map_err(|e| err("archive-unsupported", format!("corrupt zip entry {i}: {e}")))?;
        let raw = file.name_raw().to_vec();
        if file.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000) {
            return Err(err(
                "archive-unsafe-entry",
                format!("{:?}: a symlink", String::from_utf8_lossy(&raw)),
            ));
        }
        if file.is_dir() {
            sink.dir(&raw)?;
        } else {
            sink.file(&raw, &mut file)?;
        }
    }
    Ok(())
}

fn read_capped(p: &Path, max: u64) -> Result<Vec<u8>, UpdateError> {
    let f =
        fs::File::open(p).map_err(|e| err("bundle-invalid", format!("{}: {e}", p.display())))?;
    let mut buf = Vec::new();
    f.take(max + 1)
        .read_to_end(&mut buf)
        .map_err(|e| err("io", format!("{}: {e}", p.display())))?;
    if buf.len() as u64 > max {
        return Err(err(
            "bundle-invalid",
            format!("{} is larger than {max} bytes", p.display()),
        ));
    }
    Ok(buf)
}

/// Unpacks `archive` into `<home>/update/bundle/` (replacing a previous one) and reads its manifest and signatures.
pub fn open(layout: &Layout, archive: &Path) -> Result<Bundle, UpdateError> {
    let kind = sniff(archive)?;
    let into = dir(layout);
    cleanup(layout);
    fs::create_dir_all(&into).map_err(|e| err("io", format!("{}: {e}", into.display())))?;
    let mut sink = Sink {
        root: into.clone(),
        total: 0,
        entries: 0,
        names: HashSet::new(),
    };
    let result = match kind {
        Kind::TarZst => {
            let f = fs::File::open(archive)
                .map_err(|e| err("bundle-unreadable", format!("{}: {e}", archive.display())))?;
            ruzstd::decoding::StreamingDecoder::new(BufReader::new(f))
                .map_err(|e| {
                    err(
                        "archive-unsupported",
                        format!("not a readable zstd stream: {e}"),
                    )
                })
                .and_then(|dec| unpack_tar(dec, &mut sink))
        }
        Kind::Zip => unpack_zip(archive, &mut sink),
    };
    if let Err(e) = result {
        cleanup(layout);
        return Err(e);
    }
    let read = |name: &str, max: u64| read_capped(&into.join(name), max);
    let loaded = (|| {
        let manifest = read("manifest.json", MAX_MANIFEST_BYTES)
            .map_err(|_| err("bundle-invalid", "the bundle has no manifest.json"))?;
        let sig = read("manifest.json.minisig", MAX_SIG_BYTES)
            .map_err(|_| err("bundle-invalid", "the bundle has no manifest.json.minisig"))?;
        let sig = String::from_utf8(sig)
            .map_err(|_| err("release-signature-invalid", "the signature is not UTF-8"))?;
        let keys = match (
            read("keys.json", super::guard::MAX_KEY_LIST_BYTES),
            read("keys.json.minisig", MAX_SIG_BYTES),
        ) {
            (Ok(k), Ok(s)) => Some((k, String::from_utf8_lossy(&s).into_owned())),
            _ => None,
        };
        Ok::<_, UpdateError>(Bundle {
            dir: into.clone(),
            manifest,
            sig,
            keys,
        })
    })();
    if loaded.is_err() {
        cleanup(layout);
    }
    loaded
}

/// The extracted file the asset URL `url` names: `artefacts/<last segment>`, else `<last segment>` at the root.
pub fn artefact(dir: &Path, url: &str) -> Option<PathBuf> {
    let last = url.split(['?', '#']).next()?.rsplit(['/', '\\']).next()?;
    if last.is_empty() || last == "." || last == ".." {
        return None;
    }
    [dir.join("artefacts").join(last), dir.join(last)]
        .into_iter()
        .find(|p| fs::symlink_metadata(p).is_ok_and(|m| m.is_file()))
}

#[cfg(test)]
pub(crate) mod testkit {
    //! Builders for bundles in tests (also used by plan/apply tests).
    use std::io::Write;

    pub fn tar_zst(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut b = tar::Builder::new(Vec::new());
        for (name, data) in files {
            let mut h = tar::Header::new_gnu();
            h.set_size(data.len() as u64);
            h.set_mode(0o644);
            h.set_entry_type(tar::EntryType::Regular);
            // Written raw: `set_path` would refuse `..` and absolute names, which these tests need.
            let old = h.as_old_mut();
            old.name = [0u8; 100];
            old.name[..name.len()].copy_from_slice(name.as_bytes());
            h.set_cksum();
            b.append(&h, *data).unwrap();
        }
        let tar = b.into_inner().unwrap();
        ruzstd::encoding::compress_to_vec(&tar[..], ruzstd::encoding::CompressionLevel::Fastest)
    }

    pub fn zip(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        for (name, data) in files {
            w.start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            w.write_all(data).unwrap();
        }
        w.finish().unwrap().into_inner()
    }
}

#[cfg(test)]
mod tests {
    use super::testkit::*;
    use super::*;

    fn layout() -> (tempfile::TempDir, Layout) {
        let d = tempfile::tempdir().unwrap();
        let l = Layout::new(d.path().join("h"));
        (d, l)
    }

    fn write(d: &tempfile::TempDir, name: &str, bytes: &[u8]) -> PathBuf {
        let p = d.path().join(name);
        fs::write(&p, bytes).unwrap();
        p
    }

    const FILES: [(&str, &[u8]); 4] = [
        ("manifest.json", b"{\"version\":\"0.2.0\"}"),
        ("manifest.json.minisig", b"sig"),
        ("artefacts/plur1bus-linux-x64", b"binary"),
        ("keys.json", b"{}"),
    ];

    #[test]
    fn a_tar_zst_and_a_zip_open_the_same_way() {
        for (name, bytes) in [("b.tar.zst", tar_zst(&FILES)), ("b.zip", zip(&FILES))] {
            let (d, l) = layout();
            let b = open(&l, &write(&d, name, &bytes)).unwrap();
            assert_eq!(b.manifest, b"{\"version\":\"0.2.0\"}", "{name}");
            assert_eq!(b.sig, "sig");
            assert!(
                b.keys.is_none(),
                "keys.json without its signature is ignored"
            );
            let a = artefact(&b.dir, "https://x.invalid/dl/v0.2.0/plur1bus-linux-x64?x=1").unwrap();
            assert_eq!(fs::read(a).unwrap(), b"binary");
            assert!(artefact(&b.dir, "https://x.invalid/other").is_none());
            cleanup(&l);
            assert!(!dir(&l).exists());
        }
    }

    #[test]
    fn a_key_list_with_its_signature_is_returned() {
        let (d, l) = layout();
        let mut files = FILES.to_vec();
        files.push(("keys.json.minisig", b"ksig"));
        let b = open(&l, &write(&d, "b.zip", &zip(&files))).unwrap();
        assert_eq!(b.keys, Some((b"{}".to_vec(), "ksig".to_string())));
    }

    #[test]
    fn traversal_absolute_and_odd_names_are_refused_and_leave_nothing() {
        for bad in [
            "../evil",
            "a/../../evil",
            "/etc/evil",
            "C:/evil",
            "a:stream",
            "a\\b",
        ] {
            for (kind, bytes) in [
                ("tar.zst", tar_zst(&[("manifest.json", b"{}"), (bad, b"x")])),
                ("zip", zip(&[("manifest.json", b"{}"), (bad, b"x")])),
            ] {
                let (d, l) = layout();
                let e = open(&l, &write(&d, &format!("b.{kind}"), &bytes)).unwrap_err();
                assert_eq!(
                    e.reason, "archive-unsafe-entry",
                    "{kind} {bad:?}: {}",
                    e.message
                );
                assert!(!dir(&l).exists(), "{kind} {bad:?} left a tree");
                assert!(
                    !d.path().join("evil").exists() && !d.path().join("h").join("evil").exists()
                );
            }
        }
    }

    #[test]
    fn links_and_duplicate_names_are_refused() {
        let (d, l) = layout();
        let mut b = tar::Builder::new(Vec::new());
        let mut h = tar::Header::new_gnu();
        h.set_entry_type(tar::EntryType::Symlink);
        h.set_size(0);
        h.set_path("manifest.json").unwrap();
        h.set_link_name("/etc/passwd").unwrap();
        h.set_cksum();
        b.append(&h, &b""[..]).unwrap();
        let zst = ruzstd::encoding::compress_to_vec(
            &b.into_inner().unwrap()[..],
            ruzstd::encoding::CompressionLevel::Fastest,
        );
        let e = open(&l, &write(&d, "l.tar.zst", &zst)).unwrap_err();
        assert_eq!(e.reason, "archive-unsafe-entry", "{}", e.message);

        let e = open(
            &l,
            &write(
                &d,
                "dup.tar.zst",
                &tar_zst(&[("manifest.json", b"1"), ("./manifest.json", b"2")]),
            ),
        )
        .unwrap_err();
        assert_eq!(e.reason, "archive-unsafe-entry", "{}", e.message);
    }

    #[test]
    fn a_zip_symlink_is_refused() {
        let (d, l) = layout();
        let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        w.add_symlink(
            "manifest.json",
            "/etc/passwd",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
        let bytes = w.finish().unwrap().into_inner();
        let e = open(&l, &write(&d, "s.zip", &bytes)).unwrap_err();
        assert_eq!(e.reason, "archive-unsafe-entry", "{}", e.message);
    }

    #[test]
    fn a_missing_manifest_or_signature_and_unknown_formats_are_refused() {
        let (d, l) = layout();
        let e = open(&l, &write(&d, "a.zip", &zip(&[("manifest.json", b"{}")]))).unwrap_err();
        assert_eq!(e.reason, "bundle-invalid");
        assert!(!dir(&l).exists());
        let e = open(&l, &write(&d, "a.zip2", &zip(&[("x", b"{}")]))).unwrap_err();
        assert_eq!(e.reason, "bundle-invalid");
        let e = open(&l, &write(&d, "junk", b"not an archive")).unwrap_err();
        assert_eq!(e.reason, "archive-unsupported");
        let e = open(&l, &d.path().join("missing")).unwrap_err();
        assert_eq!(e.reason, "bundle-unreadable");
    }

    #[test]
    fn a_previous_extraction_is_replaced() {
        let (d, l) = layout();
        open(&l, &write(&d, "a.zip", &zip(&FILES))).unwrap();
        fs::write(dir(&l).join("stale"), "x").unwrap();
        open(&l, &write(&d, "b.zip", &zip(&FILES))).unwrap();
        assert!(!dir(&l).join("stale").exists());
    }
}
