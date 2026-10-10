use plur1bus_desktop::updates::*;
use semver::Version;
use std::io::Cursor;
fn release() -> Release {
    serde_json::from_value(serde_json::json!({"version":"0.1.1","channel":"stable","kind":"patch","security":false,"date":"2026-10-10","notes":{"de":"Behoben","en":"Fixed"},"minFromVersion":"0.1.0","bundle":"0".repeat(64),"tauri":"1".repeat(64)})).unwrap()
}
fn running() -> Version {
    Version::parse("0.1.0").unwrap()
}
fn decision(r: &Release, s: &UpdateSettings, now: u64, hour: u8, active: bool) -> Offer {
    decide(r, &running(), s, now, hour, active)
}
fn signed(bytes: &[u8]) -> (String, String) {
    let pair = minisign::KeyPair::generate_unencrypted_keypair().unwrap();
    let sig = minisign::sign(Some(&pair.pk), &pair.sk, Cursor::new(bytes), None, None).unwrap();
    (pair.pk.to_base64(), sig.to_string())
}
#[test]
fn a_signed_release_is_offered() {
    let bytes = serde_json::to_vec(&release()).unwrap();
    let (key, sig) = signed(&bytes);
    let r = verify_feed(&bytes, &sig, &key, Channel::Stable).unwrap();
    assert_eq!(
        decision(&r, &UpdateSettings::default(), 0, 12, false),
        Offer::Show
    );
}
#[test]
fn a_bad_signature_is_refused() {
    let mut bytes = serde_json::to_vec(&release()).unwrap();
    let (key, sig) = signed(&bytes);
    bytes.push(b' ');
    assert!(verify_feed(&bytes, &sig, &key, Channel::Stable).is_err());
}
#[test]
fn a_key_from_another_channel_is_refused() {
    let bytes = serde_json::to_vec(&release()).unwrap();
    let (_, sig) = signed(&bytes);
    let (key, _) = signed(&bytes);
    assert!(verify_feed(&bytes, &sig, &key, Channel::Stable).is_err());
    let (key, sig) = signed(&bytes);
    assert!(verify_feed(&bytes, &sig, &key, Channel::Beta).is_err());
}
#[test]
fn a_lower_or_equal_version_is_not_offered() {
    for v in ["0.0.9", "0.1.0"] {
        let mut r = release();
        r.version = Version::parse(v).unwrap();
        assert_eq!(
            decision(&r, &UpdateSettings::default(), 0, 12, false),
            Offer::None
        );
    }
}
#[test]
fn min_from_version_asks_for_the_intermediate_release() {
    let mut r = release();
    r.min_from_version = Version::parse("0.1.1").unwrap();
    assert_eq!(
        decision(&r, &UpdateSettings::default(), 0, 12, false),
        Offer::NeedsIntermediate(r.min_from_version)
    );
}
#[test]
fn held_offers_nothing() {
    let s = UpdateSettings {
        held: true,
        ..Default::default()
    };
    assert_eq!(decision(&release(), &s, 0, 3, false), Offer::None);
}
#[test]
fn later_waits_24h_or_next_start() {
    let mut s = UpdateSettings::default();
    s.later(10);
    assert_eq!(decision(&release(), &s, 86409, 12, false), Offer::None);
    assert_eq!(decision(&release(), &s, 86410, 12, false), Offer::Show);
    s.next_start(20);
    assert_eq!(decision(&release(), &s, 20, 12, false), Offer::None);
    s.next_start(86410);
    assert_eq!(decision(&release(), &s, 86410, 12, false), Offer::Show);
}
#[test]
fn skip_never_offers_that_version_again() {
    let mut s = UpdateSettings::default();
    s.skip(&release(), 0);
    assert_eq!(decision(&release(), &s, 10000000, 12, false), Offer::None);
}
#[test]
fn a_skipped_security_release_returns_after_7_days() {
    let mut s = UpdateSettings::default();
    let mut r = release();
    r.security = true;
    s.skip(&r, 10);
    assert_eq!(decision(&r, &s, 604809, 12, false), Offer::None);
    assert_eq!(decision(&r, &s, 604810, 12, false), Offer::Show);
}
#[test]
fn auto_patch_is_on_by_default_for_a_fresh_install() {
    assert!(UpdateSettings::default().auto_patch);
}
#[test]
fn auto_patch_turned_off_stays_off_after_an_update() {
    let dir = tempfile::tempdir().unwrap();
    let s = UpdateSettings {
        auto_patch: false,
        ..Default::default()
    };
    save_settings(dir.path(), &s).unwrap();
    assert!(!load_settings(dir.path()).unwrap().auto_patch);
}
#[test]
fn auto_patch_never_installs_minor_or_major() {
    for kind in [Kind::Minor, Kind::Major] {
        let mut r = release();
        r.kind = kind;
        assert_eq!(
            decision(&r, &UpdateSettings::default(), 0, 3, false),
            Offer::Show
        );
    }
}
#[test]
fn auto_patch_waits_for_quiet_hours_and_no_active_run() {
    let r = release();
    let s = UpdateSettings::default();
    assert_eq!(decision(&r, &s, 0, 3, false), Offer::AutoInstall);
    assert_eq!(decision(&r, &s, 0, 12, false), Offer::Show);
    assert_eq!(decision(&r, &s, 0, 3, true), Offer::Show);
}
#[test]
fn leaving_beta_never_downgrades() {
    let mut r = release();
    r.version = Version::parse("0.1.0").unwrap();
    assert_eq!(
        decide(
            &r,
            &Version::parse("0.2.0-beta.1").unwrap(),
            &UpdateSettings::default(),
            0,
            3,
            false
        ),
        Offer::None
    );
}
#[test]
fn schema_invalid_release_json_is_refused() {
    for mutate in [0, 1, 2, 3] {
        let mut v = serde_json::to_value(release()).unwrap();
        match mutate {
            0 => v["tauri"] = serde_json::json!("bad"),
            1 => v["notes"] = serde_json::json!({"en":"only"}),
            2 => v["date"] = serde_json::json!("bad"),
            _ => v["unexpected"] = serde_json::json!(true),
        };
        let bytes = serde_json::to_vec(&v).unwrap();
        let (key, sig) = signed(&bytes);
        assert!(verify_feed(&bytes, &sig, &key, Channel::Stable).is_err());
    }
}
#[test]
fn failed_and_successful_checks_share_the_six_hour_limit() {
    let mut limiter = CheckClock::default();
    assert!(limiter.begin(100));
    assert!(!limiter.begin(101));
    assert!(limiter.begin(21700));
    assert!(!limiter.begin(50));
}
#[test]
fn desktop_feed_is_accepted_by_the_current_native_updater_schema() {
    let schema: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../crates/plur1bus/schema/release-manifest.schema.json"
    ))
    .unwrap();
    let validator = jsonschema::validator_for(&schema).unwrap();
    let mut value = serde_json::to_value(release()).unwrap();
    assert!(validator.is_valid(&value));
    let native: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../crates/plur1bus/tests/fixtures/release/stable.json"
    ))
    .unwrap();
    value["native"] = native["native"].clone();
    assert!(validator.is_valid(&value));
    let bytes = serde_json::to_vec(&value).unwrap();
    let (key, sig) = signed(&bytes);
    assert!(verify_feed(&bytes, &sig, &key, Channel::Stable)
        .unwrap()
        .native
        .is_some());
}
#[test]
fn malformed_saved_preferences_do_not_reset_an_opt_out() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("updates.json"), b"broken").unwrap();
    assert!(load_settings(dir.path()).is_err());
}
#[test]
fn a_mislabelled_minor_never_automatically_installs() {
    let mut r = release();
    r.version = Version::parse("0.2.0").unwrap();
    assert_eq!(
        decision(&r, &UpdateSettings::default(), 0, 3, false),
        Offer::Show
    );
}
#[test]
fn update_endpoints_refuse_credentials_queries_and_non_loopback_http() {
    for s in [
        "http://harness.test/feed",
        "https://user:pass@harness.test/feed",
        "https://harness.test/feed?secret=x",
        "https://harness.test/feed#fragment",
    ] {
        assert!(!plur1bus_desktop::update_commands::valid_url(
            &url::Url::parse(s).unwrap(),
            true
        ));
    }
    assert!(plur1bus_desktop::update_commands::valid_url(
        &url::Url::parse("http://127.0.0.1/feed").unwrap(),
        true
    ));
    assert!(!plur1bus_desktop::update_commands::valid_url(
        &url::Url::parse("http://127.0.0.1/feed").unwrap(),
        false
    ));
}
