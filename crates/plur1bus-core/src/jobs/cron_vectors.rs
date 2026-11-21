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
    // K7-D4: exact Rust and TypeScript instants from the locked tzdbs for the six March 2100 cases.
    const DST_2100_FROM: i64 = 4_107_499_200_000;
    const DST_2100: [(&str, &str, i64, i64); 6] = [
        (
            "Europe/Berlin",
            "0 0 31 * *",
            4_110_130_800_000,
            4_110_127_200_000,
        ),
        (
            "America/New_York",
            "0 0 31 * *",
            4_110_152_400_000,
            4_110_148_800_000,
        ),
        (
            "Europe/Berlin",
            "0 0 30 * *",
            4_110_044_400_000,
            4_110_040_800_000,
        ),
        (
            "America/New_York",
            "0 0 30 * *",
            4_110_066_000_000,
            4_110_062_400_000,
        ),
        (
            "Europe/Berlin",
            "0 0 29-31 * *",
            4_109_958_000_000,
            4_109_954_400_000,
        ),
        (
            "America/New_York",
            "0 0 29-31 * *",
            4_109_979_600_000,
            4_109_976_000_000,
        ),
    ];
    let mut known_differences = std::collections::BTreeSet::new();
    let mut bad: Vec<String> = Vec::new();
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
        if from == DST_2100_FROM {
            if let Some(&(_, _, rust, ts)) = DST_2100
                .iter()
                .find(|&&(zone, expr, _, _)| (zone, expr) == (tz, cron))
            {
                assert_eq!(got, json!({"next": rust}), "{tz} {cron}");
                assert_eq!(want, json!({"next": ts}), "{tz} {cron}");
                assert!(
                    known_differences.insert((tz, cron)),
                    "duplicate calendar case"
                );
                continue;
            }
        }
        if got != want {
            bad.push(format!("{tz} {cron:?} {from}: got {got} want {want}"));
        }
    }
    assert_eq!(known_differences.len(), DST_2100.len());
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

#[test]
fn new_york_and_berlin_pin_distant_summer_offsets() {
    let f = fixture();
    let cases = f["futureSummer"].as_array().unwrap();
    assert_eq!(cases.len(), 6);
    for case in cases {
        let cron = parse_cron(case["cron"].as_str().unwrap()).unwrap();
        let zone = case["tz"].as_str().unwrap();
        let from = case["from"].as_i64().unwrap();
        let selected = next_after(&cron, zone, from).unwrap();
        let expected = if case["divergence"] == "K7-D4" {
            let rust = case["rustNext"].as_i64().unwrap();
            assert_eq!(rust - case["next"].as_i64().unwrap(), 3_600_000);
            Some(rust)
        } else {
            case["next"].as_i64()
        };
        assert_eq!(selected, expected, "{zone}, {from}");
    }
}
