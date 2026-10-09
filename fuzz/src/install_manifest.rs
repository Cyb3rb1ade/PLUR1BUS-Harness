//! Install manifest, release manifest (the update feed `update --check` reads) and the pin lookups: the real
//! `install/manifest.rs` and `install/pins.rs`. The update module itself exposes no parser (it takes a `Layout`), so
//! the release-manifest parser it relies on is the update-feed target. Invariants: no panic; an install manifest that
//! parses serialises and re-parses to an equal value.
use crate::install::manifest::{parse_install, parse_release};
use crate::install::pins;
use crate::install::targets::Target;

pub fn run(data: &[u8]) {
    let Some((&sel, rest)) = data.split_first() else {
        return;
    };
    let text = String::from_utf8_lossy(rest);
    for t in Target::ALL {
        let _ = (pins::node_sha256(t), pins::node_url(t));
    }
    let _ = (
        pins::release_pubkey_for(&text),
        pins::release_base_url(),
        pins::core_payload_sha256(),
    );
    if sel % 2 == 0 {
        if let Ok(m) = parse_install(rest) {
            let _ = m.profile();
            let bytes = serde_json::to_vec(&m).expect("an install manifest serialises");
            let again = parse_install(&bytes).expect("a serialised install manifest re-parses");
            assert_eq!(m, again, "install manifest round trip changed it");
        }
    } else {
        let _ = parse_release(rest);
    }
}
