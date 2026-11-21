use super::*;
use crate::policy::fs_paths::RealFs;
use serde_json::json;
use std::fs;

#[test]
fn coding_root_vectors() {
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("../../../../fixtures/parity/coding/root.json")).unwrap();
    let d = tempfile::tempdir().unwrap();
    let full = |rel: &str| d.path().join(rel).to_str().unwrap().to_owned();
    for path in ["work/nested", "core-home/state"] {
        fs::create_dir_all(d.path().join(path)).unwrap();
    }
    let work = RealFs.realpath(&full("work")).unwrap();
    let git = |_: &str, args: &[&str]| {
        assert_eq!(args, ["rev-parse", "--show-toplevel"]);
        Ok(format!("{work}\n"))
    };
    let roots = [PathRoot {
        id: "work".to_owned(),
        path: work.clone(),
        identity: None,
    }];
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let raw = match name {
            "configured" | "outside configured" => full("work"),
            "not absolute" => "work".to_owned(),
            "not top-level" => full("work/nested"),
            "private state" => full("core-home/state"),
            "parent of core home" => full(""),
            "does not exist" => full("missing"),
            _ => panic!("unknown case {name}"),
        };
        let got = coding_root(
            &raw,
            &RootProbe {
                fs: &RealFs,
                git: &git,
                core_home: &full("core-home"),
                roots: if name == "configured" { &roots } else { &[] },
                deny: &json!([]),
            },
        );
        let wire = match got {
            Ok(r) => {
                json!({ "ok": { "rootId": r.root_id(), "exists": r.exists(), "systemTree": r.system_tree() } })
            }
            Err(e) => {
                json!({"err": { "code": if e.code == C::Unauthorized { "E_DENIED" } else { "E_INVALID_PARAMS" },
                "message": e.message, "reason": e.reason }})
            }
        };
        assert_eq!(wire, case["result"], "{name}");
    }
}
