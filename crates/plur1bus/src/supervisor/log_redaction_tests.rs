//! Behavior checks for the shared Supervisor configuration registry and bounded byte-stream redaction.
use super::*;
use serde_json::json;

fn config(secret: &str) -> Value {
    json!({"channels":{"telegram":{"webhook":{"secret":secret}}}})
}

fn text(registry: &Registry, input: &str) -> String {
    registry
        .with_matcher(|matcher| {
            let mut value = json!(input);
            matcher.redact_value(&mut value)?;
            Ok(value.as_str().unwrap().to_string())
        })
        .unwrap()
}

#[test]
fn reference_names_remain_readable_metadata_while_literals_and_url_parts_stay_masked() {
    let directory = tempfile::tempdir().unwrap();
    let layout = Layout::new(directory.path().to_path_buf());
    let first = uuid::Uuid::new_v4().to_string();
    let second = uuid::Uuid::new_v4().to_string();
    let provider = format!(
        "public-{}",
        &uuid::Uuid::new_v4().simple().to_string()[..12]
    );
    let id = uuid::Uuid::new_v4().to_string();
    let literal = uuid::Uuid::new_v4().to_string();
    let user = uuid::Uuid::new_v4().to_string();
    let query = uuid::Uuid::new_v4().to_string();
    let endpoint = format!("https://{user}:{literal}@relay.example.test/public?ordinary={query}");
    let configured = json!({
        "channels":{"telegram":{"tokenSecret":first}},
        "voice":{"providers":{"elevenlabs":{"apiKeyRef":second,"baseUrl":endpoint}}},
        "engine":{"embedding":{"apiKey":{"source":"store","provider":provider,"id":id}},
            "reranker":{"apiKey":literal}}
    });
    let public = plur1bus_config::redact_config(&configured);
    assert_eq!(public["channels"]["telegram"]["tokenSecret"], first);
    assert_eq!(public["engine"]["embedding"]["apiKey"]["id"], id);
    let registry = Registry::new();
    registry.replace_config(&layout, &configured);
    let metadata = format!("names {first} {second} provider={provider} id={id} present=true literal={literal} endpoint={endpoint}");
    let masked = text(&registry, &metadata);
    for reference in [&first, &second, &provider, &id] {
        assert!(
            masked.contains(reference),
            "reference provisioning metadata was hidden"
        );
    }
    for secret in [&literal, &user, &query] {
        assert!(
            !masked.contains(secret),
            "a literal or URL credential escaped text redaction"
        );
    }
    assert!(masked.contains("relay.example.test/public"));
    assert!(masked.contains("present=true"));
}

#[test]
fn a_literal_equal_to_a_reference_name_is_still_registered_for_text_masking() {
    let directory = tempfile::tempdir().unwrap();
    let layout = Layout::new(directory.path().to_path_buf());
    let shared = uuid::Uuid::new_v4().to_string();
    let registry = Registry::new();
    registry.replace_config(
        &layout,
        &json!({
            "channels":{"telegram":{"tokenSecret":shared}},
            "engine":{"embedding":{"apiKey":shared}}
        }),
    );
    assert_eq!(text(&registry, &shared), "[REDACTED:secret]");
}

#[test]
fn literal_encodings_and_json_escaped_unicode_are_masked_without_trimming_values() {
    let directory = tempfile::tempdir().unwrap();
    let layout = Layout::new(directory.path().to_path_buf());
    let secret = format!("  quoted-{}-é\"\n  ", std::process::id());
    let registry = Registry::new();
    registry.replace_config(&layout, &config(&secret));
    let mut variants = known_secret_forms(&secret);
    let encoded = serde_json::to_string(&secret).unwrap();
    variants.push(encoded[1..encoded.len() - 1].to_string());
    for variant in variants {
        assert_eq!(text(&registry, &variant), "[REDACTED:secret]");
    }
    assert_eq!(
        text(&registry, secret.trim()),
        secret.trim(),
        "the exact value includes surrounding spaces"
    );
    assert_eq!(
        text(&registry, "https://api.openai.com/v1"),
        "https://api.openai.com/v1"
    );
}

#[test]
fn stream_masks_every_split_and_preserves_public_unicode_and_non_utf8_bytes() {
    let directory = tempfile::tempdir().unwrap();
    let layout = Layout::new(directory.path().to_path_buf());
    let secret = format!("literal-é-{}", std::process::id());
    let registry = Registry::new();
    registry.replace_config(&layout, &config(&secret));
    let input = format!("before🦀{secret}after漢字 https://api.openai.com/v1");
    let expected = "before🦀[REDACTED:secret]after漢字 https://api.openai.com/v1";
    for chunk_size in 1..=input.len() {
        let mut stream = Stream::default();
        let mut output = Vec::new();
        registry
            .with_matcher(|matcher| {
                for chunk in input.as_bytes().chunks(chunk_size) {
                    let bytes = stream.redact(chunk, false, matcher);
                    assert!(std::str::from_utf8(&bytes).is_ok(), "a write split UTF-8");
                    output.extend(bytes);
                    assert!(stream.pending.len() <= MAX_MATCH_BYTES + UTF8_SUFFIX_BYTES);
                }
                output.extend(stream.redact(&[], true, matcher));
                Ok(())
            })
            .unwrap();
        assert_eq!(
            String::from_utf8(output).unwrap(),
            expected,
            "read size {chunk_size}"
        );
    }
    let mut stream = Stream::default();
    let output = registry
        .with_matcher(|matcher| Ok(stream.redact(b"\xff\x00\x80", true, matcher)))
        .unwrap();
    assert_eq!(output, b"\xff\x00\x80");
}

#[test]
fn long_lines_flush_with_a_bounded_suffix_and_eof_flushes_the_tail() {
    let directory = tempfile::tempdir().unwrap();
    let layout = Layout::new(directory.path().to_path_buf());
    let secret = format!("literal-{}", std::process::id());
    let registry = Registry::new();
    registry.replace_config(&layout, &config(&secret));
    let mut stream = Stream::default();
    let mut written = 0;
    registry
        .with_matcher(|matcher| {
            for _ in 0..512 {
                written += stream.redact(&[b'.'; 8192], false, matcher).len();
                assert!(stream.pending.len() <= matcher.longest() + UTF8_SUFFIX_BYTES);
            }
            assert!(
                written > 4_000_000,
                "line buffering must not delay public output until EOF"
            );
            written += stream.redact(&[], true, matcher).len();
            assert!(stream.pending.is_empty());
            Ok(())
        })
        .unwrap();
    assert_eq!(written, 512 * 8192);
}

#[test]
fn small_public_writes_flush_now_and_only_possible_secret_prefixes_wait() {
    let directory = tempfile::tempdir().unwrap();
    let layout = Layout::new(directory.path().to_path_buf());
    let secret = format!("pending-{}-private", std::process::id());
    let registry = Registry::new();
    registry.replace_config(&layout, &config(&secret));
    let mut stream = Stream::default();
    registry
        .with_matcher(|matcher| {
            assert_eq!(
                stream.redact(b"small public output\n", false, matcher),
                b"small public output\n"
            );
            let first = format!("public {}", &secret[..8]);
            assert_eq!(stream.redact(first.as_bytes(), false, matcher), b"public ");
            assert_eq!(stream.pending, secret.as_bytes()[..8]);
            let rest = format!("{}\n", &secret[8..]);
            assert_eq!(
                stream.redact(rest.as_bytes(), false, matcher),
                b"[REDACTED:secret]\n"
            );
            assert!(stream.pending.is_empty());
            Ok(())
        })
        .unwrap();
}

#[test]
fn a_valid_running_snapshot_restores_logging_after_invalid_startup_json() {
    let directory = tempfile::tempdir().unwrap();
    let layout = Layout::new(directory.path().to_path_buf());
    let registry = Registry::new();
    registry.replace_bytes(&layout, b"{");
    assert_eq!(registry.with_matcher(|_| Ok(())), Err(Unavailable::Config));
    let secret = format!("recovered-{}", std::process::id());
    registry.replace_config(&layout, &config(&secret));
    assert_eq!(text(&registry, &secret), "[REDACTED:secret]");
}

#[test]
fn byte_matching_agrees_with_a_naive_oracle_for_overlapping_and_failed_prefixes() {
    let values = ["aaaa", "aaab", "bab"].map(String::from);
    let matcher = Matchers(vec![Arc::new(Matcher::build(values.iter()).unwrap())]);
    for length in 0..=7u32 {
        for mut variant in 0..3usize.pow(length) {
            let input: Vec<u8> = (0..length)
                .map(|_| {
                    let byte = b"abx"[variant % 3];
                    variant /= 3;
                    byte
                })
                .collect();
            let mut covered = vec![false; input.len()];
            for start in 0..input.len() {
                for value in &values {
                    if input[start..].starts_with(value.as_bytes()) {
                        covered[start..start + value.len()].fill(true);
                    }
                }
            }
            let mut expected = Vec::new();
            for (index, byte) in input.iter().enumerate() {
                if !covered[index] {
                    expected.push(*byte);
                } else if index == 0 || !covered[index - 1] {
                    expected.extend_from_slice(MARKER);
                }
            }
            let (actual, consumed) = matcher.prefix(&input, input.len());
            assert_eq!(consumed, input.len());
            let mut actual = String::from_utf8(actual).unwrap();
            // Adjacent matches may have separate markers; the oracle compares the bytes hidden by their union.
            let adjacent = "[REDACTED:secret][REDACTED:secret]";
            while actual.contains(adjacent) {
                actual = actual.replace(adjacent, "[REDACTED:secret]");
            }
            assert_eq!(actual.as_bytes(), expected, "input {input:?}");
        }
    }
}

#[test]
fn current_values_and_the_newest_256_retired_values_are_kept() {
    let directory = tempfile::tempdir().unwrap();
    let layout = Layout::new(directory.path().to_path_buf());
    let registry = Registry::new();
    let first = format!("rotation-{}-000", std::process::id());
    registry.replace_config(&layout, &config(&first));
    for index in 1..=MAX_RETIRED_VALUES + 1 {
        registry.replace_config(
            &layout,
            &config(&format!("rotation-{}-{index:03}", std::process::id())),
        );
    }
    assert_eq!(
        text(&registry, &first),
        first,
        "the oldest unpinned value is evicted"
    );
    assert_eq!(
        text(&registry, &format!("rotation-{}-001", std::process::id())),
        "[REDACTED:secret]"
    );
    assert_eq!(
        text(&registry, &format!("rotation-{}-257", std::process::id())),
        "[REDACTED:secret]"
    );
    assert_eq!(
        registry.state.lock().unwrap().retired.len(),
        MAX_RETIRED_VALUES
    );
}

#[test]
fn an_active_generation_keeps_its_original_values_after_retirement_eviction_until_eof() {
    let directory = tempfile::tempdir().unwrap();
    let layout = Layout::new(directory.path().to_path_buf());
    let registry = Registry::new();
    let first = format!("generation-{}-original", std::process::id());
    registry.replace_config(&layout, &config(&first));
    let generation = registry.pin().unwrap();
    for index in 0..=MAX_RETIRED_VALUES {
        registry.replace_config(
            &layout,
            &config(&format!("generation-{}-{index:03}", std::process::id())),
        );
    }
    assert!(!registry.state.lock().unwrap().retired.contains(&first));
    assert_eq!(text(&registry, &first), "[REDACTED:secret]");
    drop(generation);
    assert_eq!(
        text(&registry, &first),
        first,
        "a closed generation must release its pin"
    );
}

#[test]
fn unstructured_matching_retains_the_eight_byte_minimum_and_never_registers_url_hosts() {
    let directory = tempfile::tempdir().unwrap();
    let layout = Layout::new(directory.path().to_path_buf());
    let registry = Registry::new();
    let mut value = config("abcdefg");
    value["voice"] = json!({"providers":{"elevenlabs":{"baseUrl":"https://api.openai.com/v1?ordinary=abcdefg"}}});
    registry.replace_config(&layout, &value);
    assert_eq!(
        text(&registry, "abcdefg https://api.openai.com/v1"),
        "abcdefg https://api.openai.com/v1"
    );
    assert_eq!(
        plur1bus_config::redact_config(&value)["channels"]["telegram"]["webhook"]["secret"],
        "••••"
    );
}

#[test]
fn missing_policy_and_matcher_capacity_withhold_output_until_restart() {
    let directory = tempfile::tempdir().unwrap();
    let layout = Layout::new(directory.path().to_path_buf());
    std::fs::create_dir_all(layout.home.join("modules/fixture")).unwrap();
    let registry = Registry::new();
    registry.replace_config(
        &layout,
        &json!({"modules":{"fixture":{"ordinary":"unavailable"}}}),
    );
    assert_eq!(
        registry.with_matcher(|_| Ok(())),
        Err(Unavailable::Metadata)
    );
    registry.replace_config(&layout, &config("repaired-value"));
    assert_eq!(
        registry.with_matcher(|_| Ok(())),
        Err(Unavailable::Metadata),
        "unclassified history requires restart"
    );
    let registry = Registry::new();
    registry.replace_config(&layout, &config(&"x".repeat(MAX_MATCH_BYTES + 1)));
    assert_eq!(
        registry.with_matcher(|_| Ok(())),
        Err(Unavailable::Capacity)
    );
}

#[test]
fn a_poisoned_registry_refuses_the_original_payload() {
    let registry = Registry::new();
    let _ = std::panic::catch_unwind(|| {
        let _state = registry.state.lock().unwrap();
        panic!("poison the registry for this test");
    });
    let mut called = false;
    assert_eq!(
        registry.with_matcher(|_| {
            called = true;
            Ok(())
        }),
        Err(Unavailable::Poisoned)
    );
    assert!(
        !called,
        "an unavailable registry must never hand the payload to the writer"
    );
}

#[test]
fn structured_logs_mask_nested_values_before_serialization_and_rotation() {
    let directory = tempfile::tempdir().unwrap();
    let layout = Layout::new(directory.path().to_path_buf());
    let first = format!("first-{}-é\"\n", std::process::id());
    std::fs::write(layout.config_path(), config(&first).to_string()).unwrap();
    let log = super::super::Log::open(&layout, 300, 8);
    log.info(
        "nested value",
        json!({"items":[{"ordinary":first}],"count":4096}),
    );
    let second = format!("second-{}-é\"\n", std::process::id());
    log.register_config(&layout, &config(&second));
    for _ in 0..4 {
        log.info(
            &first,
            json!({"ordinary":second, "public":"https://api.openai.com/v1"}),
        );
    }
    assert!(
        layout.logs().join("supervisor.log.1").exists(),
        "rotation was not exercised"
    );
    let mut records = Vec::new();
    for entry in std::fs::read_dir(layout.logs()).unwrap() {
        let bytes = std::fs::read_to_string(entry.unwrap().path()).unwrap();
        records.extend(
            bytes
                .lines()
                .map(|line| serde_json::from_str::<Value>(line).unwrap()),
        );
    }
    assert_eq!(records.len(), 5);
    let nested = records
        .iter()
        .find(|record| record["msg"] == "nested value")
        .unwrap();
    assert_eq!(nested["count"], 4096);
    assert_eq!(nested["items"][0]["ordinary"], "[REDACTED:secret]");
    for record in records {
        if record["msg"] == "nested value" {
            continue;
        }
        assert_eq!(record["msg"], "[REDACTED:secret]");
        assert_eq!(record["ordinary"], "[REDACTED:secret]");
        assert_eq!(record["public"], "https://api.openai.com/v1");
    }
}
