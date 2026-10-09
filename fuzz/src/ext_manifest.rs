//! `plur1bus-ext`, everything that reads package bytes: `p1x.json` (`parse_manifest`, kind and compat checks), the
//! naming rules, `SKILL.md` frontmatter, the version-range translator and the central-directory ZIP audit.
//! First byte selects the mode (0 manifest, 1 SKILL.md, 2 names/ranges/urls, otherwise ZIP). Invariants: no panic; a
//! manifest that parses re-serialises to one that parses to the same value; an audited archive lists only
//! relative, non-traversing entry names within the limits, and every entry can be streamed without panic.
use plur1bus_ext::compat::{check_compat, harness_req, HostFacts};
use plur1bus_ext::kinds::{check_kind, url_host};
use plur1bus_ext::manifest::{parse_manifest, valid_name, valid_publisher};
use plur1bus_ext::skill::{is_excluded, is_skipped, parse_skill_md, validate_skill_md};
use plur1bus_ext::zipaudit::{audit_zip, hash_entry, read_entry, Limits};
use std::io::Cursor;

const RESERVED: &[&str] = &["core", "engine", "supervisor"];

pub fn run(data: &[u8]) {
    let Some((&mode, rest)) = data.split_first() else {
        return;
    };
    match mode {
        0 => manifest(rest),
        1 => {
            if let Ok(s) = std::str::from_utf8(rest) {
                let _ = parse_skill_md(s);
                let _ = validate_skill_md(s, "zabbix-triage");
            }
        }
        2 => {
            let s = String::from_utf8_lossy(rest);
            let _ = (
                valid_name(&s),
                valid_publisher(&s),
                url_host(&s),
                is_skipped(&s),
                is_excluded(&s),
            );
            let _ = harness_req(&s);
        }
        _ => zip(rest),
    }
}

fn manifest(raw: &[u8]) {
    let Ok(m) = parse_manifest(raw, RESERVED) else {
        return;
    };
    let _ = check_kind(&m);
    let host = HostFacts {
        harness_version: "0.2.0".into(),
        module_api_current: 1,
        rpc_version: "1.4.1".into(),
        platform: Some("linux-x64".into()),
        container: false,
    };
    let _ = check_compat(&m, &host);
    let first = serde_json::to_value(&m).expect("a manifest serialises");
    let bytes = serde_json::to_vec(&first).expect("json");
    let again = parse_manifest(&bytes, RESERVED).expect("a serialised manifest re-parses");
    assert_eq!(
        first,
        serde_json::to_value(&again).expect("serialises"),
        "manifest round trip changed it"
    );
}

fn zip(raw: &[u8]) {
    // Small caps keep a crafted archive from spending the run inflating; the parser's own defaults are exercised by
    // the regular tests.
    let limits = Limits {
        package_bytes: 1 << 20,
        entry_bytes: 1 << 18,
        max_entries: 64,
        ..Limits::default()
    };
    let mut r = Cursor::new(raw);
    let Ok(audited) = audit_zip(&mut r, &limits) else {
        return;
    };
    assert!(audited.entries.len() <= limits.max_entries);
    for e in &audited.entries {
        let n = e.name.as_str();
        assert!(
            !n.is_empty() && !n.starts_with('/') && !n.contains(['\\', '\0']),
            "unsafe entry name {n:?}"
        );
        assert!(
            n.split('/').all(|s| !s.is_empty() && s != "." && s != ".."),
            "traversing entry name {n:?}"
        );
        assert!(e.uncompressed <= limits.entry_bytes);
        let _ = hash_entry(&mut r, e);
        let _ = read_entry(&mut r, e, 1 << 16);
    }
}
