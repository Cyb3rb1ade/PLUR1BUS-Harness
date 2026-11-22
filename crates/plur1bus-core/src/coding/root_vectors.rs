use super::*;
use crate::policy::fs_paths::RealFs;
use serde_json::json;
use std::fs;

#[test]
fn coding_root_vectors() {
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("../../../../fixtures/parity/coding/root.json")).unwrap();
    let d = tempfile::tempdir().unwrap();
    // Windows may supply the temporary base through an 8.3 alias.
    let base = std::path::PathBuf::from(real(&RealFs, d.path().to_str().unwrap()).unwrap());
    let work = base.join("work");
    let core_home = base.join("core-home");
    let nested = work.join("nested");
    let private = core_home.join("state");
    let missing = base.join("missing");
    for path in [&nested, &private] {
        fs::create_dir_all(path).unwrap();
    }
    let work_text = work.to_str().unwrap();
    let git = |_: &str, args: &[&str]| {
        assert_eq!(args, ["rev-parse", "--show-toplevel"]);
        Ok(format!("{work_text}\n"))
    };
    let roots = [PathRoot {
        id: "work".to_owned(),
        path: work_text.to_owned(),
        identity: None,
    }];
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let raw = match name {
            "configured" | "outside configured" => work.as_path(),
            "not absolute" => Path::new("work"),
            "not top-level" => nested.as_path(),
            "private state" => private.as_path(),
            "parent of core home" => base.as_path(),
            "does not exist" => missing.as_path(),
            _ => panic!("unknown case {name}"),
        };
        let got = coding_root(
            raw.to_str().unwrap(),
            &RootProbe {
                fs: &RealFs,
                git: &git,
                core_home: core_home.to_str().unwrap(),
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
