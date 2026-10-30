//! Bundles verify every nested member before lifecycle staging and never recurse or acquire operational rights.
use plur1bus_ext::{
    compat::HostFacts,
    manifest::Kind,
    pack::PayloadFile,
    refusal::Refusal,
    testkit::{build_package_from, test_key, TestKey},
    trust::TrustStore,
    verify::{inspect_reader_kinds, Inspection, Policy, X2_KINDS, X2_RPC_KINDS},
    zipaudit::Limits,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::Cursor;

fn template(name: &str, kind: &str) -> Value {
    json!({"format":1,"id":format!("demo/{name}"),"name":name,"version":"1.0.0","kind":kind,
    "title":{"en":"Bundle fixture"},"summary":{"en":"Verified members"},"publisher":{"id":"demo","name":"Demo"},"licence":"MIT",
    "compat":{"harness":">=0.0.0"},"requires":{"runtime":{"type":"none"}},
    "capabilities":{"network":{"mode":"none"},"filesystem":[],"processes":{"spawn":false},"harness":{"authority":"none"}}})
}
fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
fn skill(name: &str, key: Option<&TestKey>) -> Vec<u8> {
    build_package_from(
        &template(name, "skill"),
        vec![PayloadFile {
            rel: "SKILL.md".into(),
            bytes: format!("---\nname: {name}\ndescription: Member\n---\nbody\n").into_bytes(),
            exec: false,
        }],
        key,
    )
}
fn bundle_template(children: &[(&str, bool, Vec<u8>)]) -> (Value, Vec<PayloadFile>) {
    let mut manifest = template("pack", "bundle");
    manifest["members"]=json!(children.iter().map(|(name,optional,bytes)|json!({"name":name,"path":format!("payload/members/{name}.p1x"),"sha256":digest(bytes),"optional":optional})).collect::<Vec<_>>());
    let files = children
        .iter()
        .map(|(name, _, bytes)| PayloadFile {
            rel: format!("members/{name}.p1x"),
            bytes: bytes.clone(),
            exec: false,
        })
        .collect();
    (manifest, files)
}
fn bundle(children: &[(&str, bool, Vec<u8>)]) -> Vec<u8> {
    let (m, f) = bundle_template(children);
    build_package_from(&m, f, None)
}
fn inspect(
    bytes: &[u8],
    kinds: &[Kind],
    revoked: &dyn Fn(&str, &str) -> Option<String>,
) -> Result<Inspection, Refusal> {
    let host = HostFacts {
        harness_version: "0.3.0".into(),
        module_api_current: 1,
        rpc_version: "1.7.0".into(),
        platform: None,
        container: false,
    };
    let store = TrustStore::with_test_keys(false, None).unwrap();
    inspect_reader_kinds(
        &mut Cursor::new(bytes),
        &Policy {
            limits: Limits::default(),
            skill_bytes: 16 * 1024 * 1024,
            store: &store,
            host: &host,
            reserved: &["core"],
            revoked,
        },
        kinds,
    )
}
fn allowed(bytes: &[u8]) -> Result<Inspection, Refusal> {
    inspect(bytes, &X2_RPC_KINDS, &|_, _| None)
}

#[test]
fn complete_member_hashes_names_and_child_packages_are_mandatory() {
    let children = [("member", false, skill("member", None))];
    let (m, files) = bundle_template(&children);
    for case in [
        "missing-members",
        "wrong-hash",
        "wrong-name",
        "duplicate-name",
        "too-many",
    ] {
        let mut bad = m.clone();
        match case {
            "missing-members" => {
                bad.as_object_mut().unwrap().remove("members");
            }
            "wrong-hash" => bad["members"][0]["sha256"] = json!("0".repeat(64)),
            "wrong-name" => bad["members"][0]["name"] = json!("other"),
            "duplicate-name" => {
                bad["members"] = json!([m["members"][0], m["members"][0]]);
            }
            _ => bad["members"] = json!(vec![m["members"][0].clone(); 257]),
        }
        assert!(
            allowed(&build_package_from(&bad, files.clone(), None)).is_err(),
            "accepted {case}"
        );
    }
    assert!(
        allowed(&bundle(&[("member", false, b"not a p1x".to_vec())])).is_err(),
        "outer hashes alone cannot approve a malformed child"
    );
}

#[test]
fn bundles_never_recurse_and_cannot_smuggle_a_provider_through_the_rpc_policy() {
    let nested = bundle(&[("member", false, skill("member", None))]);
    assert!(allowed(&bundle(&[("pack", false, nested)])).is_err());
    let mut provider = template("provider", "provider");
    provider["provider"] = json!({"api":"chat_completions","baseUrl":"https://api.example.org/v1"});
    provider["capabilities"]["network"] = json!({"mode":"allowlist","hosts":["api.example.org"]});
    provider["capabilities"]["secrets"] =
        json!([{"slot":"apiKey","label":{"en":"Key"},"required":true}]);
    let bytes = build_package_from(
        &provider,
        vec![PayloadFile {
            rel: "README.md".into(),
            bytes: b"Provider\n".to_vec(),
            exec: false,
        }],
        None,
    );
    let container = bundle(&[("provider", false, bytes)]);
    assert!(allowed(&container).is_err());
    assert!(
        inspect(&container, &X2_KINDS, &|_, _| None).is_ok(),
        "the explicit library policy retains provider support"
    );
}

#[test]
fn wrapper_rights_are_inert_and_revoked_members_fail_the_whole_bundle() {
    let children = [("member", false, skill("member", None))];
    let (m, files) = bundle_template(&children);
    for (field, value) in [
        ("runtime", json!({"type":"node","range":">=24"})),
        ("network", json!({"mode":"any"})),
        ("spawn", json!(true)),
        (
            "secrets",
            json!([{"slot":"token","label":{"en":"Token"},"required":true}]),
        ),
    ] {
        let mut bad = m.clone();
        match field {
            "runtime" => bad["requires"]["runtime"] = value,
            "spawn" => bad["capabilities"]["processes"]["spawn"] = value,
            _ => bad["capabilities"][field] = value,
        };
        assert!(
            allowed(&build_package_from(&bad, files.clone(), None)).is_err(),
            "accepted operational wrapper {field}"
        );
    }
    assert!(inspect(&bundle(&children), &X2_RPC_KINDS, &|id, _| (id
        == "demo/member")
        .then(|| "revoked member".into()))
    .is_err());
    // An untrusted child signer stays untrusted; the enclosing wrapper cannot promote it.
    let key = test_key("untrusted-member");
    assert!(allowed(&bundle(&[("member", false, skill("member", Some(&key)))])).is_ok());
}
