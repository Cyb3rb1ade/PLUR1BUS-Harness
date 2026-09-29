//! `cargo run -p plur1bus-ext --features testkit --example make-fixtures -- <dir>`: writes the fixtures the X1 tests
//! and the system test install from. Every key is generated in memory for this run; the public half goes to
//! `pubkeys.env` as `PLUR1BUS_TEST_EXT_PUBKEYS=test=<base64>` and nothing else is written.
//!
//! Files: `signed-skill.p1x`, `unsigned-folder-skill/` (with `scripts/run.sh`), `module-fixture.p1x` (payload from
//! `$PLUR1BUS_FIXTURE_MODULE`, else `packages/module-fixture/dist`), `fixture-b.p1x` (needs `fixture`), the eight
//! `Tamper` variants of the signed skill as `tampered-<slug>.p1x`, and `pubkeys.env`.
use plur1bus_ext::pack::PayloadFile;
use plur1bus_ext::testkit::{build_package_from, tamper, test_key, Tamper};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

fn file(rel: &str, text: &str, exec: bool) -> PayloadFile {
    PayloadFile {
        rel: rel.to_string(),
        bytes: text.as_bytes().to_vec(),
        exec,
    }
}

fn skill_template(name: &str, capabilities: Value) -> Value {
    json!({
        "$schema": "https://plur1bus.app/schema/p1x/1/p1x.schema.json",
        "format": 1,
        "id": format!("fixtures/{name}"),
        "name": name,
        "version": "1.0.0",
        "kind": "skill",
        "title": { "en": "Demo skill" },
        "summary": { "en": "A synthetic skill for the extension tests." },
        "publisher": { "id": "fixtures", "name": "Fixtures" },
        "licence": "MIT",
        "compat": { "harness": ">=0.0.0" },
        "requires": { "runtime": { "type": "none" } },
        "capabilities": capabilities
    })
}

fn no_capabilities() -> Value {
    json!({
        "network": { "mode": "none" },
        "filesystem": [],
        "processes": { "spawn": false },
        "harness": { "authority": "none" }
    })
}

fn module_template(name: &str, version: &str, dependencies: Value) -> Value {
    json!({
        "$schema": "https://plur1bus.app/schema/p1x/1/p1x.schema.json",
        "format": 1,
        "id": format!("fixtures/{name}"),
        "name": name,
        "version": version,
        "kind": "module",
        "title": { "en": name },
        "summary": { "en": "A synthetic module for the extension tests." },
        "publisher": { "id": "fixtures", "name": "Fixtures" },
        "licence": "MIT",
        "compat": { "harness": ">=0.0.0", "moduleApi": ["1"] },
        "requires": { "runtime": { "type": "node", "range": ">=24" } },
        "dependencies": dependencies,
        "capabilities": {
            "network": { "mode": "none" },
            "filesystem": [{ "scope": "extension-data", "access": "read-write" }],
            "processes": { "spawn": false },
            "harness": { "authority": "full" }
        }
    })
}

fn read_tree(root: &Path) -> Vec<PayloadFile> {
    fn go(dir: &Path, rel: &str, out: &mut Vec<PayloadFile>) {
        for e in std::fs::read_dir(dir).expect("read the module directory") {
            let e = e.expect("entry");
            let name = e.file_name().into_string().expect("UTF-8 name");
            let r = if rel.is_empty() {
                name
            } else {
                format!("{rel}/{name}")
            };
            let ty = e.file_type().expect("file type");
            assert!(!ty.is_symlink(), "{r}: a symlink in the module directory");
            if ty.is_dir() {
                go(&e.path(), &r, out);
            } else {
                out.push(PayloadFile {
                    rel: r,
                    bytes: std::fs::read(e.path()).expect("read"),
                    exec: false,
                });
            }
        }
    }
    let mut out = Vec::new();
    go(root, "", &mut out);
    out
}

fn main() {
    let dir = PathBuf::from(std::env::args().nth(1).unwrap_or_else(|| {
        eprintln!("usage: make-fixtures <dir>");
        std::process::exit(2)
    }));
    std::fs::create_dir_all(&dir).expect("create the output directory");
    let out = |name: &str, bytes: &[u8]| std::fs::write(dir.join(name), bytes).expect("write");
    let key = test_key("test");

    // A signed skill without scripts, and its eight broken variants.
    let signed = build_package_from(
        &skill_template("demo-skill", no_capabilities()),
        vec![
            file(
                "SKILL.md",
                "---\nname: demo-skill\ndescription: A synthetic skill for the extension tests.\nlicense: MIT\n---\n\n# Demo skill\n",
                false,
            ),
            file("references/notes.md", "Reference notes.\n", false),
        ],
        Some(&key),
    );
    out("signed-skill.p1x", &signed);
    for how in Tamper::ALL {
        out(
            &format!("tampered-{}.p1x", how.slug()),
            &tamper(&signed, how),
        );
    }

    // An unsigned skill folder with a script: `install <dir>` normalises it.
    let folder = dir.join("unsigned-folder-skill");
    let _ = std::fs::remove_dir_all(&folder);
    std::fs::create_dir_all(folder.join("scripts")).expect("create the skill folder");
    std::fs::write(
        folder.join("SKILL.md"),
        "---\nname: unsigned-folder-skill\ndescription: A synthetic skill with a script.\n---\n\n# Unsigned folder skill\n",
    )
    .expect("write SKILL.md");
    let script = folder.join("scripts/run.sh");
    std::fs::write(&script, "#!/bin/sh\necho demo\n").expect("write run.sh");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    }

    // The fixture module, and one that needs it.
    let module_dir = std::env::var_os("PLUR1BUS_FIXTURE_MODULE")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/module-fixture/dist")
        });
    let files = read_tree(&module_dir);
    let module_json = files
        .iter()
        .find(|f| f.rel == "module.json")
        .unwrap_or_else(|| {
            panic!(
                "{} has no module.json (build packages/module-fixture first)",
                module_dir.display()
            )
        });
    let mj: Value = serde_json::from_slice(&module_json.bytes).expect("module.json is JSON");
    let version = mj["version"]
        .as_str()
        .expect("module.json version")
        .to_string();
    out(
        "module-fixture.p1x",
        &build_package_from(
            &module_template("fixture", &version, json!([])),
            files.clone(),
            Some(&key),
        ),
    );
    let mut b_files = files;
    for f in b_files.iter_mut().filter(|f| f.rel == "module.json") {
        let mut v: Value = serde_json::from_slice(&f.bytes).expect("module.json");
        v["name"] = json!("fixture-b");
        let needs = v["needs"].as_array_mut().expect("needs");
        needs.push(json!("fixture"));
        f.bytes = serde_json::to_vec_pretty(&v).expect("serialise");
    }
    out(
        "fixture-b.p1x",
        &build_package_from(
            &module_template(
                "fixture-b",
                &version,
                json!([{ "id": "fixtures/fixture", "range": ">=0.1.0" }]),
            ),
            b_files,
            Some(&key),
        ),
    );

    out(
        "pubkeys.env",
        format!(
            "PLUR1BUS_TEST_EXT_PUBKEYS={}={}\n",
            key.label, key.public_b64
        )
        .as_bytes(),
    );
}
