//! Integration-level hardening of the helper's wire protocol (`plur1bus_attest::protocol`, `mapping`, `run_attest`).
//!
//! What this crate does NOT do, and therefore what is not tested here: it holds no keys, signs and verifies nothing, compares no
//! secret or MAC and has no expiry clock. Nonce, action hash, single use and the 60 s window are enforced by the core
//! (`packages/core/src/attestation/`); the helper only echoes the nonce and action hash. The one time-dependent field of a reply is
//! `at`, which `reply_line` takes as a parameter, so it is tested directly with fixed values.
//!
//! These tests never reach a real operating system dialog: `run_attest` is driven with a fake `Platform`.
use plur1bus_attest::mapping;
use plur1bus_attest::platform::Platform;
use plur1bus_attest::protocol::{
    clean_text, error_line, parse_request, probe_line, reply_line, Outcome, Probe, ProtocolError,
    Request, MAX_TTL_MS,
};
use plur1bus_attest::{run_attest, run_probe};
use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::Duration;

const HASH: &str = "abababababababababababababababababababababababababababababababab";
const SEED: u64 = 0x5eed_a77e_5700_0001;

fn valid_line() -> String {
    format!(
        r#"{{"v":1,"nonce":"n-1","actionHash":"{HASH}","text":"Allow agent bernd","ttlMs":60000}}"#
    )
}

/// mulberry32, the generator the repo's other generative tests use. Deterministic; the seed is printed in every assertion message.
struct Rng(u32);
impl Rng {
    fn new(seed: u64) -> Self {
        Rng((seed ^ (seed >> 32)) as u32)
    }
    fn next(&mut self) -> u32 {
        self.0 = self.0.wrapping_add(0x6D2B_79F5);
        let mut t = self.0;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        t ^ (t >> 14)
    }
    fn below(&mut self, n: u32) -> u32 {
        self.next() % n
    }
    fn pick<'a>(&mut self, items: &'a [&'a str]) -> &'a str {
        items[self.below(items.len() as u32) as usize]
    }
}

struct Fake {
    probe: Probe,
    outcome: Outcome,
    asked: Mutex<u32>,
}
impl Fake {
    fn new(probe: Probe, outcome: Outcome) -> Self {
        Fake {
            probe,
            outcome,
            asked: Mutex::new(0),
        }
    }
    fn available(outcome: Outcome) -> Self {
        Fake::new(
            Probe::Available {
                method: "touch-id".into(),
            },
            outcome,
        )
    }
    fn asked(&self) -> u32 {
        *self.asked.lock().unwrap()
    }
}
impl Platform for Fake {
    fn probe(&self) -> Probe {
        self.probe.clone()
    }
    fn confirm(&self, _text: &str, _ttl: Duration) -> Outcome {
        *self.asked.lock().unwrap() += 1;
        self.outcome.clone()
    }
}

// ---------- parse_request: success, then manipulation at every field ----------

#[test]
fn a_valid_request_is_accepted_with_every_field_carried_over() {
    let r = parse_request(&valid_line()).unwrap();
    assert_eq!(
        r,
        Request {
            nonce: "n-1".into(),
            action_hash: HASH.into(),
            text: "Allow agent bernd".into(),
            ttl: Duration::from_millis(60_000),
        }
    );
}

#[test]
fn surrounding_whitespace_and_the_line_terminator_are_ignored_but_nothing_else() {
    for wrap in ["{}", " {} ", "\t{}\r\n", "{}\n"] {
        let line = wrap.replace("{}", &valid_line());
        assert!(parse_request(&line).is_ok(), "{wrap:?}");
    }
}

#[test]
fn a_request_cut_off_at_any_byte_is_refused_and_never_panics() {
    let line = valid_line();
    for cut in 0..line.len() {
        // The line is ASCII, so every prefix is valid UTF-8.
        let r = parse_request(&line[..cut]);
        assert!(
            r.is_err(),
            "prefix of {cut} bytes was accepted: {:?}",
            &line[..cut]
        );
    }
    assert!(parse_request(&line).is_ok());
}

#[test]
fn zero_length_and_blank_input_is_malformed() {
    for s in ["", " ", "\n", "\r\n", "\t\t"] {
        assert_eq!(parse_request(s), Err(ProtocolError::Malformed), "{s:?}");
    }
}

#[test]
fn a_duplicate_field_is_malformed_not_last_one_wins() {
    let dup = format!(
        r#"{{"v":1,"nonce":"n-1","nonce":"n-2","actionHash":"{HASH}","text":"t","ttlMs":5000}}"#
    );
    assert_eq!(parse_request(&dup), Err(ProtocolError::Malformed));
    let dup_v =
        format!(r#"{{"v":1,"v":1,"nonce":"n-1","actionHash":"{HASH}","text":"t","ttlMs":5000}}"#);
    assert_eq!(parse_request(&dup_v), Err(ProtocolError::Malformed));
}

#[test]
fn a_missing_field_is_malformed_for_each_field() {
    for missing in ["v", "nonce", "actionHash", "text", "ttlMs"] {
        let mut v: Value = serde_json::from_str(&valid_line()).unwrap();
        v.as_object_mut().unwrap().remove(missing);
        assert_eq!(
            parse_request(&v.to_string()),
            Err(ProtocolError::Malformed),
            "without {missing}"
        );
    }
}

#[test]
fn an_unknown_field_is_malformed_whatever_its_value() {
    for extra in [
        r#""extra":1"#,
        r#""extra":null"#,
        r#""extra":{"a":[1,2,3]}"#,
        r#""NONCE":"n-2""#, // names are case sensitive: this is an unknown field, not the nonce
    ] {
        let line = valid_line().replace('}', &format!(",{extra}}}"));
        assert_eq!(
            parse_request(&line),
            Err(ProtocolError::Malformed),
            "{extra}"
        );
    }
}

#[test]
fn field_names_are_case_sensitive() {
    let line = valid_line().replace("actionHash", "actionhash");
    assert_eq!(parse_request(&line), Err(ProtocolError::Malformed));
    let line = valid_line().replace("ttlMs", "ttlms");
    assert_eq!(parse_request(&line), Err(ProtocolError::Malformed));
}

#[test]
fn wrong_json_types_are_malformed() {
    let base: Value = serde_json::from_str(&valid_line()).unwrap();
    let wrong: [(&str, Value); 12] = [
        ("v", json!("1")),
        ("v", json!(1.5)),
        ("v", json!(null)),
        ("nonce", json!(7)),
        ("nonce", json!(["n"])),
        ("actionHash", json!(HASH.len())),
        ("actionHash", json!(null)),
        ("text", json!(null)),
        ("text", json!({ "a": 1 })),
        ("ttlMs", json!("5000")),
        ("ttlMs", json!(true)),
        ("ttlMs", json!(null)),
    ];
    for (field, value) in wrong {
        let mut v = base.clone();
        v[field] = value.clone();
        assert_eq!(
            parse_request(&v.to_string()),
            Err(ProtocolError::Malformed),
            "{field} = {value}"
        );
    }
}

#[test]
fn json_that_is_not_an_object_is_malformed() {
    for s in ["[]", "null", "1", "\"x\"", "true", "[{}]"] {
        assert_eq!(parse_request(s), Err(ProtocolError::Malformed), "{s}");
    }
}

#[test]
fn only_version_one_is_accepted() {
    for v in ["0", "2", "4294967295"] {
        let line = valid_line().replace(r#""v":1"#, &format!(r#""v":{v}"#));
        assert_eq!(parse_request(&line), Err(ProtocolError::Version), "v={v}");
    }
    // Outside u32 the field is no longer a version at all.
    for v in ["-1", "4294967296", "18446744073709551616"] {
        let line = valid_line().replace(r#""v":1"#, &format!(r#""v":{v}"#));
        assert_eq!(parse_request(&line), Err(ProtocolError::Malformed), "v={v}");
    }
}

#[test]
fn nonce_must_be_printable_ascii_without_space_and_at_most_128_bytes() {
    let with = |n: &str| valid_line().replace("n-1", n);
    assert!(parse_request(&with(&"n".repeat(128))).is_ok());
    assert_eq!(
        parse_request(&with(&"n".repeat(129))),
        Err(ProtocolError::BadNonce)
    );
    for bad in [
        "a b",
        "a\\u0000b",
        "a\\nb",
        "a\\tb",
        "\\u007f",
        "caf\\u00e9",
        "\\u202e",
        "\\ud83d\\ude00",
    ] {
        assert_eq!(
            parse_request(&with(bad)),
            Err(ProtocolError::BadNonce),
            "{bad}"
        );
    }
    // Every printable ASCII character is allowed, including the ones that need JSON escaping.
    assert!(parse_request(&with(r#"a\"b\\c/d~!"#)).is_ok());
}

#[test]
fn action_hash_must_be_exactly_64_lowercase_hex_digits() {
    let with = |h: &str| valid_line().replace(HASH, h);
    for len in [0usize, 1, 63, 65, 128] {
        assert_eq!(
            parse_request(&with(&"a".repeat(len))),
            Err(ProtocolError::BadHash),
            "len {len}"
        );
    }
    // One bad character at every position of an otherwise valid hash.
    for pos in 0..64 {
        for bad in ['g', 'A', 'F', ' ', '-', 'z'] {
            let mut h: Vec<char> = HASH.chars().collect();
            h[pos] = bad;
            let h: String = h.into_iter().collect();
            assert_eq!(
                parse_request(&with(&h)),
                Err(ProtocolError::BadHash),
                "{bad:?} at {pos}"
            );
        }
    }
    assert!(parse_request(&with(&"0123456789abcdef".repeat(4))).is_ok());
}

#[test]
fn ttl_must_be_between_one_and_the_maximum() {
    let with = |t: &str| valid_line().replace("60000", t);
    assert_eq!(MAX_TTL_MS, 60_000);
    assert_eq!(
        parse_request(&with("1")).unwrap().ttl,
        Duration::from_millis(1)
    );
    for bad in ["0", "60001", "18446744073709551615"] {
        assert_eq!(
            parse_request(&with(bad)),
            Err(ProtocolError::BadTtl),
            "{bad}"
        );
    }
    // Not an unsigned 64-bit integer at all.
    for bad in [
        "-1",
        "1.5",
        "1e3",
        "60000.0",
        "18446744073709551616",
        "99999999999999999999999999",
    ] {
        assert_eq!(
            parse_request(&with(bad)),
            Err(ProtocolError::Malformed),
            "{bad}"
        );
    }
}

#[test]
fn an_oversized_text_is_accepted_and_bounded_to_300_characters() {
    for len in [300usize, 301, 1_000, 1_000_000, 4_000_000] {
        let line = valid_line().replace("Allow agent bernd", &"x".repeat(len));
        let r = parse_request(&line).unwrap();
        assert_eq!(r.text.chars().count(), len.min(300), "len {len}");
    }
}

#[test]
fn an_oversized_nonce_or_hash_is_refused() {
    let big = "n".repeat(5_000_000);
    assert_eq!(
        parse_request(&valid_line().replace("n-1", &big)),
        Err(ProtocolError::BadNonce)
    );
    let big = "a".repeat(5_000_000);
    assert_eq!(
        parse_request(&valid_line().replace(HASH, &big)),
        Err(ProtocolError::BadHash)
    );
}

#[test]
fn deep_nesting_is_an_error_and_not_a_stack_overflow() {
    let depth = 1000;
    let arrays = format!("{}{}", "[".repeat(depth), "]".repeat(depth));
    let objects = format!("{}1{}", r#"{"a":"#.repeat(depth), "}".repeat(depth));
    for nested in [&arrays, &objects] {
        // As the whole document, as an unknown field and as the value of a known field.
        assert!(parse_request(nested).is_err());
        let as_unknown = valid_line().replace('}', &format!(r#","extra":{nested}}}"#));
        assert!(parse_request(&as_unknown).is_err());
        let as_text = valid_line().replace(r#""Allow agent bernd""#, nested);
        assert!(parse_request(&as_text).is_err());
    }
    // Unclosed nesting too.
    assert!(parse_request(&"[".repeat(100_000)).is_err());
}

#[test]
fn invalid_escapes_and_lone_surrogates_in_a_string_are_malformed() {
    for text in [r"\ud800", r"\udc00", r"\ud800A", r"\x41", r"\u12", r"\"] {
        let line = valid_line().replace("Allow agent bernd", text);
        assert_eq!(
            parse_request(&line),
            Err(ProtocolError::Malformed),
            "{text}"
        );
    }
}

#[test]
fn a_nul_in_the_text_is_accepted_and_removed_from_the_dialog_text() {
    let line = valid_line().replace("Allow agent bernd", r"Allow\u0000agent");
    assert_eq!(parse_request(&line).unwrap().text, "Allow agent");
}

// ---------- clean_text ----------

#[test]
fn clean_text_removes_every_ascii_and_c1_control_character_and_squeezes_blanks() {
    for c in (0u32..=0x1f).chain(0x7f..=0x9f) {
        let ch = char::from_u32(c).unwrap();
        let cleaned = clean_text(&format!("a{ch}b"));
        assert_eq!(cleaned, "a b", "U+{c:04X}");
        assert!(!cleaned.chars().any(char::is_control));
    }
    assert_eq!(clean_text("  a \t\n  b  "), "a b");
    assert_eq!(clean_text(""), "");
    assert_eq!(clean_text("\u{1b}\u{7}\n"), "");
}

#[test]
fn clean_text_bounds_by_characters_not_bytes_and_never_splits_a_character() {
    let s = "ä".repeat(1000);
    let cleaned = clean_text(&s);
    assert_eq!(cleaned.chars().count(), 300);
    assert!(cleaned.len() > 300);
    let emoji = "😀".repeat(1000);
    assert_eq!(clean_text(&emoji).chars().count(), 300);
}

#[test]
fn clean_text_is_idempotent_and_bounded_for_random_input() {
    let mut rng = Rng::new(SEED);
    let alphabet: Vec<char> = "ab \t\n\r\u{1b}\u{0}\u{85}\u{a0}\u{2028}äö😀\u{202e}\u{200b}Z"
        .chars()
        .collect();
    for case in 0..500 {
        let len = rng.below(800) as usize;
        let s: String = (0..len)
            .map(|_| alphabet[rng.below(alphabet.len() as u32) as usize])
            .collect();
        let once = clean_text(&s);
        assert!(
            once.chars().count() <= 300,
            "seed {SEED:#x} case {case}: {} chars",
            once.chars().count()
        );
        assert!(
            !once.chars().any(char::is_control),
            "seed {SEED:#x} case {case}: control character left"
        );
        assert_eq!(
            clean_text(&once),
            once,
            "seed {SEED:#x} case {case}: not idempotent"
        );
    }
}

/// SICHERHEIT: `clean_text` removes `char::is_control()` (category Cc) only. Bidirectional overrides and isolates, zero-width
/// characters and the byte order mark are category Cf: they pass through into the text the operating system shows in its
/// confirmation dialog, where an override (U+202E) can visually reorder what the person is asked to approve. Stripping them
/// changes what the dialog shows (a security behaviour), so it is not fixed here.
#[test]
#[ignore = "KNOWN GAP: clean_text keeps Unicode format characters (bidi override U+202E, isolates, zero-width, BOM) in the OS dialog text"]
fn clean_text_removes_bidi_overrides_and_invisible_format_characters() {
    for ch in [
        '\u{202a}', '\u{202b}', '\u{202c}', '\u{202d}', '\u{202e}', '\u{2066}', '\u{2067}',
        '\u{2068}', '\u{2069}', '\u{200b}', '\u{200e}', '\u{200f}', '\u{feff}',
    ] {
        let cleaned = clean_text(&format!("Allow {ch}agent"));
        assert!(
            !cleaned.contains(ch),
            "U+{:04X} survives into the dialog text: {cleaned:?}",
            ch as u32
        );
    }
}

// ---------- replies ----------

#[test]
fn a_reply_carries_the_time_it_was_given_and_nothing_derived_from_the_clock() {
    let req = parse_request(&valid_line()).unwrap();
    let outcome = Outcome::Confirmed {
        method: "touch-id".into(),
    };
    for at in [0u64, 1, 1_790_000_000_000, u64::MAX] {
        let v: Value = serde_json::from_str(&reply_line(&req, &outcome, at)).unwrap();
        assert_eq!(v["at"], json!(at));
    }
    // A refusal has no timestamp and no method: nothing a replay could reuse.
    let v: Value = serde_json::from_str(&reply_line(&req, &Outcome::Cancelled, 5)).unwrap();
    assert!(v.get("at").is_none() && v.get("method").is_none() && v.get("actionHash").is_none());
}

#[test]
fn reply_lines_are_one_line_of_json_even_for_awkward_method_names() {
    let req = parse_request(&valid_line().replace("n-1", r#"a\"b\\c"#)).unwrap();
    let outcome = Outcome::Confirmed {
        method: "line\nbreak \"quoted\"".into(),
    };
    let line = reply_line(&req, &outcome, 1);
    assert!(!line.contains('\n'));
    let v: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(v["nonce"], r#"a"b\c"#);
    assert_eq!(v["method"], "line\nbreak \"quoted\"");
    assert!(!error_line().contains('\n'));
    assert!(!probe_line(&Probe::Unavailable {
        reason: "a\nb".into()
    })
    .contains('\n'));
}

#[test]
fn the_error_line_has_no_nonce_to_echo() {
    let v: Value = serde_json::from_str(&error_line()).unwrap();
    assert_eq!(v, json!({ "v": 1, "ok": false, "reason": "failed" }));
}

// ---------- run_attest / run_probe through a fake platform ----------

#[test]
fn run_attest_never_asks_the_platform_for_a_request_it_refused() {
    let mut cases: Vec<String> = vec![
        "".into(),
        "garbage".into(),
        valid_line().replace(r#""v":1"#, r#""v":2"#),
        valid_line().replace("60000", "0"),
        valid_line().replace(HASH, "abc"),
        valid_line().replace("n-1", ""),
        valid_line().replace('}', r#","extra":1}"#),
    ];
    let line = valid_line();
    cases.extend((0..line.len()).step_by(7).map(|n| line[..n].to_string()));
    for input in cases {
        let f = Fake::available(Outcome::Confirmed {
            method: "touch-id".into(),
        });
        let v: Value = serde_json::from_str(&run_attest(&f, &input)).unwrap();
        assert_eq!(
            v,
            json!({ "v": 1, "ok": false, "reason": "failed" }),
            "{input:?}"
        );
        assert_eq!(f.asked(), 0, "{input:?}");
    }
}

#[test]
fn run_attest_answers_every_outcome_and_asks_exactly_once() {
    let outcomes = [
        (Outcome::Cancelled, "cancelled"),
        (Outcome::TimedOut, "timeout"),
        (Outcome::Unavailable, "unavailable"),
        (Outcome::Failed, "failed"),
    ];
    for (o, reason) in outcomes {
        let f = Fake::available(o);
        let v: Value = serde_json::from_str(&run_attest(&f, &valid_line())).unwrap();
        assert_eq!(
            v,
            json!({ "v": 1, "ok": false, "reason": reason, "nonce": "n-1" })
        );
        assert_eq!(f.asked(), 1);
    }
}

#[test]
fn run_attest_does_not_confirm_when_the_probe_says_unavailable_even_if_the_platform_would() {
    let f = Fake::new(
        Probe::Unavailable {
            reason: "no-polkit".into(),
        },
        Outcome::Confirmed {
            method: "polkit".into(),
        },
    );
    let v: Value = serde_json::from_str(&run_attest(&f, &valid_line())).unwrap();
    assert_eq!(v["ok"], false);
    assert_eq!(v["reason"], "unavailable");
    assert_eq!(f.asked(), 0);
}

#[test]
fn run_probe_reports_the_platform_probe_unchanged() {
    let f = Fake::available(Outcome::Failed);
    let v: Value = serde_json::from_str(&run_probe(&f)).unwrap();
    assert_eq!(
        v,
        json!({ "v": 1, "available": true, "method": "touch-id" })
    );
}

// ---------- generative ----------

fn random_valid_line(rng: &mut Rng) -> (String, String, String, String, u64) {
    let nonce_chars: Vec<char> = ('!'..='~').collect();
    let nonce: String = (0..1 + rng.below(128))
        .map(|_| nonce_chars[rng.below(nonce_chars.len() as u32) as usize])
        .collect();
    let hash: String = (0..64)
        .map(|_| char::from_digit(rng.below(16), 16).unwrap())
        .collect();
    let words = [
        "Allow",
        "agent",
        "bernd",
        "shell.exec",
        "ä",
        "😀",
        "x\ny",
        "\u{1b}[31m",
    ];
    let text: String = (0..rng.below(60))
        .map(|_| rng.pick(&words))
        .collect::<Vec<_>>()
        .join(" ");
    let ttl = 1 + u64::from(rng.next()) % MAX_TTL_MS;
    let line = json!({ "v": 1, "nonce": nonce, "actionHash": hash, "text": text, "ttlMs": ttl })
        .to_string();
    (line, nonce, hash, text, ttl)
}

#[test]
fn random_valid_requests_round_trip_through_parse_and_reply() {
    let mut rng = Rng::new(SEED);
    for case in 0..300u64 {
        let (line, nonce, hash, text, ttl) = random_valid_line(&mut rng);
        let ctx = format!("seed {SEED:#x} case {case}");
        let req = parse_request(&line).unwrap_or_else(|e| panic!("{ctx}: {e:?} for {line}"));
        assert_eq!(req.nonce, nonce, "{ctx}");
        assert_eq!(req.action_hash, hash, "{ctx}");
        assert_eq!(req.text, clean_text(&text), "{ctx}");
        assert_eq!(req.ttl, Duration::from_millis(ttl), "{ctx}");
        let reply: Value = serde_json::from_str(&reply_line(
            &req,
            &Outcome::Confirmed {
                method: "touch-id".into(),
            },
            case,
        ))
        .unwrap();
        assert_eq!(reply["nonce"], json!(nonce), "{ctx}");
        assert_eq!(reply["actionHash"], json!(hash), "{ctx}");
        assert_eq!(reply["at"], json!(case), "{ctx}");
    }
}

#[test]
fn random_byte_mutations_of_a_valid_request_never_panic_and_never_widen_the_bounds() {
    let seed = SEED ^ 0xff;
    let mut rng = Rng::new(seed);
    let base = valid_line().into_bytes();
    for case in 0..2000 {
        let mut bytes = base.clone();
        for _ in 0..1 + rng.below(3) {
            let at = rng.below(bytes.len() as u32) as usize;
            match rng.below(3) {
                0 => bytes[at] = rng.next() as u8,
                1 => {
                    bytes.remove(at);
                }
                _ => bytes.insert(at, rng.next() as u8),
            }
        }
        // The helper reads text, so only mutations that stay UTF-8 reach the parser.
        let Ok(line) = String::from_utf8(bytes) else {
            continue;
        };
        if let Ok(req) = parse_request(&line) {
            let ctx = format!("seed {seed:#x} case {case}: {line:?}");
            assert!(!req.nonce.is_empty() && req.nonce.len() <= 128, "{ctx}");
            assert_eq!(req.action_hash.len(), 64, "{ctx}");
            assert!(
                req.ttl > Duration::ZERO && req.ttl <= Duration::from_millis(MAX_TTL_MS),
                "{ctx}"
            );
            assert!(req.text.chars().count() <= 300, "{ctx}");
        }
    }
}

// ---------- mapping: the only way to `Confirmed` ----------

#[test]
fn only_the_success_code_of_each_os_maps_to_confirmed() {
    let confirmed = |o: &Outcome| matches!(o, Outcome::Confirmed { .. });
    for code in -5000isize..=5000 {
        assert!(!confirmed(&mapping::la_error(code)), "LAError {code}");
    }
    for code in -5000i32..=5000 {
        assert_eq!(
            confirmed(&mapping::hello_result(code, "m")),
            code == 0,
            "hello {code}"
        );
    }
    for code in (0u32..=5000).chain([u32::MAX, u32::MAX - 1]) {
        assert!(!confirmed(&mapping::uac_error(code)), "win32 {code}");
    }
    for code in (-300i32..=300).chain([i32::MIN, i32::MAX]) {
        assert_eq!(
            confirmed(&mapping::pkcheck_exit(Some(code), "m")),
            code == 0,
            "pkcheck {code}"
        );
    }
    // Killed by a signal: there is no exit code, and that is a failure, never a confirmation.
    assert_eq!(mapping::pkcheck_exit(None, "m"), Outcome::Failed);
}

#[test]
fn uac_prompt_detection_fails_closed_for_every_policy_combination() {
    let values = [None, Some(0), Some(1), Some(2), Some(5), Some(u32::MAX)];
    for lua in values {
        for admin in values {
            for elevated in [false, true] {
                let expected = !elevated && lua == Some(1) && matches!(admin, Some(b) if b != 0);
                assert_eq!(
                    mapping::uac_prompts_for(lua, admin, elevated),
                    expected,
                    "lua {lua:?} admin {admin:?} elevated {elevated}"
                );
            }
        }
    }
}

// ---------- the binary ----------

mod binary {
    use serde_json::Value;
    use std::io::Write;
    use std::process::{Command, Output, Stdio};
    use std::time::{Duration, Instant};

    fn run(args: &[&str], stdin: &[u8]) -> (Output, Duration) {
        let started = Instant::now();
        let mut child = Command::new(env!("CARGO_BIN_EXE_plur1bus-attest"))
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn plur1bus-attest");
        let mut pipe = child.stdin.take().unwrap();
        let data = stdin.to_vec();
        // The helper stops reading at its own bound, so a write error (broken pipe) is expected for oversized input.
        let writer = std::thread::spawn(move || {
            let _ = pipe.write_all(&data);
        });
        let out = child.wait_with_output().expect("wait");
        let _ = writer.join();
        (out, started.elapsed())
    }

    fn failed_reply() -> Value {
        serde_json::json!({ "v": 1, "ok": false, "reason": "failed" })
    }

    // NOTE: a well-formed `--attest` request is never sent to the real binary: on a desktop it opens a real Touch ID, password,
    // Hello or polkit dialog. Only requests the parser refuses reach it here.

    #[test]
    fn no_mode_is_a_usage_error_with_exit_2_and_nothing_on_stdout() {
        for args in [&[][..], &["--bogus"], &["attest"], &["--ATTEST"]] {
            let (out, _) = run(args, b"");
            assert_eq!(out.status.code(), Some(2), "{args:?}");
            assert!(out.stdout.is_empty(), "{args:?}");
            assert!(
                String::from_utf8_lossy(&out.stderr).contains("usage:"),
                "{args:?}"
            );
        }
    }

    #[test]
    fn consent_noop_exits_zero_silently() {
        let (out, _) = run(&["--consent-noop"], b"");
        assert_eq!(out.status.code(), Some(0));
        assert!(out.stdout.is_empty() && out.stderr.is_empty());
    }

    #[test]
    fn a_refused_request_is_answered_with_one_failed_line_and_exit_0() {
        let long_garbage = vec![b'x'; 10_000];
        let inputs: [&[u8]; 6] = [
            b"",
            b"\n",
            b"garbage\n",
            br#"{"v":1}"#,
            &[0xff, 0xfe, 0x00, b'\n'], // not UTF-8
            &long_garbage,
        ];
        for input in inputs {
            let (out, _) = run(&["--attest"], input);
            assert_eq!(out.status.code(), Some(0), "{input:?}");
            let stdout = String::from_utf8(out.stdout).unwrap();
            assert_eq!(
                stdout.matches('\n').count(),
                1,
                "exactly one line: {stdout:?}"
            );
            let v: Value = serde_json::from_str(stdout.trim()).unwrap();
            assert_eq!(v, failed_reply(), "{input:?}");
        }
    }

    #[test]
    fn a_line_beyond_the_64_kib_stdin_bound_is_cut_off_and_refused_promptly() {
        // 1 MiB with no line break: the helper reads at most 64 KiB, the cut-off JSON does not parse, and it answers `failed`.
        let mut big = br#"{"v":1,"nonce":"n-1","actionHash":"#.to_vec();
        big.resize(1 << 20, b'a');
        let (out, took) = run(&["--attest"], &big);
        assert_eq!(out.status.code(), Some(0));
        let v: Value = serde_json::from_slice(&out.stdout).unwrap();
        assert_eq!(v, failed_reply());
        assert!(took < Duration::from_secs(20), "took {took:?}");
    }

    #[test]
    fn only_the_first_stdin_line_is_read() {
        // A garbage first line is refused even when a valid request follows on the second line.
        let valid = format!(
            r#"{{"v":1,"nonce":"n-1","actionHash":"{}","text":"t","ttlMs":5000}}"#,
            "ab".repeat(32)
        );
        let (out, _) = run(&["--attest"], format!("garbage\n{valid}\n").as_bytes());
        let v: Value = serde_json::from_slice(&out.stdout).unwrap();
        assert_eq!(v, failed_reply());
    }

    #[test]
    fn probe_prints_one_json_line_with_the_documented_shape() {
        let (out, _) = run(&["--probe"], b"");
        assert_eq!(out.status.code(), Some(0));
        let stdout = String::from_utf8(out.stdout).unwrap();
        assert_eq!(stdout.matches('\n').count(), 1);
        let v: Value = serde_json::from_str(stdout.trim()).unwrap();
        assert_eq!(v["v"], 1);
        // The answer depends on the host (Touch ID, polkit, Hello); only its shape is fixed.
        match v["available"].as_bool().expect("available is a bool") {
            true => assert!(v["method"].is_string() && v.get("reason").is_none()),
            false => assert!(v["reason"].is_string() && v.get("method").is_none()),
        }
    }
}
