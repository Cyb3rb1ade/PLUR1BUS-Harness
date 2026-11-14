//! Replay of the parity vectors recorded from the TypeScript identity code (`scripts/parity/export-identity.ts`,
//! `fixtures/parity/identity/*.json`). Vectors are recorded, never edited by hand. A table is `{fields, mode, cases}`: a case is
//! one string, a JSON array (`json`) or cells joined by TAB (`tsv`), aligned with `fields`. A string that holds a lone surrogate
//! is `{"u16": [units]}`. A failing file reports how many cases differ and the first few.
use super::authorization::{
    require_authorization, AuthorizePort, IdentityAction, RbacAuthorizePort,
};
use super::codes::{
    generate_code, hash_code_units, hashes_equal, new_salt, normalize_code_units, uuidv7,
    RandomSource, CODE_ALPHABET, CODE_LENGTH,
};
use super::error::IdentityError;
use super::invite_token::{
    hash_invite_token_units, invite_link, is_invite_token_shape, mint_invite_token, parse_origin,
    INVITE_CODE_MAX_MINUTES, INVITE_TTL_DEFAULT_MINUTES, INVITE_TTL_MAX_MINUTES,
};
use super::principals::{derive_user_principal_units, is_user_principal};
use super::ratelimit::{
    self as limiter, AttemptStore, LimitSpec, MemoryAttempts, GLOBAL_KEY, GLOBAL_LIMIT,
    SOURCE_LIMIT,
};
use super::recall::{create_recall_scope_provider, PrincipalResolver, RecallScopeProvider};
use super::service::{
    identity_of, is_channel_name_units, text_units, v1_principal_of_units, Actor, ChannelIdentity,
    DEFAULT_CODE_TTL_MS, MAX_CODE_TTL_MS, MAX_PENDING_PER_HUMAN_CHANNEL,
};
use crate::rbac::types::{PrincipalKind, Role};
use serde_json::Value;
use std::cell::Cell;
use std::collections::{HashMap, VecDeque};

fn load(name: &str) -> Value {
    let path = format!(
        "{}/../../fixtures/parity/identity/{name}.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// The cases of a table as rows of cells (a `tsv` cell is a string).
fn cases(table: &Value) -> Vec<Vec<Value>> {
    let tsv = table["mode"] == "tsv";
    table["cases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|line| {
            let line = line.as_str().unwrap();
            if tsv {
                line.split('\t')
                    .map(|c| Value::String(c.to_owned()))
                    .collect()
            } else {
                serde_json::from_str::<Vec<Value>>(line).unwrap()
            }
        })
        .collect()
}

/// A string of the fixtures as UTF-16 code units.
fn units(v: &Value) -> Vec<u16> {
    match v {
        Value::String(s) => s.encode_utf16().collect(),
        Value::Object(o) => o["u16"]
            .as_array()
            .unwrap()
            .iter()
            .map(|n| n.as_u64().unwrap() as u16)
            .collect(),
        other => panic!("not a string: {other}"),
    }
}

fn string(v: &Value) -> String {
    String::from_utf16_lossy(&units(v))
}

fn s(v: &Value) -> &str {
    v.as_str().unwrap()
}

fn num(v: &Value) -> i64 {
    match v {
        Value::Number(n) => n.as_i64().unwrap(),
        Value::String(t) => t.parse().unwrap(),
        other => panic!("not a number: {other}"),
    }
}

/// `err:code|field|retryAfterMs|message` (the exporter's `errText`).
fn err_text(e: &IdentityError) -> String {
    format!(
        "err:{}|{}|{}|{}",
        e.code.as_str(),
        e.field.as_deref().unwrap_or(""),
        e.retry_after_ms.map(|n| n.to_string()).unwrap_or_default(),
        e.message
    )
}

/// Reports every differing case of a file at once.
struct Report {
    file: &'static str,
    total: usize,
    bad: Vec<String>,
}

impl Report {
    fn new(file: &'static str) -> Report {
        Report {
            file,
            total: 0,
            bad: Vec::new(),
        }
    }
    fn check(&mut self, what: impl FnOnce() -> String, got: &str, want: &str) {
        self.total += 1;
        if got != want {
            self.bad
                .push(format!("{}: got {got:?} want {want:?}", what()));
        }
    }
    fn finish(self, expected_cases: usize) {
        assert_eq!(self.total, expected_cases, "{}: cases replayed", self.file);
        assert!(
            self.bad.is_empty(),
            "{}: {} of {} cases differ, first: {:#?}",
            self.file,
            self.bad.len(),
            self.total,
            self.bad.iter().take(8).collect::<Vec<_>>()
        );
    }
}

fn index_count(name: &str) -> usize {
    load("index")["counts"][name].as_u64().unwrap() as usize
}

fn tf(b: bool) -> &'static str {
    if b {
        "T"
    } else {
        "F"
    }
}

#[test]
fn principals_derive() {
    let file = load("principal-derive");
    let mut r = Report::new("principal-derive");
    for row in cases(&file) {
        let got = match derive_user_principal_units(&units(&row[0])) {
            Ok(p) => format!("ok:{p}"),
            Err(e) => err_text(&e),
        };
        r.check(|| format!("{:?}", row[0]), &got, s(&row[1]));
    }
    r.finish(index_count("principal-derive"));
}

#[test]
fn principals_shape() {
    let file = load("principal-shape");
    let mut r = Report::new("principal-shape");
    for row in cases(&file) {
        r.check(
            || format!("{:?}", row[0]),
            tf(is_user_principal(&string(&row[0]))),
            s(&row[1]),
        );
    }
    r.finish(index_count("principal-shape"));
}

#[test]
fn v1_principals_and_channel_names() {
    let mut r = Report::new("principal-v1");
    for row in cases(&load("principal-v1")) {
        let got = v1_principal_of_units(&units(&row[0]), &units(&row[1]), &units(&row[2]));
        r.check(|| format!("{:?}", &row[..3]), &got, s(&row[3]));
    }
    r.finish(index_count("principal-v1"));
    let mut r = Report::new("channel-names");
    for row in cases(&load("channel-names")) {
        r.check(
            || format!("{:?}", row[0]),
            tf(is_channel_name_units(&units(&row[0]))),
            s(&row[1]),
        );
    }
    r.finish(index_count("channel-names"));
}

#[test]
fn identity_validation_matches_the_private_helpers() {
    let file = load("identity-validation");
    let mut r = Report::new("identity-validation");
    for row in cases(&file["identity"]) {
        let identity = ChannelIdentity {
            channel: string(&row[0]),
            account_id: string(&row[1]),
            user_id: string(&row[2]),
            display_name: (!row[3].is_null()).then(|| string(&row[3])),
        };
        let got = match identity_of(&identity) {
            Ok(back) => {
                assert_eq!(back, identity, "identityOf returns the identity");
                "pass".to_owned()
            }
            Err(e) => err_text(&e),
        };
        r.check(|| format!("{:?}", &row[..4]), &got, s(&row[4]));
    }
    let n_identity = r.total;
    for row in cases(&file["text64"]) {
        let got = match text_units(&units(&row[0]), "linkId", 64) {
            Ok(()) => "pass".to_owned(),
            Err(e) => err_text(&e),
        };
        r.check(|| format!("{:?}", row[0]), &got, s(&row[1]));
    }
    assert_eq!(
        r.total,
        index_count("identity-validation"),
        "both sections replayed ({n_identity} identity cases)"
    );
    r.finish(index_count("identity-validation"));
}

#[test]
fn normalize_code_matches_node() {
    let mut r = Report::new("code-normalize");
    for row in cases(&load("code-normalize")) {
        let got = normalize_code_units(&units(&row[0]));
        let want = units(&row[1]);
        r.check(
            || format!("{:?}", row[0]),
            &format!("{got:?}"),
            &format!("{want:?}"),
        );
    }
    r.finish(index_count("code-normalize"));
}

#[test]
fn normalize_code_of_every_unicode_scalar_value() {
    let file = load("code-normalize-sweep");
    let changed: HashMap<u32, Vec<u32>> = file["changed"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(cp, to)| {
            (
                u32::from_str_radix(cp, 16).unwrap(),
                to.as_str()
                    .unwrap()
                    .split_whitespace()
                    .map(|h| u32::from_str_radix(h, 16).unwrap())
                    .collect(),
            )
        })
        .collect();
    let (mut scalars, mut bad) = (0u64, Vec::new());
    for c in (0..=0x10ffffu32).filter_map(char::from_u32) {
        scalars += 1;
        let mut buf = [0u16; 2];
        let got = normalize_code_units(c.encode_utf16(&mut buf));
        let got: Vec<u32> = char::decode_utf16(got)
            .map(|d| u32::from(d.unwrap()))
            .collect();
        let want = changed
            .get(&(c as u32))
            .cloned()
            .unwrap_or_else(|| vec![c as u32]);
        if got != want {
            bad.push(format!("U+{:04X}: got {got:X?} want {want:X?}", c as u32));
        }
    }
    assert_eq!(scalars, file["scalars"].as_u64().unwrap());
    assert!(
        bad.is_empty(),
        "{} scalar values differ, first: {:?}",
        bad.len(),
        bad.iter().take(10).collect::<Vec<_>>()
    );
}

#[test]
fn hash_code_and_hashes_equal() {
    let mut r = Report::new("code-hash");
    for row in cases(&load("code-hash")) {
        let got = hash_code_units(&units(&row[0]), &units(&row[1]));
        r.check(|| format!("{:?}", &row[..2]), &got, s(&row[2]));
    }
    r.finish(index_count("code-hash"));
    let mut r = Report::new("code-equal");
    for row in cases(&load("code-equal")) {
        r.check(
            || format!("{:?}", &row[..2]),
            tf(hashes_equal(&string(&row[0]), &string(&row[1]))),
            s(&row[2]),
        );
    }
    r.finish(index_count("code-equal"));
}

/// Feeds the recorded values; a draw beyond the script is a test failure.
#[derive(Default)]
struct Scripted {
    ints: VecDeque<u32>,
    bytes: VecDeque<Vec<u8>>,
}

impl RandomSource for Scripted {
    fn random_int(&mut self, max: u32) -> u32 {
        let v = self.ints.pop_front().expect("a scripted draw");
        assert!(v < max, "scripted {v} outside [0, {max})");
        v
    }
    fn fill_bytes(&mut self, out: &mut [u8]) {
        let next = self.bytes.pop_front().expect("scripted bytes");
        assert_eq!(next.len(), out.len());
        out.copy_from_slice(&next);
    }
}

fn unhex(h: &str) -> Vec<u8> {
    (0..h.len() / 2)
        .map(|i| u8::from_str_radix(&h[2 * i..2 * i + 2], 16).unwrap())
        .collect()
}

#[test]
fn generate_salt_uuid_and_mint_from_recorded_draws() {
    let file = load("code-random");
    let mut r = Report::new("code-random");
    for row in cases(&file["generate"]) {
        let mut rng = Scripted {
            ints: row[0]
                .as_array()
                .unwrap()
                .iter()
                .map(|n| n.as_u64().unwrap() as u32)
                .collect(),
            ..Scripted::default()
        };
        let got = generate_code(&mut rng);
        assert!(rng.ints.is_empty(), "every draw is consumed");
        assert!(got.chars().all(|c| CODE_ALPHABET.contains(c)) && got.len() == CODE_LENGTH);
        r.check(|| format!("{:?}", row[0]), &got, s(&row[1]));
    }
    for row in cases(&file["salt"]) {
        let mut rng = Scripted::default();
        rng.bytes.push_back(unhex(s(&row[0])));
        r.check(|| s(&row[0]).to_owned(), &new_salt(&mut rng), s(&row[1]));
    }
    for row in cases(&file["uuid"]) {
        let now = match &row[0] {
            Value::Number(n) => n.as_f64().unwrap(),
            Value::String(t) => match t.as_str() {
                "NaN" => f64::NAN,
                "Infinity" => f64::INFINITY,
                "-Infinity" => f64::NEG_INFINITY,
                "-0" => -0.0,
                other => panic!("unknown time {other}"),
            },
            other => panic!("time {other}"),
        };
        let mut rng = Scripted::default();
        rng.bytes.push_back(unhex(s(&row[1])));
        let got = uuidv7(now, &mut rng).unwrap_or_else(|_| "range-error".to_owned());
        r.check(|| format!("{now} {}", s(&row[1])), &got, s(&row[2]));
    }
    for row in cases(&file["mint"]) {
        let mut rng = Scripted::default();
        rng.bytes.push_back(unhex(s(&row[0])));
        r.check(
            || s(&row[0]).to_owned(),
            &mint_invite_token(&mut rng),
            s(&row[1]),
        );
    }
    r.finish(index_count("code-random"));
}

#[test]
fn invite_tokens_hashes_and_links() {
    let file = load("invite-token");
    let mut r = Report::new("invite-token");
    for row in cases(&file["shape"]) {
        r.check(
            || format!("{:?}", row[0]),
            tf(is_invite_token_shape(&string(&row[0]))),
            s(&row[1]),
        );
    }
    for row in cases(&file["hash"]) {
        r.check(
            || format!("{:?}", row[0]),
            &hash_invite_token_units(&units(&row[0])),
            s(&row[1]),
        );
    }
    for row in cases(&file["link"]) {
        r.check(
            || format!("{:?}", &row[..2]),
            &invite_link(&string(&row[0]), &string(&row[1])),
            &string(&row[2]),
        );
    }
    r.finish(index_count("invite-token"));
}

#[test]
fn the_documented_constants() {
    let c = load("constants");
    assert_eq!(c["INVITE_TTL_DEFAULT_MINUTES"], INVITE_TTL_DEFAULT_MINUTES);
    assert_eq!(c["INVITE_TTL_MAX_MINUTES"], INVITE_TTL_MAX_MINUTES);
    assert_eq!(c["INVITE_CODE_MAX_MINUTES"], INVITE_CODE_MAX_MINUTES);
    assert_eq!(c["MAX_CODE_TTL_MS"], MAX_CODE_TTL_MS);
    assert_eq!(c["DEFAULT_CODE_TTL_MS"], DEFAULT_CODE_TTL_MS);
    assert_eq!(
        c["MAX_PENDING_PER_HUMAN_CHANNEL"],
        MAX_PENDING_PER_HUMAN_CHANNEL
    );
    assert_eq!(c["CODE_ALPHABET"], CODE_ALPHABET);
    assert_eq!(c["CODE_LENGTH"], CODE_LENGTH);
    assert_eq!(INVITE_CODE_MAX_MINUTES as i64 * 60_000, MAX_CODE_TTL_MS);
    for (name, spec) in [
        ("SOURCE_LIMIT", SOURCE_LIMIT),
        ("GLOBAL_LIMIT", GLOBAL_LIMIT),
    ] {
        assert_eq!(c[name]["limit"], spec.limit, "{name}");
        assert_eq!(c[name]["windowMs"], spec.window_ms, "{name}");
        assert_eq!(c[name]["lockMs"], spec.lock_ms, "{name}");
    }
    assert_eq!(c["GLOBAL_KEY"], GLOBAL_KEY);
}

#[test]
fn parse_origin_matches_url_except_for_punycode_hosts() {
    let file = load("invite-origin");
    let mut r = Report::new("invite-origin");
    let (mut punycode, mut accepted) = (0, 0);
    for row in cases(&file) {
        let raw = string(&row[0]);
        let got = parse_origin(&raw);
        if s(&row[2]) == "punycode" {
            // Node accepts a valid `xn--` label; this port refuses every one (documented): pin the strictness.
            punycode += 1;
            r.check(|| format!("{raw:?}"), &format!("{got:?}"), "None");
            continue;
        }
        let want = if s(&row[1]) == "-" {
            None
        } else {
            Some(s(&row[1]).to_owned())
        };
        accepted += usize::from(want.is_some());
        r.check(
            || format!("{raw:?}"),
            &format!("{got:?}"),
            &format!("{want:?}"),
        );
    }
    assert!(
        punycode >= 50 && accepted >= 300,
        "{punycode} punycode, {accepted} accepted"
    );
    r.finish(index_count("invite-origin"));
}

fn spec_of(text: &str) -> LimitSpec {
    match text {
        "src" => SOURCE_LIMIT,
        "glb" => GLOBAL_LIMIT,
        triple => {
            let n: Vec<i64> = triple.split(',').map(|x| x.parse().unwrap()).collect();
            LimitSpec {
                limit: n[0],
                window_ms: n[1],
                lock_ms: n[2],
            }
        }
    }
}

fn dump(store: &MemoryAttempts) -> String {
    store
        .rows
        .iter()
        .map(|(k, r)| format!("{k},{},{},{}", r.failures, r.window_start, r.locked_until))
        .collect::<Vec<_>>()
        .join(";")
}

#[test]
fn limiter_sequences_replay_row_for_row() {
    let file = load("limiter");
    let mut r = Report::new("limiter");
    for seq in file["sequences"].as_array().unwrap() {
        let name = seq["name"].as_str().unwrap();
        let mut store = MemoryAttempts::default();
        for (i, line) in seq["steps"].as_array().unwrap().iter().enumerate() {
            let c: Vec<&str> = line.as_str().unwrap().split('\t').collect();
            let (op, keys, spec, now, extra, rows) =
                (c[0], c[1], c[2], c[3].parse::<i64>().unwrap(), c[4], c[5]);
            let mut result = String::new();
            match op {
                "failure" => limiter::failure(&mut store, keys, &spec_of(spec), now).unwrap(),
                "success" => limiter::success(&mut store, keys).unwrap(),
                "release" => limiter::release(
                    &mut store,
                    keys,
                    &spec_of(spec),
                    extra.parse().unwrap(),
                    now,
                )
                .unwrap(),
                "locked" => {
                    let list: Vec<&str> = keys.split('|').collect();
                    result = limiter::locked_for(&store, &list, now).unwrap().to_string();
                    assert_eq!(result, extra, "{name} step {i}: wait");
                }
                "prune" => limiter::prune(&mut store, now).unwrap(),
                other => panic!("op {other}"),
            }
            r.check(
                || format!("{name} step {i} {op} {keys} {spec} at {now}"),
                &dump(&store),
                rows,
            );
            let _ = result;
        }
    }
    r.finish(index_count("limiter"));
    assert!(MemoryAttempts::default().get("x").unwrap().is_none());
}

fn actor(role: &str, kind: &str, scopes: Option<Vec<String>>, user: &str) -> Actor {
    Actor {
        user: user.to_owned(),
        host: "h".to_owned(),
        kind: (kind != "-").then(|| PrincipalKind::parse(kind).unwrap()),
        role: (role != "-").then(|| Role::parse(role).unwrap()),
        token_scopes: scopes,
    }
}

fn scope_set(name: &str) -> Option<Vec<String>> {
    let list = |l: &[&str]| Some(l.iter().map(|x| (*x).to_owned()).collect());
    match name {
        "absent" => None,
        "empty" => list(&[]),
        "users-manage" => list(&["users.manage"]),
        "my-write" => list(&["my.write"]),
        "both" => list(&["users.manage", "my.write"]),
        "users-star" => list(&["users.*"]),
        "my-star" => list(&["my.*"]),
        "star" => list(&["*"]),
        "other" => list(&["chat.read"]),
        "my-write-prefix" => list(&["my.writer"]),
        other => panic!("scope set {other}"),
    }
}

struct Fixed(bool);
impl AuthorizePort for Fixed {
    fn authorize(&self, _: &Actor, _: IdentityAction, _: &str) -> bool {
        self.0
    }
}

#[test]
fn rbac_authorize_port_and_require_authorization() {
    let file = load("authorization");
    let mut r = Report::new("authorization");
    for row in cases(&file["port"]) {
        let a = actor(s(&row[1]), s(&row[2]), scope_set(s(&row[4])), "u-1");
        let target = if s(&row[3]) == "own" { "u-1" } else { "u-2" };
        let action = IdentityAction::parse(s(&row[0])).unwrap();
        r.check(
            || format!("{:?}", &row[..5]),
            tf(RbacAuthorizePort.authorize(&a, action, target)),
            s(&row[5]),
        );
    }
    for row in cases(&file["edge"]) {
        let (user, target) = (string(&row[2]), string(&row[3]));
        let a = actor(s(&row[1]), "person", None, &user);
        let action = IdentityAction::parse(s(&row[0])).unwrap();
        r.check(
            || format!("{:?}", &row[..4]),
            tf(RbacAuthorizePort.authorize(&a, action, &target)),
            s(&row[4]),
        );
    }
    for row in cases(&file["require"]) {
        let a = actor(s(&row[2]), s(&row[3]), None, "u-1");
        let target = if s(&row[4]) == "own" { "u-1" } else { "u-2" };
        let action = IdentityAction::parse(s(&row[1])).unwrap();
        let port: &dyn AuthorizePort = match s(&row[0]) {
            "rbac" => &RbacAuthorizePort,
            "allow" => &Fixed(true),
            "deny" => &Fixed(false),
            other => panic!("port {other}"),
        };
        let got = match require_authorization(port, &a, action, target) {
            Ok(()) => "ok".to_owned(),
            Err(e) => err_text(&e),
        };
        r.check(|| format!("{:?}", &row[..5]), &got, s(&row[5]));
    }
    r.finish(index_count("authorization"));
}

struct Stub<'a> {
    behaviour: &'a str,
    calls: &'a Cell<usize>,
}

impl PrincipalResolver for Stub<'_> {
    fn resolve_principals(&self, user_v2: &str) -> Result<Vec<String>, IdentityError> {
        self.calls.set(self.calls.get() + 1);
        match self.behaviour {
            "known" => Ok(vec![
                user_v2.to_owned(),
                format!("user:v1:{}", "c".repeat(64)),
                format!("user:v1:{}", "d".repeat(64)),
            ]),
            "not-found" => Err(IdentityError::new(
                super::IdentityErrorCode::NotFound,
                "unknown harness principal",
            )),
            "storage" => Err(IdentityError::new(
                super::IdentityErrorCode::Storage,
                "invalid stored principal",
            )),
            _ => Err(IdentityError::bad("userV2", "expected v2 principal")),
        }
    }
}

#[test]
fn recall_scope_provider() {
    let mut r = Report::new("recall");
    for row in cases(&load("recall")) {
        let calls = Cell::new(0);
        let provider = create_recall_scope_provider(Stub {
            behaviour: s(&row[1]),
            calls: &calls,
        });
        let input = string(&row[2]);
        let got = if s(&row[0]) == "resolvePrincipals" {
            provider
                .resolve_principals(&input)
                .map(|v| format!("ok:{}", serde_json::to_string(&v).unwrap()))
        } else {
            provider
                .capture_principal(&input)
                .map(|v| format!("ok:{}", serde_json::to_string(&v).unwrap()))
        };
        let got = got.unwrap_or_else(|e| err_text(&e));
        r.check(|| format!("{:?}", &row[..3]), &got, s(&row[4]));
        assert_eq!(calls.get() as i64, num(&row[3]), "calls of {:?}", &row[..3]);
    }
    r.finish(index_count("recall"));
}

#[test]
fn node_random_int_algorithm() {
    use super::codes::{draw48, random_int_from_draws};
    // A draw below the limit is reduced modulo max; draws at or above it are dropped (RAND_MAX = 2^48 - 1).
    let max_draw = 0xFFFF_FFFF_FFFFu64;
    assert_eq!(random_int_from_draws(32, || 37), 5);
    assert_eq!(random_int_from_draws(32, || 0), 0);
    let limit32 = max_draw - (max_draw % 32);
    assert_eq!(limit32, (1 << 48) - 32);
    let mut draws = vec![max_draw, max_draw - 30, limit32, limit32 - 1].into_iter();
    assert_eq!(
        random_int_from_draws(32, || draws.next().unwrap()),
        (limit32 - 1) % 32
    );
    assert_eq!(random_int_from_draws(1, || 123), 0);
    // max = 10: RAND_MAX % 10 = 5, so the limit is RAND_MAX - 5 and exactly the last six values are rejected.
    let limit10 = max_draw - 5;
    let mut draws = vec![max_draw, limit10, limit10 - 1].into_iter();
    assert_eq!(
        random_int_from_draws(10, || draws.next().unwrap()),
        (limit10 - 1) % 10
    );
    assert_eq!(draw48(&[0, 0, 0, 0, 1, 2]), 258);
    assert_eq!(draw48(&[0xff; 6]), max_draw);
}
