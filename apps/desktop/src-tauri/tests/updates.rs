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

/// SemVer §10: build metadata does not take part in precedence. The CLI (`update/guard.rs::precedence`) already ignores
/// it; the desktop updater must order versions the same way.
#[test]
fn build_metadata_is_ignored_when_ordering_versions() {
    use std::cmp::Ordering;
    let v = |s: &str| Version::parse(s).unwrap();
    assert_eq!(precedence(&v("1.2.3+a"), &v("1.2.3+b")), Ordering::Equal);
    assert_eq!(precedence(&v("1.2.3+a"), &v("1.2.3")), Ordering::Equal);
    assert_eq!(precedence(&v("1.2.3-rc.1+z"), &v("1.2.3")), Ordering::Less);
    assert_eq!(precedence(&v("1.2.4+a"), &v("1.2.3+z")), Ordering::Greater);
    assert!(same_version(&v("1.2.3+a"), &v("1.2.3+b")));
    assert!(!same_version(&v("1.2.3-rc.1"), &v("1.2.3+b")));
    assert!(same_version_str("1.2.3+other", &v("1.2.3+b")));
    assert!(!same_version_str("1.2.4", &v("1.2.3")));
    assert!(!same_version_str("not a version", &v("1.2.3")));
}
#[test]
fn a_release_that_differs_only_in_build_metadata_is_not_an_update() {
    let mut r = release();
    r.version = Version::parse("0.1.0+rebuilt").unwrap();
    assert_eq!(
        decision(&r, &UpdateSettings::default(), 0, 12, false),
        Offer::None
    );
    let mut r = release();
    r.version = Version::parse("0.1.1+b").unwrap();
    let running = Version::parse("0.1.1+a").unwrap();
    assert_eq!(
        decide(&r, &running, &UpdateSettings::default(), 0, 12, false),
        Offer::None
    );
}
#[test]
fn min_from_version_ignores_build_metadata() {
    let mut r = release();
    r.min_from_version = Version::parse("0.1.0+zzz").unwrap();
    assert_eq!(
        decision(&r, &UpdateSettings::default(), 0, 12, false),
        Offer::Show,
        "0.1.0 satisfies minFromVersion 0.1.0+zzz"
    );
}
#[test]
fn a_skipped_version_stays_skipped_under_other_build_metadata() {
    let mut s = UpdateSettings::default();
    let mut skipped = release();
    skipped.version = Version::parse("0.1.1+a").unwrap();
    s.skip(&skipped, 0);
    let mut r = release();
    r.version = Version::parse("0.1.1+b").unwrap();
    assert_eq!(decision(&r, &s, 10000000, 12, false), Offer::None);
}

fn release_at(version: &str, date: &str) -> Release {
    let mut r = release();
    r.version = Version::parse(version).unwrap();
    r.date = date.into();
    r
}
#[test]
fn an_older_signed_feed_is_refused_after_a_newer_one_was_seen() {
    let mut s = UpdateSettings::default();
    s.accept_feed(&release_at("0.1.3", "2026-10-12")).unwrap();
    // Validly signed (it passes verify_feed), but lower precedence than what was already seen.
    let stale = release_at("0.1.2", "2026-10-11");
    let bytes = serde_json::to_vec(&stale).unwrap();
    let (key, sig) = signed(&bytes);
    let verified = verify_feed(&bytes, &sig, &key, Channel::Stable).unwrap();
    assert_eq!(s.accept_feed(&verified), Err(UpdateError::Manifest));
    // The refused feed leaves the record untouched.
    assert_eq!(s.last_seen.as_ref().unwrap().version.to_string(), "0.1.3");
}
#[test]
fn the_same_version_with_an_older_date_is_refused() {
    let mut s = UpdateSettings::default();
    s.accept_feed(&release_at("0.1.2", "2026-10-12")).unwrap();
    assert_eq!(
        s.accept_feed(&release_at("0.1.2", "2026-10-11")),
        Err(UpdateError::Manifest)
    );
    assert_eq!(s.last_seen.as_ref().unwrap().date, "2026-10-12");
}
#[test]
fn newer_equal_and_first_feeds_are_accepted() {
    let mut s = UpdateSettings::default();
    s.accept_feed(&release_at("0.1.1", "2026-10-10")).unwrap();
    // The same feed again, a re-dated feed of the same version, and a newer version all pass.
    s.accept_feed(&release_at("0.1.1", "2026-10-10")).unwrap();
    s.accept_feed(&release_at("0.1.1", "2026-10-13")).unwrap();
    assert_eq!(s.last_seen.as_ref().unwrap().date, "2026-10-13");
    s.accept_feed(&release_at("0.1.2", "2026-10-09")).unwrap();
    assert_eq!(s.last_seen.as_ref().unwrap().version.to_string(), "0.1.2");
    // Build metadata is no different release, so it cannot roll anything back either.
    s.accept_feed(&release_at("0.1.2+rebuilt", "2026-10-09"))
        .unwrap();
}
#[test]
fn feeds_of_another_channel_are_not_compared() {
    let mut s = UpdateSettings::default();
    let mut beta = release_at("0.2.0-beta.1", "2026-10-12");
    beta.channel = Channel::Beta;
    s.accept_feed(&beta).unwrap();
    // Leaving beta: the stable feed is lower than the beta seen, and still legitimate.
    s.accept_feed(&release_at("0.1.1", "2026-10-10")).unwrap();
    assert_eq!(s.last_seen.as_ref().unwrap().channel, Channel::Stable);
}
#[test]
fn the_last_seen_feed_survives_a_restart_and_old_settings_still_load() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = UpdateSettings::default();
    s.accept_feed(&release_at("0.1.3", "2026-10-12")).unwrap();
    save_settings(dir.path(), &s).unwrap();
    let mut loaded = load_settings(dir.path()).unwrap();
    assert_eq!(
        loaded.accept_feed(&release_at("0.1.2", "2026-10-12")),
        Err(UpdateError::Manifest)
    );
    // A settings file written before the record existed has no `lastSeen` and loads unchanged.
    std::fs::write(dir.path().join("updates.json"), br#"{"held":true}"#).unwrap();
    let old = load_settings(dir.path()).unwrap();
    assert!(old.held && old.last_seen.is_none());
}

#[test]
fn only_one_install_owns_the_slot_and_the_owner_lock_stays_free() {
    use plur1bus_desktop::update_commands::UpdateState;
    let state = UpdateState::default();
    let token = {
        let owner = state.0.try_lock().unwrap();
        owner
            .begin_install()
            .expect("first install claims the slot")
    };
    // While the (simulated) download runs, nothing holds the owner lock: settings, reminders
    // and checks can take it, and they see the install in flight.
    {
        let owner = state
            .0
            .try_lock()
            .expect("owner lock is not held by an install");
        assert!(owner.installing());
        assert!(owner.begin_install().is_none());
    }
    drop(token);
    let owner = state.0.try_lock().unwrap();
    assert!(!owner.installing());
    assert!(owner.begin_install().is_some());
}
#[test]
fn download_progress_reports_once_per_percent_and_clamps_a_wrong_length() {
    let mut progress = DownloadProgress::default();
    // 1000 bytes in chunks of 5: one report for each percent step, never one per chunk.
    let reports: Vec<_> = (0..200)
        .filter_map(|_| progress.chunk(5, Some(1000)))
        .collect();
    assert_eq!(reports.len(), 101);
    assert_eq!(reports.first(), Some(&(5, Some(1000))));
    assert_eq!(reports.last(), Some(&(1000, Some(1000))));
    assert!(reports.windows(2).all(|pair| pair[0].0 < pair[1].0));
    // A server that sends more than it announced still ends at the last bucket, once.
    let mut wrong = DownloadProgress::default();
    assert!(wrong.chunk(900, Some(100)).is_some());
    assert!(wrong.chunk(900, Some(100)).is_none());
}
#[test]
fn download_progress_without_a_length_reports_per_512_kib_and_never_a_total() {
    let mut progress = DownloadProgress::default();
    assert_eq!(progress.chunk(1024, None), Some((1024, None)));
    assert_eq!(progress.chunk(1024, None), None);
    assert_eq!(
        progress.chunk(0, Some(0)),
        None,
        "a zero length counts as unknown"
    );
    assert_eq!(
        progress.chunk(512 * 1024, None),
        Some((1024 + 1024 + 512 * 1024, None))
    );
}
