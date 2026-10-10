//! Host dispatch remains offline: fake runtime executables and scratch state only.
use std::process::Command;
fn cli(args: &[&str]) -> std::process::Output {
    let home = tempfile::tempdir().unwrap();
    Command::new(env!("CARGO_BIN_EXE_plur1bus"))
        .arg("--home")
        .arg(home.path())
        .arg("--json")
        .args(args)
        .env("PLUR1BUS_CONTAINER", "1")
        .output()
        .unwrap()
}
#[test]
fn installation_inside_image_stays_refused() {
    for args in [
        &["install", "--container"][..],
        &["setup", "--container"][..],
    ] {
        let o = cli(args);
        let v: serde_json::Value = serde_json::from_slice(&o.stdout).unwrap();
        assert!(!o.status.success());
        assert_eq!(v["reason"], "container-managed", "{v}");
    }
}
#[test]
fn container_leaves_have_json_errors() {
    for leaf in ["status", "up", "down", "logs"] {
        let o = cli(&["container", leaf]);
        let v: serde_json::Value = serde_json::from_slice(&o.stdout).unwrap();
        assert!(!o.status.success());
        assert_eq!(v["reason"], "container-managed", "{v}");
    }
}

#[cfg(unix)]
mod host {
    use plur1bus_containers::Service;
    use serde_json::{json, Value};
    use std::{
        fs,
        os::unix::fs::PermissionsExt,
        process::{Command, Output},
    };
    struct Env {
        dir: tempfile::TempDir,
        key: minisign::KeyPair,
    }
    impl Env {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            fs::write(
                dir.path().join("container"),
                include_str!("../../plur1bus-containers/tests/fixtures/container.py"),
            )
            .unwrap();
            fs::set_permissions(
                dir.path().join("container"),
                fs::Permissions::from_mode(0o700),
            )
            .unwrap();
            Self {
                dir,
                key: minisign::KeyPair::generate_unencrypted_keypair().unwrap(),
            }
        }
        fn run(&self, args: &[&str]) -> Output {
            Command::new(env!("CARGO_BIN_EXE_plur1bus"))
                .arg("--home")
                .arg(self.dir.path().join("home"))
                .arg("--json")
                .args(args)
                .env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1")
                .env_remove("PLUR1BUS_CONTAINER")
                .env(
                    "PLUR1BUS_TEST_CONTAINER_CLI",
                    self.dir.path().join("container"),
                )
                .env(
                    "DOCKER_HOST",
                    format!("unix://{}", self.dir.path().join("missing.sock").display()),
                )
                .env("PLUR1BUS_TEST_RELEASE_PUBKEY", self.key.pk.to_base64())
                .output()
                .unwrap()
        }
        fn image(&self, repo: &str) -> String {
            format!("ghcr.io/test/{repo}@sha256:{}", "a".repeat(64))
        }
        fn installed(&self) {
            let home = self.dir.path().join("home");
            fs::create_dir_all(&home).unwrap();
            let s = Service::harness(&self.image("old"));
            let state = json!({"schema":"plur1bus.container-install/1","runtime":"apple","services":[s],"version":"0.1.0","channel":"stable","storeSchema":1,"healthTimeoutMs":1,"sidecars":{},"previous":null,"previousVersion":null,"pending":false});
            fs::write(
                home.join("container-install.json"),
                serde_json::to_vec(&state).unwrap(),
            )
            .unwrap();
            assert_ok(self.run(&["container", "up"]));
        }
        fn feed(&self, repo: &str, schema: u32) -> String {
            let v = json!({"version":"0.2.0","channel":"stable","minFromVersion":"0.1.0","containers":{"image":self.image(repo),"storeSchema":schema}});
            let bytes = serde_json::to_vec(&v).unwrap();
            let path = self.dir.path().join("stable.json");
            fs::write(&path, &bytes).unwrap();
            let sig =
                minisign::sign(Some(&self.key.pk), &self.key.sk, &bytes[..], None, None).unwrap();
            fs::write(self.dir.path().join("stable.json.minisig"), sig.to_string()).unwrap();
            path.to_string_lossy().into_owned()
        }
    }
    fn doc(o: &Output) -> Value {
        serde_json::from_slice(&o.stdout).unwrap_or_else(|e| {
            panic!(
                "{e}: {:?} {:?}",
                o.stdout,
                String::from_utf8_lossy(&o.stderr)
            )
        })
    }
    fn assert_ok(o: Output) -> Value {
        assert!(
            o.status.success(),
            "{} {}",
            String::from_utf8_lossy(&o.stdout),
            String::from_utf8_lossy(&o.stderr)
        );
        doc(&o)
    }
    #[test]
    fn fake_host_stack_commands_and_log_json() {
        let e = Env::new();
        e.installed();
        let v = assert_ok(e.run(&["container", "status"]));
        assert_eq!(v["schema"], "container.status/1");
        let v = assert_ok(e.run(&["container", "logs"]));
        assert_eq!(v["line"], "fake log");
        assert_ok(e.run(&["container", "down"]));
        assert_ok(e.run(&["container", "up"]));
    }
    #[test]
    fn signed_host_image_update_health_rollback_and_manual_rollback() {
        let e = Env::new();
        e.installed();
        let feed = e.feed("next", 1);
        let before = fs::read(e.dir.path().join("home/container-install.json")).unwrap();
        let v = assert_ok(e.run(&["update", "--plan", "--manifest", &feed]));
        assert_eq!(v["verified"], true);
        assert_eq!(
            before,
            fs::read(e.dir.path().join("home/container-install.json")).unwrap()
        );
        assert_ok(e.run(&["update", "--yes", "--manifest", &feed]));
        let state: Value = serde_json::from_slice(
            &fs::read(e.dir.path().join("home/container-install.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(state["version"], "0.2.0");
        assert_ok(e.run(&["update", "--rollback"]));
        let feed = e.feed("bad", 1);
        let o = e.run(&["update", "--yes", "--manifest", &feed]);
        assert!(!o.status.success());
        assert!(
            doc(&o)["error"]["message"]
                .as_str()
                .unwrap_or("")
                .contains("rollback")
                || String::from_utf8_lossy(&o.stdout).contains("rollback")
        );
        let v = assert_ok(e.run(&["container", "status"]));
        assert!(v.to_string().contains("/old@sha256"));
    }
    #[test]
    fn unverified_tampered_and_schema_changing_offers_never_touch_runtime() {
        let e = Env::new();
        e.installed();
        let feed = e.feed("next", 2);
        let before = fs::read(e.dir.path().join("calls.jsonl")).unwrap();
        assert!(!e
            .run(&["update", "--yes", "--manifest", &feed])
            .status
            .success());
        fs::write(&feed, b"{}").unwrap();
        assert!(!e
            .run(&["update", "--yes", "--manifest", &feed])
            .status
            .success());
        assert_eq!(before, fs::read(e.dir.path().join("calls.jsonl")).unwrap());
    }
    #[test]
    fn offline_install_and_plan_use_fake_runtime_only() {
        let e = Env::new();
        let tar = e.dir.path().join("image.tar");
        fs::write(&tar, b"fake tar").unwrap();
        let v = assert_ok(e.run(&[
            "install",
            "--container",
            "--runtime",
            "apple",
            "--image",
            "local:test",
            "--image-from",
            tar.to_str().unwrap(),
            "--container-plan",
        ]));
        assert_eq!(v["schema"], "container.install/1");
        assert!(!e.dir.path().join("home/container-install.json").exists());
        assert_ok(e.run(&[
            "install",
            "--container",
            "--runtime",
            "apple",
            "--image",
            "local:test",
            "--image-from",
            tar.to_str().unwrap(),
            "--non-interactive",
        ]));
        assert_ok(e.run(&["container", "status"]));
    }
    #[test]
    fn initial_install_resolves_a_signed_feed_without_an_image_flag() {
        let e = Env::new();
        let feed = e.feed("initial", 1);
        let args = [
            "install",
            "--container",
            "--runtime",
            "apple",
            "--container-manifest",
            &feed,
        ];
        let mut plan = args.to_vec();
        plan.push("--container-plan");
        let v = assert_ok(e.run(&plan));
        assert_eq!(v["services"][0]["image"], e.image("initial"));
        assert!(!e.dir.path().join("home/container-install.json").exists());
        let mut apply = args.to_vec();
        apply.push("--non-interactive");
        assert_ok(e.run(&apply));
        let record: Value = serde_json::from_slice(
            &fs::read(e.dir.path().join("home/container-install.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(record["version"], "0.2.0");
    }
    #[test]
    fn bundled_search_can_use_remote_valkey_without_a_local_valkey_container() {
        let e = Env::new();
        let image = e.image("local");
        let v = assert_ok(e.run(&[
            "install",
            "--container",
            "--runtime",
            "apple",
            "--image",
            &image,
            "--sidecar",
            "searxng=bundled",
            "--sidecar",
            "valkey=valkey://100.64.0.2:6379/0",
            "--container-plan",
        ]));
        let services = v["services"].as_array().unwrap();
        assert_eq!(services.len(), 2);
        assert!(!services.iter().any(|s| s["name"] == "plur1bus-valkey"));
        assert!(services[0]["env"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e == "SEARXNG_VALKEY_URL=valkey://100.64.0.2:6379/0"));
    }
    #[test]
    fn sidecar_settings_stay_private_even_in_an_existing_shared_home() {
        let e = Env::new();
        let home = e.dir.path().join("home");
        fs::create_dir_all(&home).unwrap();
        fs::set_permissions(&home, fs::Permissions::from_mode(0o755)).unwrap();
        let tar = e.dir.path().join("image.tar");
        fs::write(&tar, b"synthetic").unwrap();
        assert_ok(e.run(&[
            "install",
            "--container",
            "--runtime",
            "apple",
            "--image",
            "local:test",
            "--image-from",
            tar.to_str().unwrap(),
            "--sidecar",
            "searxng=bundled",
            "--non-interactive",
        ]));
        assert_eq!(
            fs::metadata(home.join("container-sidecars"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert!(home.join("container-sidecars/config/settings.yml").exists());
    }
}

#[cfg(unix)]
#[test]
fn container_config_refuses_wildcard_binding() {
    for ip in ["0.0.0.0", "::"] {
        let mut config = plur1bus_config::defaults();
        config["containers"] = serde_json::json!({"bindAddress":ip});
        assert!(plur1bus_config::parse(&config.to_string()).is_err());
    }
    let mut config = plur1bus_config::defaults();
    config["containers"] = serde_json::json!({"bindAddress":"192.168.1.10"});
    assert!(plur1bus_config::parse(&config.to_string()).is_ok());
}
