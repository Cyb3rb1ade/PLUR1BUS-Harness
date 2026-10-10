//! Host dispatch remains offline: fake runtime executables and scratch state only.
use std::process::Command;
/// The fake container CLI is written and made executable once per process, before any test thread can reach `fork`:
/// Linux refuses to `exec` a file that some process still holds open for writing (ETXTBSY), and a `fork` on a sibling
/// test thread inherits the writer's descriptor until its own `exec`. Every test that forks calls this first, so no
/// fork can overlap the write. Each test then hard-links the template into its own directory (see apple.rs).
#[cfg(unix)]
fn container_template() -> &'static std::path::Path {
    use std::os::unix::fs::PermissionsExt;
    static T: std::sync::OnceLock<(tempfile::TempDir, std::path::PathBuf)> =
        std::sync::OnceLock::new();
    &T.get_or_init(|| {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("container");
        std::fs::write(
            &p,
            include_str!("../../plur1bus-containers/tests/fixtures/container.py"),
        )
        .unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o700)).unwrap();
        (d, p)
    })
    .1
}
fn cli(args: &[&str]) -> std::process::Output {
    #[cfg(unix)]
    container_template();
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
            fs::hard_link(super::container_template(), dir.path().join("container")).unwrap();
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
    // ---- containers.bindAddress / containers.apiPort and the SearXNG wiring ----
    fn write_config(e: &Env, containers: Value) {
        let home = e.dir.path().join("home");
        fs::create_dir_all(&home).unwrap();
        fs::write(
            home.join("config.json"),
            json!({"schemaVersion":1,"containers":containers}).to_string(),
        )
        .unwrap();
    }
    fn calls(e: &Env) -> String {
        fs::read_to_string(e.dir.path().join("calls.jsonl")).unwrap_or_default()
    }
    fn install(e: &Env, extra: &[&str]) -> Output {
        let tar = e.dir.path().join("image.tar");
        fs::write(&tar, b"synthetic").unwrap();
        let mut args = vec![
            "install",
            "--container",
            "--runtime",
            "apple",
            "--image",
            "local:test",
            "--image-from",
            tar.to_str().unwrap(),
        ];
        args.extend_from_slice(extra);
        e.run(&args)
    }
    #[test]
    fn bind_address_with_an_api_port_reaches_the_runtime_arguments() {
        for (bind, expected) in [
            ("127.0.0.1", "--publish\", \"127.0.0.1:28700:18700"),
            ("192.168.1.10", "--publish\", \"192.168.1.10:28700:18700"),
            (
                "100.101.102.103",
                "--publish\", \"100.101.102.103:28700:18700",
            ),
        ] {
            let e = Env::new();
            write_config(&e, json!({"bindAddress":bind,"apiPort":28700}));
            let v = assert_ok(install(&e, &["--non-interactive"]));
            assert!(calls(&e).contains(expected), "{bind}: {}", calls(&e));
            assert_eq!(v["published"][0]["address"], bind);
            assert_eq!(v["published"][0]["hostPort"], 28700);
            assert_eq!(v["published"][0]["containerPort"], 18700);
            let loopback = bind == "127.0.0.1";
            assert_eq!(
                v["warnings"].as_array().unwrap().len(),
                usize::from(!loopback),
                "{bind}"
            );
            let status = assert_ok(e.run(&["container", "status"]));
            assert_eq!(status["published"][0]["address"], bind);
            assert_eq!(
                status["warnings"].as_array().unwrap().len(),
                usize::from(!loopback),
                "{bind}"
            );
        }
    }
    #[test]
    fn loopback_is_the_default_address_for_a_published_port() {
        let e = Env::new();
        write_config(&e, json!({"apiPort":28700}));
        let v = assert_ok(install(&e, &["--non-interactive"]));
        assert!(
            calls(&e).contains("--publish\", \"127.0.0.1:28700:18700"),
            "{}",
            calls(&e)
        );
        assert_eq!(v["published"][0]["address"], "127.0.0.1");
        assert!(v["warnings"].as_array().unwrap().is_empty());
    }
    #[test]
    fn nothing_is_published_without_an_api_port_whatever_the_bind_address() {
        for containers in [json!({}), json!({"bindAddress":"192.168.1.10"})] {
            let e = Env::new();
            write_config(&e, containers);
            let v = assert_ok(install(&e, &["--non-interactive"]));
            assert!(!calls(&e).contains("--publish"), "{}", calls(&e));
            assert!(v["published"].as_array().unwrap().is_empty());
            assert!(v["warnings"].as_array().unwrap().is_empty());
        }
    }
    #[test]
    fn a_non_loopback_publish_needs_explicit_confirmation_unless_non_interactive() {
        let e = Env::new();
        write_config(&e, json!({"bindAddress":"192.168.1.10","apiPort":28700}));
        let o = install(&e, &[]);
        assert!(!o.status.success());
        let v = doc(&o);
        assert_eq!(v["reason"], "confirmation-required", "{v}");
        assert!(
            v["message"].as_str().unwrap_or("").contains("192.168.1.10"),
            "{v}"
        );
        assert!(!e.dir.path().join("home/container-install.json").exists());
        assert!(
            !calls(&e).contains("\"create\""),
            "nothing may be created: {}",
            calls(&e)
        );
    }
    #[test]
    fn the_plan_shows_what_would_be_published_and_warns_without_touching_the_runtime() {
        let e = Env::new();
        write_config(&e, json!({"bindAddress":"10.1.2.3","apiPort":28700}));
        let v = assert_ok(install(&e, &["--container-plan"]));
        assert_eq!(v["published"][0]["address"], "10.1.2.3");
        assert!(v["warnings"][0].as_str().unwrap().contains("10.1.2.3"));
        assert!(!calls(&e).contains("--publish"));
        assert!(!e.dir.path().join("home/container-install.json").exists());
    }
    #[test]
    fn api_port_must_be_an_unprivileged_port() {
        for bad in [json!(0), json!(80), json!(70000), json!("28700")] {
            let e = Env::new();
            write_config(&e, json!({"apiPort":bad}));
            let o = install(&e, &["--container-plan"]);
            assert!(!o.status.success(), "{bad}");
        }
    }
    fn connections(v: &Value) -> Vec<Value> {
        let services = v["services"].as_array().unwrap();
        services.last().unwrap()["connections"]
            .as_array()
            .unwrap()
            .clone()
    }
    #[test]
    fn a_bundled_searxng_is_wired_into_the_harness_through_its_private_address() {
        let e = Env::new();
        let v = assert_ok(install(
            &e,
            &["--sidecar", "searxng=bundled", "--container-plan"],
        ));
        let harness = v["services"].as_array().unwrap().last().unwrap().clone();
        assert_eq!(harness["name"], "plur1bus-harness");
        assert!(
            connections(&v)
                .iter()
                .any(|c| c["env"] == "PLUR1BUS_SEARXNG_URL"
                    && c["service"] == "plur1bus-searxng"
                    && c["scheme"] == "http"
                    && c["port"] == 8080
                    && c["path"] == ""),
            "{harness}"
        );
        assert!(harness["env"]
            .as_array()
            .unwrap()
            .iter()
            .any(|x| x == "PLUR1BUS_SEARXNG_MODE=bundled"));
    }
    #[test]
    fn a_bundled_searxng_hands_the_harness_the_address_the_runtime_reports() {
        let e = Env::new();
        assert_ok(install(
            &e,
            &["--sidecar", "searxng=bundled", "--non-interactive"],
        ));
        let harness_create = calls(&e)
            .lines()
            .rfind(|l| l.contains("\"create\"") && l.contains("plur1bus-harness"))
            .unwrap()
            .to_string();
        assert!(
            harness_create.contains("PLUR1BUS_SEARXNG_URL=http://192.168.88.2:8080"),
            "{harness_create}"
        );
        assert!(
            harness_create.contains("PLUR1BUS_SEARXNG_MODE=bundled"),
            "{harness_create}"
        );
    }
    #[test]
    fn a_remote_searxng_is_handed_over_as_its_url_and_creates_no_container() {
        let e = Env::new();
        let v = assert_ok(install(
            &e,
            &[
                "--sidecar",
                "searxng=http://100.64.0.7:8080",
                "--container-plan",
            ],
        ));
        assert_eq!(v["services"].as_array().unwrap().len(), 1);
        let env = v["services"][0]["env"].as_array().unwrap().clone();
        assert!(
            env.iter().any(|x| x == "PLUR1BUS_SEARXNG_MODE=remote"),
            "{env:?}"
        );
        assert!(
            env.iter()
                .any(|x| x == "PLUR1BUS_SEARXNG_URL=http://100.64.0.7:8080"),
            "{env:?}"
        );
        assert!(connections(&v).is_empty());
    }
    #[test]
    fn no_searxng_means_no_search_wiring_at_all() {
        let e = Env::new();
        for extra in [
            &["--container-plan"][..],
            &["--sidecar", "searxng=off", "--container-plan"][..],
        ] {
            let v = assert_ok(install(&e, extra));
            let harness = &v["services"][0];
            assert!(harness["env"]
                .as_array()
                .unwrap()
                .iter()
                .all(|x| !x.as_str().unwrap().starts_with("PLUR1BUS_SEARXNG")));
            assert!(connections(&v).is_empty());
        }
    }
    #[test]
    fn an_existing_install_gets_the_wiring_on_its_next_start_without_a_reinstall() {
        let e = Env::new();
        e.installed();
        let home = e.dir.path().join("home");
        let path = home.join("container-install.json");
        let mut state: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        let searxng = {
            let mut s = Service::harness(&e.image("old"));
            s.name = "plur1bus-searxng".into();
            s.egress = false;
            s.port = 8080;
            serde_json::to_value(s).unwrap()
        };
        let harness = state["services"][0].clone();
        state["services"] = json!([searxng, harness]); // the record an older release wrote: no connection on the harness
        state["sidecars"] = json!({"searxng":{"mode":"bundled","timeoutMs":5000}});
        fs::write(&path, serde_json::to_vec(&state).unwrap()).unwrap();
        assert_ok(e.run(&["container", "down"]));
        assert_ok(e.run(&["container", "up"]));
        let harness_create = calls(&e)
            .lines()
            .rfind(|l| l.contains("\"create\"") && l.contains("plur1bus-harness"))
            .unwrap()
            .to_string();
        assert!(
            harness_create.contains("PLUR1BUS_SEARXNG_URL=http://192.168.88.2:8080"),
            "{harness_create}"
        );
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
