//! Actual Node registry metadata decisions, with persistence tested separately.
#![allow(clippy::unwrap_used, clippy::expect_used)]
use plur1bus_engine::{
    contract::Cancel,
    jobs::metadata::{history, recovery_plan, HistorySelection},
    text::json::{parse_json, write_json, TolerantJsonValue as Json},
};
fn get<'a>(value: &'a Json, name: &str) -> Option<&'a Json> {
    let fields = if let Json::Object(fields) = value {
        Some(fields)
    } else {
        None
    }
    .expect("fixture object");
    fields
        .iter()
        .rev()
        .find(|(k, _)| k.to_utf8_lossy() == name)
        .map(|(_, v)| v)
}
fn array(value: &Json) -> &[Json] {
    if let Json::Array(values) = value {
        Some(values.as_slice())
    } else {
        None
    }
    .expect("fixture array")
}
fn text(value: &Json) -> String {
    if let Json::String(value) = value {
        Some(value.to_utf8_lossy())
    } else {
        None
    }
    .expect("fixture string")
}
fn number(value: Option<&Json>) -> Option<f64> {
    value.map(|value| {
        if let Json::Number(value) = value {
            value.parse().ok()
        } else {
            None
        }
        .expect("fixture number")
    })
}
#[test]
fn recovery_and_history_match_twenty_four_actual_node_cases() {
    let golden = parse_json(include_str!("fixtures/ops/golden/job-metadata.json")).unwrap();
    let now = number(get(&golden, "now")).unwrap();
    for case in array(get(&golden, "recovered").unwrap()) {
        let input = get(case, "input").unwrap();
        let rows = get(input, "rows").map(array).unwrap_or(&[]);
        let actions = recovery_plan(
            rows,
            array(get(input, "markers").unwrap()),
            "alpha",
            now,
            &Cancel::never(),
        )
        .unwrap();
        let actual: Vec<_> = actions
            .iter()
            .filter_map(|a| a.row.as_ref().map(write_json))
            .collect();
        let expected: Vec<_> = array(get(case, "rowsJson").unwrap())
            .iter()
            .map(text)
            .collect();
        assert_eq!(actual, expected, "{}", text(get(input, "name").unwrap()));
        assert_eq!(
            actions.iter().map(|a| a.run_id.clone()).collect::<Vec<_>>(),
            array(get(case, "removed").unwrap())
                .iter()
                .map(text)
                .collect::<Vec<_>>()
        );
    }
    for case in array(get(&golden, "histories").unwrap()) {
        let input = get(case, "input").unwrap();
        let filter = get(input, "filter").unwrap();
        let job = get(filter, "job").map(text);
        let selection = HistorySelection {
            job: job.as_deref(),
            since: number(get(filter, "since")),
            limit: number(get(filter, "limit")),
        };
        let actual = history(
            array(get(input, "rows").unwrap()),
            &selection,
            &Cancel::never(),
        )
        .unwrap();
        assert_eq!(
            actual.iter().map(write_json).collect::<Vec<_>>(),
            array(get(case, "rowsJson").unwrap())
                .iter()
                .map(text)
                .collect::<Vec<_>>(),
            "{}",
            text(get(input, "name").unwrap())
        );
    }
}

#[test]
fn cancellation_invalid_snapshots_and_unrepresentable_dates_yield_no_plan() {
    let cancelled = Cancel::never();
    cancelled.cancel();
    assert!(history(&[], &HistorySelection::default(), &cancelled).is_err());
    assert!(recovery_plan(&[], &[], "alpha", 42.0, &cancelled).is_err());
    let marker =
        parse_json(r#"{"runId":"old-001","job":"knowledge-update","startedAt":42}"#).unwrap();
    assert!(recovery_plan(
        &[],
        &[marker.clone(), marker.clone()],
        "alpha",
        42.0,
        &Cancel::never()
    )
    .is_err());
    assert!(recovery_plan(
        &[],
        std::slice::from_ref(&marker),
        "../alpha",
        42.0,
        &Cancel::never()
    )
    .is_err());
    for now in [f64::NAN, f64::INFINITY, 9e15] {
        assert!(recovery_plan(
            &[],
            std::slice::from_ref(&marker),
            "alpha",
            now,
            &Cancel::never()
        )
        .is_err());
    }
    assert!(recovery_plan(
        &[],
        &[parse_json(r#"{"runId":"../escape"}"#).unwrap()],
        "alpha",
        42.0,
        &Cancel::never()
    )
    .is_err());
    assert!(history(
        &[Json::Null],
        &HistorySelection::default(),
        &Cancel::never()
    )
    .is_err());
    assert!(recovery_plan(&[], &vec![marker; 1025], "alpha", 42.0, &Cancel::never()).is_err());
}
