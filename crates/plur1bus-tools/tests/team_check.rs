#![allow(clippy::unwrap_used, clippy::expect_used)]
use plur1bus_tools::team::{dispatch, hash};
use serde_json::{json, Value};
fn input() -> Value {
    json!({"plan":serde_json::from_str::<Value>(include_str!("../../../packages/rpc-schema/fixtures/team/plan.json")).unwrap(),"sectionBranchPattern":"team/**","files":[],"workflows":[],"config":{"approval":{"auto":false},"closedPaths":[],"deployBranches":[]}})
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
fn repository_ci_only_closes_the_target_merge() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../packages/rpc-schema/fixtures/team/ci-workflow.json"
    ))
    .unwrap();
    use sha2::{Digest, Sha256};
    assert_eq!(
        fixture["sha256"],
        format!(
            "{:x}",
            Sha256::digest(include_bytes!("../../../.github/workflows/ci.yml"))
        )
    );
    let mut v = input();
    v["plan"]["targetBranch"] = json!("main");
    v["workflows"] = json!([{"path":fixture["source"],"content":fixture["workflow"].to_string()}]);
    let r = run(&v);
    assert_eq!(r["targetDeploys"], true);
    assert_eq!(r["lanes"][0]["lane"], "contained");
    // A workflow chain fed only by merge_group likewise cannot trigger on a local section merge.
    v["workflows"] = json!([
        {"path":"queue.json","content":json!({"name":"Queue","on":"merge_group","jobs":{}}).to_string()},
        {"path":"follow.json","content":json!({"on":{"workflow_run":{"workflows":["Queue"]}},"jobs":{}}).to_string()}
    ]);
    assert_eq!(run(&v)["targetDeploys"], true);
    assert_eq!(run(&v)["lanes"][0]["lane"], "contained");
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
        "pnpm-lock.yaml",
        "nested/package-lock.json",
        "yarn.lock",
        "apps/desktop/Cargo.lock",
        "deny.toml",
        "audit-allowlist.json",
        "nested/.cargo/config.toml",
        "rust-toolchain",
        "rust-toolchain.toml",
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
    assert_eq!(run(&v)["lanes"][0]["lane"], "contained");
    assert_eq!(run(&v)["targetDeploys"], true);
}
#[test]
fn workflows_fail_closed_and_section_overlap_or_fanout_is_wide() {
    for content in [
        Value::Null,
        json!("unreadable yaml: ["),
        json!(r#"{"on":{"push":{}},"jobs":{}}"#),
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

#[test]
fn merge_triggers_apply_to_the_branch_that_receives_the_merge() {
    for (on, expected) in [
        (json!({"push":{"branches":["integration"]}}), true),
        (
            json!({"pull_request":{"types":["closed"],"branches":["integration"]}}),
            true,
        ),
        (
            json!({"pull_request_target":{"types":["closed"],"branches":["integration"]}}),
            true,
        ),
        (json!({"merge_group":{"branches":["integration"]}}), true),
        (
            json!({"pull_request":{"types":["opened","synchronize"]}}),
            false,
        ),
        (json!({"pull_request":null}), false),
        (json!({"push":{"branches":["other"]}}), false),
        (json!({"push":{"branches-ignore":["integration"]}}), false),
        (json!({"push":{"branches":"integration"}}), true),
        (json!({"push":{"unknown":true}}), true),
    ] {
        let mut v = input();
        v["workflows"] =
            json!([{"path":"workflow.json","content":json!({"on":on,"jobs":{}}).to_string()}]);
        let r = run(&v);
        assert_eq!(r["targetDeploys"], expected, "{on}");
        assert_eq!(
            !r["targetDeployReasons"].as_array().unwrap().is_empty(),
            expected
        );
    }
    for filter in [
        json!({}),
        json!({"branches":["team/**"]}),
        json!({"branches":["team/*/section/*"]}),
    ] {
        let mut v = input();
        v["workflows"] = json!([{"path":"workflow.json","content":json!({"on":{"push":filter},"jobs":{}}).to_string()}]);
        assert_eq!(run(&v)["lanes"][0]["lane"], "closed", "{filter}");
    }
    let mut v = input();
    v["workflows"] = json!([{"path":"workflow.json","content":json!({"on":{"push":{"branches":["integration"]}},"jobs":{}}).to_string()}]);
    assert_eq!(run(&v)["lanes"][0]["lane"], "contained");
    assert_eq!(run(&v)["targetDeploys"], true);
}
#[test]
fn workflow_run_resolves_upstream_merge_triggers_and_fails_closed_on_missing_or_cycles() {
    for (upstream, expected) in [
        (json!({"push":{"branches":["integration"]}}), true),
        (json!("workflow_dispatch"), false),
    ] {
        let mut v = input();
        v["workflows"] = json!([
            {"path":"ci.json","content":json!({"name":"CI","on":upstream,"jobs":{}}).to_string()},
            {"path":"follow.json","content":json!({"on":{"workflow_run":{"workflows":["CI"],"types":["completed"],"branches":["integration"]}},"jobs":{}}).to_string()}
        ]);
        let r = run(&v);
        assert_eq!(r["targetDeploys"], expected);
        assert_eq!(r["lanes"][0]["lane"], "contained");
        assert_eq!(
            r["targetDeployReasons"].as_array().unwrap().len(),
            if expected { 2 } else { 0 }
        );
    }
    for refs in [json!(["missing"]), json!(["Cycle"])] {
        let mut v = input();
        v["workflows"] = json!([{"path":"cycle.json","content":json!({"name":"Cycle","on":{"workflow_run":{"workflows":refs}},"jobs":{}}).to_string()}]);
        assert_eq!(run(&v)["targetDeploys"], true);
        assert_eq!(run(&v)["lanes"][0]["lane"], "closed");
    }
}
