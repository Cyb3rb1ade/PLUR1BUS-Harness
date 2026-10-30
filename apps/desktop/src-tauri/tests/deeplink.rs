use plur1bus_desktop::deeplink::{parse, DeepLink};

#[test]
fn pair_link_prefills_and_never_pairs() {
    let parsed = parse("plur1bus://pair?origin=https%3A%2F%2Fharness.test&code=ABCD-1234");
    match parsed {
        DeepLink::Pair {
            origin,
            code,
            pin,
            ca,
        } => {
            assert_eq!(origin.as_str(), "https://harness.test");
            assert_eq!(code, "ABCD-1234");
            assert!(pin.is_none() && ca.is_none());
        }
        _ => panic!("pair intent missing"),
    }
}
#[test]
fn open_link_rejects_absolute_and_foreign_paths() {
    assert!(
        matches!(parse("plur1bus://open?path=%2Fsettings%2Fgeneral"), DeepLink::Open { path } if path == "/settings/general")
    );
    for path in [
        "https%3A%2F%2Fevil.test",
        "%2F%2Fevil.test",
        "%2Fapi%2Fv1",
        "%2Fauth%2Fticket",
        "%2Fchat%2F..",
        "%2Fchat%2Fjavascript%3Aalert",
        "%2Fchat%2F%252e%252e",
        "%2Fgallery",
        "%2Flogin",
        "%2Fchat%3Ftoken%3Dx",
    ] {
        assert!(
            matches!(
                parse(&format!("plur1bus://open?path={path}")),
                DeepLink::Ignored
            ),
            "unsafe path accepted"
        );
    }
}
#[test]
fn install_link_accepts_catalogue_ids_only() {
    assert!(
        matches!(parse("plur1bus://install?id=skill.example-1"), DeepLink::Install { catalogue_id } if catalogue_id == "skill.example-1")
    );
    for id in [
        "",
        "https%3A%2F%2Fevil.test%2Fa.p1x",
        "..",
        "%2Ftmp%2Fa.p1x",
        "file%3Afoo",
        "-option",
        "%252Ftmp",
    ] {
        assert!(matches!(
            parse(&format!("plur1bus://install?id={id}")),
            DeepLink::Ignored
        ));
    }
}
#[test]
fn malformed_input_is_ignored_before_normalization() {
    for input in [
        "plur1bus://pair?origin=https%3A%2F%2Fharness.test&code=ABCD-1234&code=EFGH-5678",
        "plur1bus://open?path=%2Fchat&extra=x",
        "plur1bus://open/../open?path=%2Fchat",
        "plur1bus://open?path=%2Fchát",
        "plur1bus://open?path=%2Fchat%00",
        "plur1bus://open?path=%2Fchat%",
        "plur1bus://open?path=%2fchat#x",
        "plur1bus://user@open?path=%2Fchat",
        "plur1bus://open:80?path=%2Fchat",
        "plur1bus://OPEN?path=%2Fchat",
        "plur1bus://pair?origin=http%3A%2F%2Fevil.test&code=ABCD-1234",
    ] {
        assert!(
            matches!(parse(input), DeepLink::Ignored),
            "malformed input accepted"
        );
    }
    assert!(matches!(parse(&"x".repeat(100_000)), DeepLink::Ignored));
}
#[test]
fn parser_property_arbitrary_bytes_cannot_produce_unsafe_paths() {
    // Deterministic mutation corpus; no extra property-test dependency.
    let seeds = [
        "plur1bus://open?path=%2Fchat",
        "plur1bus://pair?origin=https%3A%2F%2Fharness.test&code=ABCD-1234",
        "plur1bus://install?id=skill.example",
    ];
    for seed in seeds {
        for index in 0..seed.len() {
            for byte in 0..=255u8 {
                let mut bytes = seed.as_bytes().to_vec();
                bytes[index] = byte;
                let input = String::from_utf8_lossy(&bytes);
                match parse(&input) {
                    DeepLink::Open { path } => {
                        assert!(plur1bus_desktop::deeplink::allowed_path(&path))
                    }
                    DeepLink::Pair { origin, .. } => {
                        assert!(origin.as_str().starts_with("https:") || origin.is_loopback())
                    }
                    _ => (),
                }
            }
        }
    }
}

#[test]
fn argv_links_take_the_same_path() {
    let input = "plur1bus://open?path=%2Fchat";
    let mut inbox = plur1bus_desktop::deeplink::Inbox::default();
    let mut logs = Vec::new();
    inbox.argv(["app", input], |line| logs.push(line));
    assert!(logs.is_empty());
    assert!(inbox.take().is_some_and(|e| e.intent == parse(input)));
}
#[test]
fn unknown_links_are_ignored_and_logged_without_args() {
    let mut inbox = plur1bus_desktop::deeplink::Inbox::default();
    let mut logs = Vec::new();
    inbox.argv(
        ["app", "foreign://open?code=DO-NOT-LOG", "--code=DO-NOT-LOG"],
        |line| logs.push(line),
    );
    assert!(inbox.take().is_none());
    assert_eq!(logs, ["DESKTOP_DEEP_LINK_IGNORED"; 2]);
}
#[test]
fn second_instance_forwards_the_link() {
    let mut inbox = plur1bus_desktop::deeplink::Inbox::default();
    // This is the exact handler called by the single-instance callback.
    inbox.argv(
        [
            "app",
            "plur1bus://pair?origin=https%3A%2F%2Fharness.test&code=ABCD-1234",
        ],
        |_| {},
    );
    let offer = inbox.take().unwrap();
    assert!(matches!(offer.intent, DeepLink::Pair { .. }));
    assert!(inbox
        .confirm_pair(offer.id, "https://harness.test", "ABCD-1234")
        .is_some());
    inbox.finish_pair(offer.id);
    assert!(inbox
        .confirm_pair(offer.id, "https://harness.test", "ABCD-1234")
        .is_none());
}
#[test]
fn link_pin_is_bound_to_exact_origin_and_code_and_never_repair() {
    let mut inbox = plur1bus_desktop::deeplink::Inbox::default();
    inbox.argv(
        [
            "app",
            "plur1bus://pair?origin=https%3A%2F%2Fharness.test&code=ABCD-1234",
        ],
        |_| {},
    );
    let offer = inbox.take().unwrap();
    assert!(inbox
        .confirm_pair(offer.id, "https://foreign.test", "ABCD-1234")
        .is_none());
    assert!(inbox
        .confirm_pair(offer.id, "https://harness.test", "EFGH-5678")
        .is_none());
}
#[test]
fn p1x_hook_never_reads_the_file_and_queue_is_bounded() {
    use plur1bus_desktop::deeplink::{parse_argument, Inbox};
    // A Windows path is absolute only with a drive or UNC prefix, and a file URL
    // only maps to a path with a drive letter, so each platform probes its own form.
    #[cfg(windows)]
    let (plain, url) = (
        r"C:\nonexistent\example.p1x",
        "file:///C:/nonexistent/example.p1x",
    );
    #[cfg(not(windows))]
    let (plain, url) = (
        "/nonexistent/example.p1x",
        "file:///nonexistent/example.p1x",
    );
    assert!(matches!(parse_argument(plain), DeepLink::P1x { .. }));
    assert!(matches!(parse_argument(url), DeepLink::P1x { .. }));
    assert!(parse_argument("file://foreign.test/nonexistent/example.p1x") == DeepLink::Ignored);
    let mut inbox = Inbox::default();
    for _ in 0..1000 {
        inbox.argv(["app", "plur1bus://open?path=%2Fchat"], |_| {});
    }
    let mut count = 0;
    while inbox.take().is_some() {
        count += 1;
    }
    assert!(count <= 16);
}

#[test]
fn install_hook_accepts_scoped_catalogue_ids_without_accepting_paths() {
    for link in [
        "plur1bus://install?id=plur1bus/zabbix-triage",
        "plur1bus://install?id=plur1bus%2Fzabbix-triage",
    ] {
        assert!(
            matches!(parse(link), DeepLink::Install { catalogue_id } if catalogue_id == "plur1bus/zabbix-triage")
        );
    }
    for id in [
        "/etc/passwd",
        "../package",
        "publisher/../file",
        "publisher//file",
        "file:///tmp/package",
        "https://evil.test/file",
        "publisher/name/other",
    ] {
        assert!(matches!(
            parse(&format!("plur1bus://install?id={id}")),
            DeepLink::Ignored
        ));
    }
}

#[test]
fn p1x_paths_stay_native_and_are_bound_to_the_offered_id() {
    use plur1bus_desktop::deeplink::Inbox;
    let path = std::env::temp_dir().join("private-extension.p1x");
    let mut inbox = Inbox::default();
    inbox.ingest(path.to_str().unwrap(), |_| {});
    let offer = inbox.take().unwrap();
    assert_eq!(
        serde_json::to_value(&offer).unwrap()["intent"],
        serde_json::json!({"kind":"p1x"})
    );
    assert_eq!(inbox.confirm_p1x(offer.id + 1), None);
    assert_eq!(inbox.confirm_p1x(offer.id), Some(path));
    inbox.finish_pair(offer.id);
    assert_eq!(inbox.confirm_p1x(offer.id), None);
}

#[tokio::test]
async fn confirmed_link_creates_new_connection_and_preserves_existing_connection() {
    use plur1bus_desktop::{
        client::HarnessClient,
        connections::{Connection, Kind, Origin, Store},
        pair,
        secrets::MemoryStore,
    };
    use plur1bus_mock_harness::{MockHarness, MockOptions};
    let mock = MockHarness::start(MockOptions::default()).await.unwrap();
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path());
    let existing = Connection::new(
        "Existing".into(),
        Kind::Remote,
        Origin::parse(&mock.origin).unwrap(),
        mock.installation_id.clone(),
        "existing-device".into(),
        "hint".into(),
    );
    store.upsert(existing.clone()).unwrap();
    let code = mock.control.create_pair_code();
    let client =
        HarnessClient::from_pairing_payload(Origin::parse(&mock.origin).unwrap(), None, None)
            .await
            .unwrap();
    let added = pair::pair_using_client(
        client,
        &code,
        "Added",
        Kind::Remote,
        None,
        None,
        &MemoryStore::default(),
        &store,
    )
    .await
    .unwrap();
    assert_ne!(added.id, existing.id);
    let rows = store.load().unwrap();
    assert_eq!(rows.len(), 2);
    let kept = rows.iter().find(|c| c.id == existing.id).unwrap();
    assert_eq!(kept.device_id, "existing-device");
    assert_eq!(kept.name, "Existing");
}
