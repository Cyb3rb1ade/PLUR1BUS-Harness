// Tests fail immediately on invalid fixtures or failed cleanup; no unchecked values reach production.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use plur1bus_engine::embedding::{seam::FlatEmbedder, Cancel, EmbedKind, EmbeddingProvider};
use plur1bus_engine::rpc::seams::{from_env, parse, Seam, SeamError};
use std::{
    process::Command,
    sync::Arc,
    time::{Duration, Instant},
};

const CHILD: &str = "PLUR1BUS_SEAM_TEST_CHILD";

fn env_case(variant: Option<&str>, allow: Option<&str>, expected: &str) {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            std::any::type_name_of_val(&environment_reader_fixture)
                .split_once("::")
                .map_or("", |(_, name)| name),
            "--nocapture",
        ])
        .env(CHILD, expected)
        .env_remove("PLUR1BUS_TEST_INTERNALS")
        .env_remove("PLUR1BUS_ALLOW_TEST_INTERNALS");
    if let Some(variant) = variant {
        command.env("PLUR1BUS_TEST_INTERNALS", variant);
    }
    if let Some(allow) = allow {
        command.env("PLUR1BUS_ALLOW_TEST_INTERNALS", allow);
    }
    let output = command.output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
}

#[test]
fn environment_reader_fixture() {
    let Ok(expected) = std::env::var(CHILD) else {
        return;
    };
    match expected.as_str() {
        "absent" => assert_eq!(from_env().unwrap(), None),
        "flat" => assert_eq!(from_env().unwrap(), Some(Seam::FlatEmbedder)),
        "cold" => assert_eq!(from_env().unwrap(), Some(Seam::FlatEmbedderCold)),
        "hash" => assert_eq!(from_env().unwrap(), Some(Seam::HashEmbedder)),
        "denied" => assert!(from_env()
            .unwrap_err()
            .to_string()
            .contains("PLUR1BUS_ALLOW_TEST_INTERNALS=1")),
        "unknown" => assert!(from_env().is_err()),
        _ => panic!("invalid fixture expectation"),
    }
}

#[test]
fn flat_embedder_is_refused_without_the_allow_flag() {
    env_case(Some("flat-embedder"), None, "denied");
    env_case(Some("flat-embedder-cold"), Some("true"), "denied");
}

#[test]
fn only_known_variants_are_enabled_with_the_explicit_allow_flag() {
    env_case(None, None, "absent");
    env_case(Some("flat-embedder"), Some("1"), "flat");
    env_case(Some("flat-embedder-cold"), Some("1"), "cold");
    env_case(Some("hash-embedder"), Some("1"), "hash");
    env_case(Some("unknown-private-value"), Some("1"), "unknown");
}

#[test]
fn flat_embedder_cold_delays_the_first_two_query_embeds_one_at_a_time() {
    let fixture = FlatEmbedder::new(3, false);
    let provider = Arc::new(
        Seam::FlatEmbedderCold
            .embedder(3, fixture.identity())
            .unwrap(),
    );
    let passage_start = Instant::now();
    assert_eq!(
        provider
            .embed(&["passage".into()], EmbedKind::Passage, &Cancel::never())
            .unwrap(),
        vec![vec![1.0, 0.0, 0.0]]
    );
    let passage = passage_start.elapsed();
    let started = Instant::now();
    let calls: Vec<_> = (0..2)
        .map(|_| {
            let provider = provider.clone();
            std::thread::spawn(move || {
                provider
                    .embed(&["query".into()], EmbedKind::Query, &Cancel::never())
                    .unwrap()
            })
        })
        .collect();
    for call in calls {
        assert_eq!(call.join().unwrap(), vec![vec![1.0, 0.0, 0.0]]);
    }
    let cold = started.elapsed();
    assert!(cold >= Duration::from_millis(690));
    let warm_start = Instant::now();
    provider
        .embed(&["warm".into()], EmbedKind::Query, &Cancel::never())
        .unwrap();
    let warm = warm_start.elapsed();
    assert!(
        cold.saturating_sub(passage + warm) >= Duration::from_millis(400),
        "serialized cold queries {cold:?}, passage {passage:?}, warm query {warm:?}"
    );
}

#[test]
fn explicit_cli_seams_require_authorization_and_never_echo_invalid_names() {
    assert_eq!(parse("flat-embedder", false), Err(SeamError::NotAllowed));
    assert_eq!(parse("flat-embedder", true), Ok(Seam::FlatEmbedder));
    assert_eq!(
        parse("flat-embedder-cold", true),
        Ok(Seam::FlatEmbedderCold)
    );
    let error = parse("private-invalid-seam", true).unwrap_err();
    assert_eq!(error, SeamError::UnknownVariant);
    assert!(!error.to_string().contains("private-invalid-seam"));
}
