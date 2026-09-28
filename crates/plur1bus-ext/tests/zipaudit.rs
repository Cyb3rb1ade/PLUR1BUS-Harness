//! The strict ZIP audit (spec 2026-09-27 §5.1, §8.4 steps 1–3; X1-R3, X1-R4, X1-R7). Archives are built here byte by
//! byte, so every field a rule looks at can be set on its own, and once with `zip::ZipWriter` for a real writer.
use flate2::{write::DeflateEncoder, Compression, Crc};
use plur1bus_ext::refusal::{reason, Refusal};
use plur1bus_ext::zipaudit::{audit_zip, hash_entry, read_entry, Audited, Limits, Method};
use sha2::{Digest, Sha256};
use std::io::{Cursor, Write};

const INVALID: &str = "E_INVALID_PARAMS";
const EOCD_LEN: usize = 22;

/// One entry of a hand-built archive. `data` is the bytes as stored (already deflated for method 8).
#[derive(Clone)]
struct Spec {
    name: Vec<u8>,
    method: u16,
    flags: u16,
    data: Vec<u8>,
    crc: u32,
    uncompressed: u32,
    /// Unix mode in the external attributes' high half (version made by = Unix); `None` = MS-DOS, attributes 0.
    mode: Option<u32>,
    /// Bit 3: sizes and CRC zero in the local header, followed by a data descriptor with this signature choice.
    descriptor: bool,
}

fn crc(data: &[u8]) -> u32 {
    let mut c = Crc::new();
    c.update(data);
    c.sum()
}

fn stored(name: &str, data: &[u8]) -> Spec {
    Spec {
        name: name.as_bytes().to_vec(),
        method: 0,
        flags: 0x0800,
        data: data.to_vec(),
        crc: crc(data),
        uncompressed: data.len() as u32,
        mode: Some(0o100644),
        descriptor: false,
    }
}

fn deflated(name: &str, data: &[u8]) -> Spec {
    let mut enc = DeflateEncoder::new(Vec::new(), Compression::best());
    enc.write_all(data).unwrap();
    Spec {
        method: 8,
        data: enc.finish().unwrap(),
        ..stored(name, data)
    }
}

fn u16le(v: &mut Vec<u8>, x: u16) {
    v.extend_from_slice(&x.to_le_bytes());
}
fn u32le(v: &mut Vec<u8>, x: u32) {
    v.extend_from_slice(&x.to_le_bytes());
}

/// Local headers, central directory and EOCD, laid out as a conforming writer would.
fn build(specs: &[Spec]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut central = Vec::new();
    for s in specs {
        let offset = out.len() as u32;
        let flags = s.flags | if s.descriptor { 0x0008 } else { 0 };
        let (lcrc, lc, lu) = if s.descriptor {
            (0, 0, 0)
        } else {
            (s.crc, s.data.len() as u32, s.uncompressed)
        };
        u32le(&mut out, 0x0403_4b50);
        u16le(&mut out, 20);
        u16le(&mut out, flags);
        u16le(&mut out, s.method);
        u16le(&mut out, 0);
        u16le(&mut out, 0x21);
        u32le(&mut out, lcrc);
        u32le(&mut out, lc);
        u32le(&mut out, lu);
        u16le(&mut out, s.name.len() as u16);
        u16le(&mut out, 0);
        out.extend_from_slice(&s.name);
        out.extend_from_slice(&s.data);
        if s.descriptor {
            u32le(&mut out, 0x0807_4b50);
            u32le(&mut out, s.crc);
            u32le(&mut out, s.data.len() as u32);
            u32le(&mut out, s.uncompressed);
        }
        let (made_by, ext) = match s.mode {
            Some(m) => ((3u16 << 8) | 20, m << 16),
            None => (20, 0),
        };
        u32le(&mut central, 0x0201_4b50);
        u16le(&mut central, made_by);
        u16le(&mut central, 20);
        u16le(&mut central, flags);
        u16le(&mut central, s.method);
        u16le(&mut central, 0);
        u16le(&mut central, 0x21);
        u32le(&mut central, s.crc);
        u32le(&mut central, s.data.len() as u32);
        u32le(&mut central, s.uncompressed);
        u16le(&mut central, s.name.len() as u16);
        u16le(&mut central, 0);
        u16le(&mut central, 0);
        u16le(&mut central, 0);
        u16le(&mut central, 0);
        u32le(&mut central, ext);
        u32le(&mut central, offset);
        central.extend_from_slice(&s.name);
    }
    let cd_offset = out.len() as u32;
    out.extend_from_slice(&central);
    u32le(&mut out, 0x0605_4b50);
    u16le(&mut out, 0);
    u16le(&mut out, 0);
    u16le(&mut out, specs.len() as u16);
    u16le(&mut out, specs.len() as u16);
    u32le(&mut out, central.len() as u32);
    u32le(&mut out, cd_offset);
    u16le(&mut out, 0);
    out
}

fn audit(bytes: &[u8]) -> Result<Audited, Refusal> {
    audit_zip(&mut Cursor::new(bytes), &Limits::default())
}

#[track_caller]
fn refused(r: Result<impl std::fmt::Debug, Refusal>, want: &str) -> Refusal {
    let e = r.expect_err("expected a refusal");
    assert_eq!((e.code, e.reason), (INVALID, want), "{e:?}");
    e
}

fn eocd_at(bytes: &[u8]) -> usize {
    bytes.len() - EOCD_LEN
}

fn patch_u16(bytes: &mut [u8], at: usize, v: u16) {
    bytes[at..at + 2].copy_from_slice(&v.to_le_bytes());
}
fn patch_u32(bytes: &mut [u8], at: usize, v: u32) {
    bytes[at..at + 4].copy_from_slice(&v.to_le_bytes());
}

fn two() -> Vec<Spec> {
    vec![
        stored("p1x.json", b"{}\n"),
        deflated("payload/SKILL.md", &b"# demo-skill\n".repeat(50)),
    ]
}

#[test]
fn accepts_a_stored_and_deflated_archive_and_lists_entries() {
    let mut specs = two();
    specs.push(Spec {
        mode: Some(0o100755),
        ..stored("payload/scripts/run.sh", b"#!/bin/sh\necho hi\n")
    });
    specs.push(Spec {
        descriptor: true,
        ..deflated("payload/notes.md", b"notes notes notes notes\n")
    });
    let bytes = build(&specs);
    let a = audit(&bytes).expect("accepted");
    let names: Vec<_> = a.entries.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(
        names,
        [
            "p1x.json",
            "payload/SKILL.md",
            "payload/scripts/run.sh",
            "payload/notes.md"
        ]
    );
    assert_eq!(a.entries[0].method, Method::Stored);
    assert_eq!(a.entries[1].method, Method::Deflate);
    assert_eq!(a.entries[1].uncompressed, 13 * 50);
    assert_eq!(a.entries[1].compressed, specs[1].data.len() as u64);
    assert_eq!(a.entries[1].crc32, specs[1].crc);
    assert!(!a.entries[0].exec);
    assert!(a.entries[2].exec);
    assert_eq!(a.entries[0].data_offset, 30 + "p1x.json".len() as u64);
    let mut cur = Cursor::new(&bytes);
    for (e, s) in a.entries.iter().zip(&specs) {
        let d = hash_entry(&mut cur, e).expect("hash");
        assert_eq!(d.size, s.uncompressed as u64);
        let plain = read_entry(&mut cur, e, 1 << 20).expect("read");
        assert_eq!(d.sha256, hex(&Sha256::digest(&plain)));
    }

    // A real writer's output passes too.
    let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let st = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored)
        .unix_permissions(0o644);
    let df = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o755);
    w.start_file("p1x.json", st).unwrap();
    w.write_all(b"{}\n").unwrap();
    w.start_file("payload/bin/tool", df).unwrap();
    w.write_all(&b"\x7fELF".repeat(100)).unwrap();
    let bytes = w.finish().unwrap().into_inner();
    let a = audit(&bytes).expect("zip::ZipWriter output accepted");
    assert_eq!(a.entries.len(), 2);
    assert_eq!(a.entries[1].method, Method::Deflate);
    assert!(a.entries[1].exec);
    let d = hash_entry(&mut Cursor::new(&bytes), &a.entries[1]).unwrap();
    assert_eq!(d.head, b"\x7fELF");
    assert_eq!(d.size, 400);
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

#[test]
fn refuses_bytes_after_the_eocd() {
    let mut bytes = build(&two());
    bytes.push(0);
    refused(audit(&bytes), reason::UNSUPPORTED);
    let mut bytes = build(&two());
    bytes.extend_from_slice(b"appended signature block");
    refused(audit(&bytes), reason::UNSUPPORTED);
}

#[test]
fn refuses_an_archive_comment() {
    // A comment appended properly (length field set).
    let mut bytes = build(&two());
    let at = eocd_at(&bytes);
    patch_u16(&mut bytes, at + 20, 3);
    bytes.extend_from_slice(b"hi!");
    refused(audit(&bytes), reason::UNSUPPORTED);
    // A comment length that claims bytes that are not there.
    let mut bytes = build(&two());
    let at = eocd_at(&bytes);
    patch_u16(&mut bytes, at + 20, 1);
    refused(audit(&bytes), reason::UNSUPPORTED);
}

#[test]
fn refuses_bytes_before_the_first_local_header() {
    // Prepended, offsets untouched: the central directory no longer ends at the EOCD.
    let mut bytes = b"MZ stub".to_vec();
    bytes.extend_from_slice(&build(&two()));
    refused(audit(&bytes), reason::UNSUPPORTED);

    // Prepended with every offset shifted (a self-extractor's layout): the first local header is not at 0.
    let inner = build(&two());
    let shift = 7u32;
    let mut bytes = vec![0u8; shift as usize];
    bytes.extend_from_slice(&inner);
    let at = eocd_at(&bytes);
    let cd_off = u32::from_le_bytes(bytes[at + 16..at + 20].try_into().unwrap()) + shift;
    patch_u32(&mut bytes, at + 16, cd_off);
    let mut p = cd_off as usize;
    while p < at {
        let off = u32::from_le_bytes(bytes[p + 42..p + 46].try_into().unwrap());
        patch_u32(&mut bytes, p + 42, off + shift);
        let n = u16::from_le_bytes(bytes[p + 28..p + 30].try_into().unwrap()) as usize;
        p += 46 + n;
    }
    refused(audit(&bytes), reason::UNSUPPORTED);

    // A gap between two entries.
    let specs = two();
    let mut first = build(&specs[..1]);
    first.truncate(30 + 8 + 3);
    let mut bytes = first.clone();
    bytes.extend_from_slice(b"gap");
    let rest = build(&specs);
    bytes.extend_from_slice(&rest[first.len()..]);
    let at = eocd_at(&bytes);
    let cd_off = u32::from_le_bytes(bytes[at + 16..at + 20].try_into().unwrap()) + 3;
    patch_u32(&mut bytes, at + 16, cd_off);
    let second = cd_off as usize + 46 + 8;
    let off = u32::from_le_bytes(bytes[second + 42..second + 46].try_into().unwrap());
    patch_u32(&mut bytes, second + 42, off + 3);
    refused(audit(&bytes), reason::UNSUPPORTED);
}

#[test]
fn refuses_a_local_header_that_disagrees_with_the_central_directory() {
    // Local CRC (offset 14), compressed size (18), uncompressed size (22), method (8), and a name byte (30).
    for (at, width) in [(14, 4), (18, 4), (22, 4), (8, 2), (30, 1)] {
        let mut bytes = build(&two());
        bytes[at] ^= if width == 2 { 0x08 } else { 0x01 };
        refused(audit(&bytes), reason::UNSUPPORTED);
    }
    // A data descriptor that disagrees with the central directory.
    let spec = Spec {
        descriptor: true,
        ..stored("payload/a.md", b"abc")
    };
    let mut bytes = build(&[spec]);
    let desc = 30 + "payload/a.md".len() + 3;
    bytes[desc + 4] ^= 1;
    refused(audit(&bytes), reason::UNSUPPORTED);
}

#[test]
fn refuses_encrypted_and_zip64_and_multi_disk() {
    let enc = Spec {
        flags: 0x0801,
        ..stored("payload/a.md", b"abc")
    };
    refused(audit(&build(&[enc])), reason::UNSUPPORTED);

    // ZIP64 sentinels in the EOCD and in a central entry.
    let mut bytes = build(&two());
    let at = eocd_at(&bytes);
    patch_u32(&mut bytes, at + 16, 0xFFFF_FFFF);
    refused(audit(&bytes), reason::UNSUPPORTED);
    let mut bytes = build(&two());
    let at = eocd_at(&bytes);
    patch_u16(&mut bytes, at + 8, 0xFFFF);
    patch_u16(&mut bytes, at + 10, 0xFFFF);
    refused(audit(&bytes), reason::UNSUPPORTED);
    let mut bytes = build(&two());
    let at = eocd_at(&bytes);
    let cd = u32::from_le_bytes(bytes[at + 16..at + 20].try_into().unwrap()) as usize;
    patch_u32(&mut bytes, cd + 24, 0xFFFF_FFFF);
    refused(audit(&bytes), reason::UNSUPPORTED);

    // Multi-disk: this disk's number, the central directory's disk, and a per-disk count that differs.
    for (field, v) in [(4usize, 1u16), (6, 1), (8, 1)] {
        let mut bytes = build(&two());
        let at = eocd_at(&bytes);
        patch_u16(&mut bytes, at + field, v);
        refused(audit(&bytes), reason::UNSUPPORTED);
    }
}

#[test]
fn refuses_bzip2_and_other_methods() {
    for method in [12u16, 14, 93, 95, 99, 1] {
        let s = Spec {
            method,
            ..stored("payload/a.md", b"abc")
        };
        refused(audit(&build(&[s])), reason::UNSUPPORTED);
    }
}

fn named(name: &[u8]) -> Result<Audited, Refusal> {
    let s = Spec {
        name: name.to_vec(),
        ..stored("x", b"abc")
    };
    audit(&build(&[stored("p1x.json", b"{}"), s]))
}

#[test]
fn refuses_parent_absolute_drive_backslash_and_control_names() {
    for name in [
        &b"payload/../p1x.json"[..],
        b"../evil",
        b"payload/./a.md",
        b"/etc/passwd",
        b"C:/Windows/evil.dll",
        b"c:evil",
        b"payload\\a.md",
        b"payload/a\x00.md",
        b"payload/a\x07.md",
        b"payload/a\x7f.md",
        "payload/a\u{85}.md".as_bytes(),
        b"payload//a.md",
        b"",
        b"payload/\xff.md",
        "payload/cafe\u{301}.md".as_bytes(),
    ] {
        refused(named(name), reason::UNSAFE_ENTRY);
    }
    named(b"payload/a.md").expect("a plain name passes");
}

#[test]
fn refuses_too_many_segments_and_long_names() {
    let sixteen = vec!["d"; 15].join("/") + "/f";
    named(sixteen.as_bytes()).expect("16 segments pass");
    let seventeen = vec!["d"; 16].join("/") + "/f";
    refused(named(seventeen.as_bytes()), reason::UNSAFE_ENTRY);
    let long = format!("payload/{}", "a".repeat(240 - 8));
    assert_eq!(long.len(), 240);
    named(long.as_bytes()).expect("240 bytes pass");
    let longer = format!("payload/{}", "a".repeat(241 - 8));
    refused(named(longer.as_bytes()), reason::UNSAFE_ENTRY);
}

#[test]
fn refuses_windows_device_names_and_trailing_dot_or_space() {
    for name in [
        "payload/con",
        "payload/CON.txt",
        "payload/Prn.md",
        "aux/x.md",
        "payload/nul.tar.gz",
        "payload/com1",
        "payload/COM9.log",
        "payload/lpt1.x",
        "payload/LPT9",
        "payload/a.",
        "payload/a ",
        "payload/dir./x",
        "payload/dir /x",
    ] {
        refused(named(name.as_bytes()), reason::UNSAFE_ENTRY);
    }
    for ok in [
        "payload/console.md",
        "payload/com10",
        "payload/lpt0",
        "payload/nullable.rs",
        "payload/.hidden",
    ] {
        named(ok.as_bytes()).unwrap_or_else(|e| panic!("{ok}: {e:?}"));
    }
}

#[test]
fn refuses_case_and_nfc_collisions() {
    let bytes = build(&[stored("payload/A.md", b"1"), stored("payload/a.md", b"2")]);
    refused(audit(&bytes), reason::UNSAFE_ENTRY);
    // Full names are compared: different files under directories that differ only by case do not collide.
    let bytes = build(&[
        stored("payload/Docs/x.md", b"1"),
        stored("payload/docs/y.md", b"2"),
    ]);
    audit(&bytes).expect("different full names");
    let bytes = build(&[stored("payload/a.md", b"1"), stored("payload/a.md", b"2")]);
    refused(audit(&bytes), reason::UNSAFE_ENTRY);
    // NFC "é" beside NFD "e\u{301}".
    let bytes = build(&[
        stored("payload/caf\u{e9}.md", b"1"),
        stored("payload/cafe\u{301}.md", b"2"),
    ]);
    refused(audit(&bytes), reason::UNSAFE_ENTRY);
    // A file whose name is also an implied directory of another entry.
    let bytes = build(&[stored("payload/a", b"1"), stored("payload/A/b.md", b"2")]);
    refused(audit(&bytes), reason::UNSAFE_ENTRY);
    // Distinct names that share a directory are fine.
    let bytes = build(&[
        stored("payload/Docs/x.md", b"1"),
        stored("payload/Docs/y.md", b"2"),
    ]);
    audit(&bytes).expect("distinct names");
}

#[test]
fn refuses_symlink_hardlink_device_and_explicit_directory_entries() {
    // symlink, an unknown file type (no ZIP type for hard links exists; any non-regular type is refused),
    // character device, block device, directory, FIFO, socket.
    for mode in [
        0o120777, 0o110644, 0o020644, 0o060644, 0o040755, 0o010644, 0o140755,
    ] {
        let s = Spec {
            mode: Some(mode),
            ..stored("payload/x", b"target")
        };
        refused(audit(&build(&[s])), reason::UNSAFE_ENTRY);
    }
    // An explicit directory entry, by name and by the MS-DOS directory attribute.
    let dir = Spec {
        mode: Some(0o040755),
        ..stored("payload/dir/", b"")
    };
    refused(audit(&build(&[dir])), reason::UNSAFE_ENTRY);
    let dir = Spec {
        mode: None,
        ..stored("payload/dir/", b"")
    };
    refused(audit(&build(&[dir])), reason::UNSAFE_ENTRY);
    let mut bytes = build(&[Spec {
        mode: None,
        ..stored("payload/dir", b"")
    }]);
    let at = eocd_at(&bytes);
    let cd = u32::from_le_bytes(bytes[at + 16..at + 20].try_into().unwrap()) as usize;
    patch_u32(&mut bytes, cd + 38, 0x10);
    refused(audit(&bytes), reason::UNSAFE_ENTRY);
    // Regular files: with and without file-type bits, and from a non-Unix writer.
    for mode in [Some(0o100644), Some(0o644), None] {
        let s = Spec {
            mode,
            ..stored("payload/x", b"ok")
        };
        audit(&build(&[s])).unwrap_or_else(|e| panic!("{mode:?}: {e:?}"));
    }
}

#[test]
fn refuses_a_101_to_1_ratio_and_an_oversized_entry_and_too_many_entries() {
    let zeros = vec![0u8; 100_000];
    let mut s = deflated("payload/zeros", &zeros);
    let c = s.data.len() as u32;
    // Declared 100:1 passes the audit (the stream then disagrees, which hash_entry finds).
    s.uncompressed = 100 * c;
    audit(&build(&[s.clone()])).expect("100:1 is at the limit");
    s.uncompressed = 101 * c;
    refused(audit(&build(&[s])), reason::TOO_LARGE);
    // The real 100 000 zeros deflate far beyond 100:1.
    refused(
        audit(&build(&[deflated("payload/zeros", &zeros)])),
        reason::TOO_LARGE,
    );

    let tight = Limits {
        entry_bytes: 10,
        ..Limits::default()
    };
    let bytes = build(&[stored("payload/a", b"0123456789")]);
    audit_zip(&mut Cursor::new(&bytes), &tight).expect("at the entry cap");
    let bytes = build(&[stored("payload/a", b"0123456789A")]);
    refused(
        audit_zip(&mut Cursor::new(&bytes), &tight),
        reason::TOO_LARGE,
    );

    let total = Limits {
        package_bytes: 10_000,
        ..Limits::default()
    };
    let bytes = build(&[
        stored("payload/a", &[1u8; 3000]),
        stored("payload/b", &[2u8; 3000]),
        stored("payload/c", &[3u8; 3000]),
    ]);
    audit_zip(&mut Cursor::new(&bytes), &total).expect("under the package cap");
    let mut s = deflated("payload/d", b"dddd");
    s.uncompressed = 2000;
    let mut specs = vec![
        stored("payload/a", &[1u8; 3000]),
        stored("payload/b", &[2u8; 3000]),
    ];
    specs.push(stored("payload/c", &[3u8; 3000]));
    specs.push(s);
    refused(
        audit_zip(&mut Cursor::new(build(&specs)), &total),
        reason::TOO_LARGE,
    );
    // The file itself larger than the package cap.
    let small = Limits {
        package_bytes: 100,
        ..Limits::default()
    };
    refused(
        audit_zip(
            &mut Cursor::new(build(&[stored("payload/a", &[0u8; 200])])),
            &small,
        ),
        reason::TOO_LARGE,
    );

    // 20 000 entries pass; 20 001 do not.
    let many: Vec<Spec> = (0..20_000)
        .map(|i| stored(&format!("payload/{i}"), b""))
        .collect();
    audit(&build(&many)).expect("20 000 entries");
    let mut many = many;
    many.push(stored("payload/one-more", b""));
    refused(audit(&build(&many)), reason::TOO_LARGE);
}

#[test]
fn hash_entry_refuses_a_lying_uncompressed_size() {
    let body = b"hello hello hello hello hello hello".to_vec();
    for delta in [-1i64, 1] {
        let mut s = deflated("payload/a.md", &body);
        s.uncompressed = (body.len() as i64 + delta) as u32;
        let bytes = build(&[s]);
        let a = audit(&bytes).expect("audit trusts the declared size");
        refused(
            hash_entry(&mut Cursor::new(&bytes), &a.entries[0]),
            reason::DIGEST,
        );
        refused(
            read_entry(&mut Cursor::new(&bytes), &a.entries[0], 1 << 20),
            reason::DIGEST,
        );
    }
    // Stored: the declared uncompressed size differs from the stored bytes.
    let mut s = stored("payload/a.md", &body);
    s.uncompressed += 1;
    let bytes = build(&[s]);
    let a = audit(&bytes).expect("audit trusts the declared size");
    refused(
        hash_entry(&mut Cursor::new(&bytes), &a.entries[0]),
        reason::DIGEST,
    );
    // A CRC that does not match the data.
    let mut s = deflated("payload/a.md", &body);
    s.crc ^= 1;
    let bytes = build(&[s]);
    let a = audit(&bytes).unwrap();
    refused(
        hash_entry(&mut Cursor::new(&bytes), &a.entries[0]),
        reason::DIGEST,
    );
    // Corrupt deflate data.
    let mut s = deflated("payload/a.md", &body);
    s.data = vec![0xff; s.data.len()];
    let bytes = build(&[s]);
    let a = audit(&bytes).unwrap();
    refused(
        hash_entry(&mut Cursor::new(&bytes), &a.entries[0]),
        reason::DIGEST,
    );
    // read_entry refuses an entry above its cap before reading it.
    let bytes = build(&[stored("p1x.json", &[b' '; 64])]);
    let a = audit(&bytes).unwrap();
    refused(
        read_entry(&mut Cursor::new(&bytes), &a.entries[0], 63),
        reason::TOO_LARGE,
    );
    assert_eq!(
        read_entry(&mut Cursor::new(&bytes), &a.entries[0], 64)
            .unwrap()
            .len(),
        64
    );
}

#[test]
fn hash_entry_keeps_the_first_four_bytes() {
    let bytes = build(&[
        deflated("payload/bin/tool", &b"\x7fELF\x02\x01\x01".repeat(10)),
        stored("payload/run.sh", b"#!/bin/sh\n"),
        stored("payload/ab", b"ab"),
        stored("payload/empty", b""),
    ]);
    let a = audit(&bytes).unwrap();
    let mut cur = Cursor::new(&bytes);
    let heads: Vec<Vec<u8>> = a
        .entries
        .iter()
        .map(|e| hash_entry(&mut cur, e).unwrap().head)
        .collect();
    assert_eq!(
        heads,
        [
            b"\x7fELF".to_vec(),
            b"#!/b".to_vec(),
            b"ab".to_vec(),
            Vec::new()
        ]
    );
    let d = hash_entry(&mut cur, &a.entries[3]).unwrap();
    assert_eq!(
        d.sha256,
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    assert_eq!(d.size, 0);
}

#[test]
fn audit_hashes_the_whole_stream() {
    let bytes = build(&two());
    let mut cur = Cursor::new(&bytes);
    // A handle positioned mid-stream is hashed from the start.
    cur.set_position(17);
    let a = audit_zip(&mut cur, &Limits::default()).unwrap();
    assert_eq!(a.size, bytes.len() as u64);
    assert_eq!(a.sha256, hex(&Sha256::digest(&bytes)));
    assert_eq!(a.sha256.len(), 64);
    // A re-zipped package with identical content hashes differently as a file, which is why `files` exists.
    let other = build(&two().into_iter().rev().collect::<Vec<_>>());
    assert_ne!(audit(&other).unwrap().sha256, a.sha256);
}
