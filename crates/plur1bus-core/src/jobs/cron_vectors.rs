//! Replays `fixtures/parity/jobs/cron.json` (mode V): `parseCron` over every expression, `nextAfter` over the zones with the
//! DST edges, 29 February and month ends, and `isValidTimezone`.
use super::cron::{is_valid_timezone, next_after, parse_cron};
use serde_json::{json, Value};

fn fixture() -> Value {
    serde_json::from_str(include_str!("../../../../fixtures/parity/jobs/cron.json")).unwrap()
}

#[test]
fn parse_cron_gives_typescripts_fields_and_refusals() {
    let f = fixture();
    let cases = f["parse"].as_array().unwrap();
    assert!(cases.len() > 100);
    for c in cases {
        let expr = c["expr"].as_str().unwrap();
        match parse_cron(expr) {
            Ok(p) => assert_eq!(
                json!({"minutes": p.minutes, "hours": p.hours, "doms": p.doms, "months": p.months, "dows": p.dows,
                    "domRestricted": p.dom_restricted, "dowRestricted": p.dow_restricted}),
                c["ok"],
                "{expr:?}"
            ),
            Err(e) => assert_eq!(json!(e.0), c["err"], "{expr:?}"),
        }
    }
}

#[test]
fn next_after_gives_typescripts_instants_over_zones_edges_and_calendar() {
    let f = fixture();
    let cases = f["next"].as_array().unwrap();
    assert!(cases.len() > 3000, "{}", cases.len());
    let mut bad: Vec<String> = Vec::new();
    let mut later = 0;
    for c in cases {
        let (cron, tz, from) = (
            c["cron"].as_str().unwrap(),
            c["tz"].as_str().unwrap(),
            c["from"].as_f64().unwrap() as i64,
        );
        let got = match parse_cron(cron).and_then(|p| next_after(&p, tz, from)) {
            Ok(n) => json!({"next": n}),
            Err(e) => json!({"err": e.0}),
        };
        let want = match c.get("err") {
            Some(e) => json!({"err": e}),
            None => json!({"next": c["next"]}),
        };
        // K7-D4: chrono-tz holds no DST rules after 2037, so a zone that observes DST gives the standard offset there.
        let fixed = tz == "UTC" || tz == "utc" || tz.starts_with(['+', '-']);
        if got != want && c["later"] == true && !fixed {
            later += 1;
            continue;
        }
        if got != want {
            bad.push(format!("{tz} {cron:?} {from}: got {got} want {want}"));
        }
    }
    assert!(later < 80, "{later} cases beyond 2037 differ");
    let mut seen = std::collections::BTreeSet::new();
    let firsts: Vec<&String> = bad
        .iter()
        .filter(|b| seen.insert(b.split(' ').next().unwrap().to_owned()))
        .collect();
    assert!(
        bad.is_empty(),
        "{} of {} differ, first per zone: {:#?}",
        bad.len(),
        cases.len(),
        firsts
    );
}

#[test]
fn timezone_validity_is_typescripts() {
    for c in fixture()["validTz"].as_array().unwrap() {
        let tz = c["tz"].as_str().unwrap();
        assert_eq!(
            is_valid_timezone(tz),
            c["valid"].as_bool().unwrap(),
            "{tz:?}"
        );
    }
}

#[test]
fn morocco_transition_records_the_tzdb_difference() {
    let f = fixture();
    let cases = f["tzdbDifferences"].as_array().unwrap();
    assert_eq!(cases.len(), 4);
    for c in cases {
        assert_eq!(c["divergence"], "K7-D6");
        assert_eq!(c["nodeTzdb"], "2026c");
        assert_eq!(c["rustTzdb"], chrono_tz::IANA_TZDB_VERSION);
        let cron = parse_cron(c["cron"].as_str().unwrap()).unwrap();
        let from = c["from"].as_i64().unwrap();
        let tz = c["tz"].as_str().unwrap();
        let rust = c["rustNext"].as_i64().unwrap();
        let typescript = c["next"].as_i64().unwrap();
        assert_eq!(
            next_after(&cron, tz, from).unwrap(),
            Some(rust),
            "{tz} {from}"
        );
        let offset_difference = if from >= 1_789_862_400_000 {
            3_600_000
        } else {
            0
        };
        assert_eq!(typescript - rust, offset_difference, "{tz} {from}");
    }
}
