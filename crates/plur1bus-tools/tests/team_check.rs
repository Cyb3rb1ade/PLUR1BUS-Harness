#![allow(clippy::unwrap_used, clippy::expect_used)]
use plur1bus_tools::team::{dispatch, hash};
use serde_json::{json, Value};
fn input() -> Value {
    json!({"plan":serde_json::from_str::<Value>(include_str!("../../../packages/rpc-schema/fixtures/team/plan.json")).unwrap(),"files":[],"workflows":[],"config":{"approval":{"auto":false},"closedPaths":[],"deployBranches":[]}})
}
fn run(v: &Value) -> Value {
    dispatch("tools.team.check", v).unwrap()
}
fn add(v: &mut Value, key: &str) {
    let mut p = v["plan"]["packages"][0].clone();
    p["key"] = json!(key);
    p["owns"] = json!([{"glob":format!("src/{key}.ts"),"mode":"own"}]);
    v["plan"]["packages"].as_array_mut().unwrap().push(p);
    v["plan"]["sections"][0]["mergeOrder"]
        .as_array_mut()
        .unwrap()
        .push(json!(key));
}
fn finding(v: &Value, kind: &str) -> bool {
    v["findings"]
        .as_array()
        .unwrap()
        .iter()
        .any(|f| f["kind"] == kind)
}
#[test]
fn fixture_hash_and_schema_contract() {
    let v = input();
    let r = run(&v);
    assert_eq!(r["planHash"], hash(&v["plan"]));
    assert_eq!(r["policyHash"], hash(&v["config"]));
    assert_eq!(r["findings"], json!([]));
    assert_eq!(r["lanes"][0]["lane"], "contained");
    let expected: Value = serde_json::from_str(include_str!(
        "../../../packages/rpc-schema/fixtures/team/report.json"
    ))
    .unwrap();
    assert_eq!(r, expected);
    let mut bad = v.clone();
    bad["plan"]["packages"][0]["lane"] = json!("contained");
    assert!(dispatch("tools.team.check", &bad).is_err());
    bad = v;
    bad["unexpected"] = json!(true);
    assert!(dispatch("tools.team.check", &bad).is_err());
}
#[test]
fn cycles_later_sections_merge_order_overlap_and_missing_checks() {
    let mut v = input();
    add(&mut v, "second");
    v["plan"]["packages"][1]["dependsOn"] =
        json!([{"package":"duration","kind":"order","reason":"sequence"}]);
    assert!(!finding(&run(&v), "false-edge"));
    v["plan"]["packages"][0]["dependsOn"] =
        json!([{"package":"second","kind":"order","reason":"sequence"}]);
    assert!(finding(&run(&v), "cycle"));
    assert!(finding(&run(&v), "merge-order"));
    v["plan"]["packages"][1]["owns"] = v["plan"]["packages"][0]["owns"].clone();
    assert!(finding(&run(&v), "own-overlap"));
    v["plan"]["sections"].as_array_mut().unwrap().push(json!({"key":"later","title":"Later","goals":["later"],"budget":{"tokens":100,"wallTimeMs":100},"mergeOrder":["second"]}));
    v["plan"]["sections"][0]["mergeOrder"] = json!(["duration"]);
    v["plan"]["packages"][1]["section"] = json!("later");
    assert!(finding(&run(&v), "later-section"));
    for checks in [
        json!([]),
        json!([{"kind":"paths","criterion":0,"paths":["src/**"]}]),
    ] {
        v["plan"]["packages"][0]["checks"] = checks;
        assert!(finding(&run(&v), "missing-check"));
    }
}
#[test]
fn false_edges_report_critical_path_saving_and_accept_crossings_or_reason() {
    let mut v = input();
    add(&mut v, "second");
    v["plan"]["packages"][1]["dependsOn"] = json!([{"package":"duration","kind":"code"}]);
    let r = run(&v);
    let f = r["findings"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["kind"] == "false-edge")
        .unwrap();
    assert_eq!(f["savedWallTimeMs"], 10000);
    assert_eq!(f["blocking"], true);
    v["plan"]["packages"][1]["interfaces"]["consumes"] = json!(["duration"]);
    assert!(!finding(&run(&v), "false-edge"));
    v["plan"]["packages"][1]["interfaces"]["consumes"] = json!([]);
    v["plan"]["packages"][1]["dependsOn"][0]["carries"] =
        json!([{"kind":"file","value":"src/duration.ts"}]);
    assert!(!finding(&run(&v), "false-edge"));
    v["plan"]["packages"][1]["dependsOn"] =
        json!([{"package":"duration","kind":"order","reason":"   "}]);
    assert!(finding(&run(&v), "false-edge"));
    v["plan"]["packages"][1]["dependsOn"][0]["reason"] = json!("the prerequisite must run first");
    assert!(!finding(&run(&v), "false-edge"));
}
#[test]
fn every_builtin_protection_and_project_additions_are_closed() {
    for path in [
        "db/migrations/next.sql",
        "release/version.ts",
        "publish/package.ts",
        "deploy/site.yml",
        ".github/workflows/test.yml",
        "containers/image/Dockerfile",
        "infra/main.tf",
        "secrets/config.json",
        "src/rbac/policy.ts",
        "branch-protection/main.json",
        "Dockerfile",
        "config/server.json",
        "permissions/policy.json",
    ] {
        let mut v = input();
        v["plan"]["packages"][0]["owns"][0]["glob"] = json!(path);
        assert_eq!(run(&v)["lanes"][0]["lane"], "closed", "{path}");
    }
    let mut v = input();
    v["config"]["closedPaths"] = json!(["src/**"]);
    assert_eq!(run(&v)["lanes"][0]["lane"], "closed");
    v = input();
    v["plan"]["packages"][0]["dataDeletion"] = json!(true);
    assert_eq!(run(&v)["lanes"][0]["lane"], "closed");
    v = input();
    v["config"]["deployBranches"] = json!(["integration"]);
    assert_eq!(run(&v)["lanes"][0]["lane"], "closed");
}
#[test]
fn workflows_fail_closed_and_section_overlap_or_fanout_is_wide() {
    for content in [
        Value::Null,
        json!("unreadable yaml: ["),
        json!(r#"{"on":{"push":{"branches":["integration"]}},"jobs":{}}"#),
    ] {
        let mut v = input();
        v["workflows"] = json!([{"path":".github/workflows/release.yml","content":content}]);
        assert_eq!(run(&v)["lanes"][0]["lane"], "closed");
    }
    let mut v = input();
    v["workflows"] = json!([{"path":".github/workflows/test.json","content":r#"{"on":"pull_request","jobs":{}}"#}]);
    assert_eq!(run(&v)["lanes"][0]["lane"], "contained");
    v["files"] = json!([{"path":"src/duration.ts","section":"other"}]);
    assert_eq!(run(&v)["lanes"][0]["lane"], "wide");
    v = input();
    for i in 0..5 {
        add(&mut v, &format!("p{i}"));
        v["plan"]["packages"][i + 1]["dependsOn"] =
            json!([{"package":"duration","kind":"order","reason":"sequence"}]);
    }
    assert_eq!(run(&v)["lanes"][0]["lane"], "wide");
}
#[test]
fn diff_and_impact_keep_interface_shared_and_unrelated_separate() {
    let d=dispatch("tools.team.diffcheck",&json!({"owns":[{"glob":"src/**","mode":"own"},{"glob":"src/shared","mode":"shared"}],"interfaces":["src/api"],"files":["src/code","src/api","src/shared","other","../escape"]})).unwrap();
    assert_eq!(
        d["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["classification"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["owned", "interface", "shared", "foreign", "foreign"]
    );
    let running = vec![
        json!({"key":"dep","section":"a","owns":[],"consumes":[],"dependsOn":["merged"],"lane":"contained"}),
        json!({"key":"api","section":"a","owns":[],"consumes":["api"],"dependsOn":[],"lane":"contained"}),
        json!({"key":"overlap","section":"b","owns":[{"glob":"src/**","mode":"own"}],"consumes":[],"dependsOn":[],"lane":"contained"}),
        json!({"key":"unrelated","section":"b","owns":[],"consumes":[],"dependsOn":[],"lane":"contained"}),
    ];
    let r=dispatch("tools.team.impact",&json!({"merged":{"key":"merged","section":"a","files":["src/api"],"provides":["api"]},"running":running})).unwrap();
    assert_eq!(r["affected"].as_array().unwrap().len(), 3);
    assert_eq!(r["affected"][2]["lane"], "wide");
    assert_eq!(r["affected"][1]["interfaceFiles"], json!(["src/api"]));
}
#[test]
fn ambiguous_workflow_events_and_case_variants_fail_closed() {
    for content in [
        r#"{"on":"unknown-event","jobs":{}}"#,
        r#"{"on":{"unknown":{}},"jobs":{}}"#,
        r#"{"on":"pull_request","jobs":[]}"#,
    ] {
        let mut v = input();
        v["workflows"] = json!([{"path":"workflow.json","content":content}]);
        assert_eq!(run(&v)["lanes"][0]["lane"], "closed");
    }
    for path in [
        "src/RBAC/rules.ts",
        ".env.production",
        "k8s/service.yml",
        "src/auth/rights.ts",
    ] {
        let mut v = input();
        v["plan"]["packages"][0]["owns"][0]["glob"] = json!(path);
        assert_eq!(run(&v)["lanes"][0]["lane"], "closed");
    }
}
