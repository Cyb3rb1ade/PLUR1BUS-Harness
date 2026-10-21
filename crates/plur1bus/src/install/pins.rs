//! What `setup` trusts (HB8, HB10): the pinned Node version and its archive hashes (copied from
//! `https://nodejs.org/dist/v24.21.0/SHASUMS256.txt`, committed as `tests/fixtures/node-v24.21.0-SHASUMS256.txt`),
//! and the values a release build bakes in (`PLUR1BUS_CORE_SHA256`, `PLUR1BUS_RELEASE_BASE_URL`).
use super::targets::Target;
use std::sync::OnceLock;

pub const NODE_VERSION: &str = "24.21.0";
/// The Node distribution root. `PLUR1BUS_NODE_MIRROR` replaces it (a real mirror override, not a test seam: the
/// archive hash is still enforced).
pub const NODE_DIST: &str = "https://nodejs.org/dist";

/// SHA-256 of `node-v24.21.0-<target>.{tar.gz,zip}`, one line each of the committed `SHASUMS256.txt`.
const NODE_SHA256: [(Target, &str); 5] = [
    (
        Target::LinuxX64,
        "6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff",
    ),
    (
        Target::LinuxArm64,
        "724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5",
    ),
    (
        Target::DarwinArm64,
        "bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057",
    ),
    (
        Target::WinX64,
        "158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541",
    ),
    (
        Target::WinArm64,
        "8779b1bde1d39f8d420e3b57aa657b39891af434d3de44a919044cec06785921",
    ),
];

/// Whether this build lets `PLUR1BUS_ALLOW_TEST_INTERNALS=1` replace what it trusts (the release key, the Node and
/// core pins) or redirect an update (`PLUR1BUS_UPDATE_TARGET_BIN`, `PLUR1BUS_TEST_UPDATE_KILL_AT`).
///
/// A debug build always does (that is what `cargo test` runs). A release build does so only when it carries no
/// release key of its own: the unkeyed builds CI makes (`cargo test --release` in the release-smoke workflow) have no
/// trust anchor to protect and use the seams to sign a local feed, while a build with a baked key, which is a shipped
/// binary, ignores them whatever the environment says.
pub fn trust_seams_allowed() -> bool {
    seams_allowed(cfg!(debug_assertions), release_key_baked())
}

fn seams_allowed(debug_build: bool, release_key_baked: bool) -> bool {
    debug_build || !release_key_baked
}

/// Whether a channel key was baked in at build time (an empty variable counts as none).
fn release_key_baked() -> bool {
    [
        option_env!("PLUR1BUS_RELEASE_PUBKEY_STABLE"),
        option_env!("PLUR1BUS_RELEASE_PUBKEY_BETA"),
    ]
    .into_iter()
    .flatten()
    .any(|k| !k.trim().is_empty())
}

/// What the environment says about one test seam.
#[derive(Debug, PartialEq, Eq)]
enum Seam {
    /// Not set, empty, or `PLUR1BUS_ALLOW_TEST_INTERNALS` is not `1`.
    Off,
    /// Set and requested, but this build does not honour test seams ([`trust_seams_allowed`]).
    Refused,
    /// The trimmed value.
    Value(String),
}

fn classify(value: Option<String>, internals_requested: bool, trusted_build: bool) -> Seam {
    let Some(v) = value
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
    else {
        return Seam::Off;
    };
    match (internals_requested, trusted_build) {
        (false, _) => Seam::Off,
        (true, false) => Seam::Refused,
        (true, true) => Seam::Value(v),
    }
}

/// The seam `name`'s value, or `None` (a refused seam says so once on stderr: a shipped binary must not be steered by
/// its environment, and a person who set the variable should know it did nothing).
fn read_seam(name: &str) -> Option<String> {
    let internals = std::env::var("PLUR1BUS_ALLOW_TEST_INTERNALS").as_deref() == Ok("1");
    match classify(std::env::var(name).ok(), internals, trust_seams_allowed()) {
        Seam::Value(v) => Some(v),
        Seam::Off => None,
        Seam::Refused => {
            eprintln!(
                "plur1bus: ignoring {name}: this build carries its own release key, so a test seam cannot replace what it trusts"
            );
            None
        }
    }
}

/// A test seam's value, read once per process and only with `PLUR1BUS_ALLOW_TEST_INTERNALS=1` in a build that honours
/// seams. Lower-cased: only for hex digests.
fn seam(cell: &'static OnceLock<Option<String>>, name: &str) -> Option<&'static str> {
    cell.get_or_init(|| read_seam(name).map(|v| v.to_ascii_lowercase()))
        .as_deref()
}

/// A test seam's value, case preserved (a base64 minisign public key is case-sensitive, unlike a hex digest).
fn seam_raw(cell: &'static OnceLock<Option<String>>, name: &str) -> Option<&'static str> {
    cell.get_or_init(|| read_seam(name)).as_deref()
}

/// The committed pin, ignoring the test seam.
fn pinned_node_sha256(t: Target) -> &'static str {
    NODE_SHA256
        .iter()
        .find(|(p, _)| *p == t)
        .map(|(_, h)| *h)
        .expect("every target has a Node pin")
}

/// The SHA-256 the Node archive for `t` must have. `PLUR1BUS_TEST_NODE_SHA256` replaces the current target's pin
/// under `PLUR1BUS_ALLOW_TEST_INTERNALS=1` (tests serve a fake archive).
pub fn node_sha256(t: Target) -> &'static str {
    static SEAM: OnceLock<Option<String>> = OnceLock::new();
    if Target::current() == Some(t) {
        if let Some(h) = seam(&SEAM, "PLUR1BUS_TEST_NODE_SHA256") {
            return h;
        }
    }
    pinned_node_sha256(t)
}

/// The distribution root: `PLUR1BUS_NODE_MIRROR` (trailing `/` trimmed) or [`NODE_DIST`].
pub fn node_dist() -> String {
    match std::env::var("PLUR1BUS_NODE_MIRROR") {
        Ok(m) if !m.trim().is_empty() => m.trim().trim_end_matches('/').to_string(),
        _ => NODE_DIST.to_string(),
    }
}

/// `<dist>/v<NODE_VERSION>/<archive>` for `t`.
pub fn node_url(t: Target) -> String {
    format!(
        "{}/v{NODE_VERSION}/{}",
        node_dist(),
        t.node_archive(NODE_VERSION)
    )
}

/// The core payload's SHA-256 baked at release build (`PLUR1BUS_CORE_SHA256`); `None` in a dev build.
/// `PLUR1BUS_TEST_CORE_SHA256` replaces it under `PLUR1BUS_ALLOW_TEST_INTERNALS=1`.
pub fn core_payload_sha256() -> Option<&'static str> {
    static SEAM: OnceLock<Option<String>> = OnceLock::new();
    seam(&SEAM, "PLUR1BUS_TEST_CORE_SHA256").or(option_env!("PLUR1BUS_CORE_SHA256"))
}

/// What a release build expects of the `plur1bus-attest` helper shipped beside it (issue #192 follow-up): its SHA-256, the Apple team id
/// its code signature must carry (macOS) and the thumbprint of its Authenticode signer (Windows). Baked from `PLUR1BUS_ATTEST_SHA256`,
/// `PLUR1BUS_ATTEST_TEAM_ID`, `PLUR1BUS_ATTEST_WIN_THUMBPRINT` at build time; each is `None` in a dev build, which then pins the
/// helper by owner and mode only. The core re-checks them before every start (`packages/core/src/attestation/helper.ts`).
pub fn attest_helper_pins() -> (
    Option<&'static str>,
    Option<&'static str>,
    Option<&'static str>,
) {
    (
        option_env!("PLUR1BUS_ATTEST_SHA256"),
        option_env!("PLUR1BUS_ATTEST_TEAM_ID"),
        option_env!("PLUR1BUS_ATTEST_WIN_THUMBPRINT"),
    )
}

/// Where a release build finds its payloads and `{channel}.json` (`PLUR1BUS_RELEASE_BASE_URL`); `None` in a dev
/// build.
pub fn release_base_url() -> Option<&'static str> {
    option_env!("PLUR1BUS_RELEASE_BASE_URL")
}

/// The minisign public key `update --check` verifies `{channel}.json` against (HB10): the channel's baked key
/// (`PLUR1BUS_RELEASE_PUBKEY_STABLE`/`_BETA`), or, under `PLUR1BUS_ALLOW_TEST_INTERNALS=1` in a build that honours
/// test seams ([`trust_seams_allowed`]: never one with a baked key and no debug assertions),
/// `PLUR1BUS_TEST_RELEASE_PUBKEY` in place of either. `None` in a dev build with no seam: the caller reports
/// `verified: false` rather than refusing.
pub fn release_pubkey_for(channel: &str) -> Option<&'static str> {
    static SEAM: OnceLock<Option<String>> = OnceLock::new();
    if let Some(k) = seam_raw(&SEAM, "PLUR1BUS_TEST_RELEASE_PUBKEY") {
        return Some(k);
    }
    match channel {
        "beta" => option_env!("PLUR1BUS_RELEASE_PUBKEY_BETA"),
        _ => option_env!("PLUR1BUS_RELEASE_PUBKEY_STABLE"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHASUMS: &str = include_str!("../../tests/fixtures/node-v24.21.0-SHASUMS256.txt");

    #[test]
    fn node_pins_match_the_committed_shasums() {
        for t in Target::ALL {
            let name = t.node_archive(NODE_VERSION);
            let line = SHASUMS
                .lines()
                .find(|l| l.split_whitespace().nth(1) == Some(name.as_str()))
                .unwrap_or_else(|| panic!("{name} is not in SHASUMS256.txt"));
            let hash = line.split_whitespace().next().unwrap();
            assert_eq!(pinned_node_sha256(t), hash, "{name}");
            assert_eq!(hash.len(), 64);
        }
    }

    #[test]
    fn a_shipped_build_with_its_own_key_ignores_the_test_seams() {
        // A debug build (what `cargo test` runs) and an unkeyed release build (release-smoke) honour them.
        assert!(seams_allowed(true, true));
        assert!(seams_allowed(true, false));
        assert!(seams_allowed(false, false));
        // A release build with a baked key does not, whatever the environment says.
        assert!(!seams_allowed(false, true));
    }

    #[test]
    fn a_seam_needs_the_master_gate_and_a_build_that_honours_it() {
        let key = Some(" Ab+/= \n".to_string());
        assert_eq!(classify(key.clone(), false, true), Seam::Off);
        assert_eq!(classify(key.clone(), false, false), Seam::Off);
        assert_eq!(classify(key.clone(), true, false), Seam::Refused);
        assert_eq!(classify(key, true, true), Seam::Value("Ab+/=".into()));
        assert_eq!(classify(None, true, false), Seam::Off);
        assert_eq!(classify(Some("  ".into()), true, false), Seam::Off);
    }

    #[test]
    fn the_node_url_follows_the_dist_layout() {
        // PLUR1BUS_NODE_MIRROR is not set in the test environment.
        if std::env::var_os("PLUR1BUS_NODE_MIRROR").is_none() {
            assert_eq!(
                node_url(Target::WinArm64),
                "https://nodejs.org/dist/v24.21.0/node-v24.21.0-win-arm64.zip"
            );
        }
    }
}
