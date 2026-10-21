use plur1bus_desktop::tray::*;
use serde_json::json;

#[test]
fn map_status_table() {
    for (state, expected) in [
        ("starting", HarnessState::Starting),
        ("ready", HarnessState::Ready),
        ("degraded", HarnessState::Degraded),
        ("down", HarnessState::Down),
        ("unpaired", HarnessState::Unpaired),
        ("updating", HarnessState::Updating),
        ("rollback", HarnessState::Rollback),
        ("crashed", HarnessState::Crashed),
        ("unknown", HarnessState::Degraded),
    ] {
        assert_eq!(map_status(&json!({"state":state})), expected);
    }
    assert_eq!(map_status(&json!({})), HarnessState::Degraded);
}

#[test]
fn combine_table() {
    let ctl = HarnessStatus::default();
    let upd = UpdateModelState::default();
    assert_eq!(
        combine(&ctl, HarnessState::Ready, &upd).harness,
        HarnessState::Ready
    );
    let crashed = HarnessStatus {
        crashed: true,
        ..Default::default()
    };
    assert_eq!(
        combine(&crashed, HarnessState::Ready, &upd).harness,
        HarnessState::Crashed
    );
    for runtime in [RuntimeState::Missing, RuntimeState::Stopped] {
        let ctl = HarnessStatus {
            runtime: Some(runtime),
            ..Default::default()
        };
        let got = combine(&ctl, HarnessState::Ready, &upd);
        assert_eq!(got.harness, HarnessState::Down);
        assert_eq!(got.runtime, Some(runtime));
    }
    for (updating, rollback, expected) in [
        (true, false, HarnessState::Updating),
        (false, true, HarnessState::Rollback),
    ] {
        let upd = UpdateModelState {
            updating,
            rollback,
            available: true,
            held: true,
        };
        let got = combine(&crashed, HarnessState::Ready, &upd);
        assert_eq!(got.harness, expected);
        assert!(got.update_available && got.held);
    }
    assert!(
        combine(
            &HarnessStatus {
                secrets_locked: true,
                ..Default::default()
            },
            HarnessState::Ready,
            &upd
        )
        .secrets_locked
    );
}

#[test]
fn every_state_keeps_words_and_maps_to_the_four_badge_shapes() {
    for state in [
        HarnessState::Starting,
        HarnessState::Ready,
        HarnessState::Degraded,
        HarnessState::Down,
        HarnessState::Unpaired,
        HarnessState::Updating,
        HarnessState::Rollback,
        HarnessState::Crashed,
    ] {
        let value = combine(
            &HarnessStatus::default(),
            state,
            &UpdateModelState {
                available: true,
                ..Default::default()
            },
        );
        assert!(!state.words().is_empty());
        assert_eq!(
            value.badge(),
            match state {
                HarnessState::Starting | HarnessState::Updating => Badge::Busy,
                HarnessState::Ready => Badge::Update,
                _ => Badge::Attention,
            }
        );
    }
    assert_eq!(
        combine(
            &HarnessStatus::default(),
            HarnessState::Ready,
            &UpdateModelState::default()
        )
        .badge(),
        Badge::Running
    );
}

#[test]
fn native_tray_words_follow_saved_language_and_system_locale() {
    use plur1bus_desktop::settings::Locale;
    for (preference, system, expected) in [
        (Locale::System, "de-DE", Language::De),
        (Locale::System, "DE_de", Language::De),
        (Locale::System, "fr-FR", Language::En),
        (Locale::En, "de-DE", Language::En),
        (Locale::De, "en-US", Language::De),
    ] {
        assert_eq!(Language::resolve(preference, system), expected);
    }
    let state = TrayState {
        harness: HarnessState::Ready,
        runtime: Some(RuntimeState::Stopped),
        secrets_locked: true,
        ..Default::default()
    };
    assert_eq!(
        Language::De.status(&state, "Fixture"),
        "PLUR1BUS — Fixture — Läuft — Runtime gestoppt — Geheimnisspeicher gesperrt"
    );
    for id in [
        "open",
        "start-harness",
        "stop-harness",
        "start-runtime",
        "update",
        "connections",
        "settings",
        "quit",
        "no-connection",
    ] {
        assert_ne!(Language::De.text(id), Language::En.text(id));
    }
    for state in [
        HarnessState::Starting,
        HarnessState::Ready,
        HarnessState::Degraded,
        HarnessState::Down,
        HarnessState::Unpaired,
        HarnessState::Updating,
        HarnessState::Rollback,
        HarnessState::Crashed,
    ] {
        assert_ne!(Language::De.harness(state), Language::En.harness(state));
    }
}

#[test]
fn actual_native_image_decoder_uses_template_only_after_colour_failure() {
    use plur1bus_desktop::native::decode_tray_image;
    let colour = include_bytes!("../icons/tray/running-light.png");
    let template = include_bytes!("../icons/tray/running-light-template.png");
    assert!(!decode_tray_image(colour, Some(template)).unwrap().1);
    assert!(
        decode_tray_image(b"injected invalid image", Some(template))
            .unwrap()
            .1
    );
    assert!(decode_tray_image(b"injected invalid image", None).is_err());
    assert!(decode_tray_image(b"invalid", Some(b"invalid fallback")).is_err());
}

/// Transport choice spec §7.3: the header names the active remote connection's path, a Tailscale notice is appended
/// and turns the badge to *Attention*, and bundled/local connections show no path.
#[test]
fn header_names_the_path_and_a_tailscale_notice_needs_attention() {
    use plur1bus_desktop::transport::{Category, Hint, Severity, Transport, TransportReport};
    let ready = TrayState {
        harness: HarnessState::Ready,
        ..Default::default()
    };
    for (path, de, en) in [
        (
            PathLabel::Tailscale,
            "PLUR1BUS — NAS · Tailscale — Läuft",
            "PLUR1BUS — NAS · Tailscale — Running",
        ),
        (
            PathLabel::Direct,
            "PLUR1BUS — NAS · direkt — Läuft",
            "PLUR1BUS — NAS · direct — Running",
        ),
        (
            PathLabel::DirectPublic,
            "PLUR1BUS — NAS · direkt, öffentlich — Läuft",
            "PLUR1BUS — NAS · direct, public — Running",
        ),
    ] {
        let view = TrayState {
            path: Some(path),
            ..ready.clone()
        };
        assert_eq!(Language::De.status(&view, "NAS"), de);
        assert_eq!(Language::En.status(&view, "NAS"), en);
        assert_eq!(view.badge(), Badge::Running);
    }
    // Bundled and local: no path.
    assert_eq!(
        Language::De.status(&ready, "Dieser Mac"),
        "PLUR1BUS — Dieser Mac — Läuft"
    );
    for id in ["path-direct", "path-public", "tailscale-attention"] {
        assert_ne!(Language::De.text(id), Language::En.text(id));
    }
    assert_eq!(Language::De.text("path-tailscale"), "Tailscale");

    let report = |category, hints: Vec<Hint>| TransportReport {
        category: Some(category),
        addresses: vec![],
        hints,
        tailscale: None,
        needs_public_ack: category == Category::Public,
        classifier: "iana-special-2025-10-09",
    };
    let notice = |code| Hint::new(code, Severity::Notice, Default::default());
    let mut view = ready.clone();
    view.set_transport(Some((
        Transport::Tailscale,
        &report(Category::Tailnet, vec![notice("tailscale-stopped")]),
    )));
    assert_eq!(view.path, Some(PathLabel::Tailscale));
    assert!(view.tailscale_notice && view.transport_attention);
    assert_eq!(view.badge(), Badge::Attention);
    assert_eq!(
        Language::De.status(&view, "NAS"),
        "PLUR1BUS — NAS · Tailscale — Läuft — Tailscale getrennt"
    );
    assert_eq!(
        Language::En.status(&view, "NAS"),
        "PLUR1BUS — NAS · Tailscale — Running — Tailscale disconnected"
    );
    // An info (ok, self) is no notice.
    view.set_transport(Some((
        Transport::Tailscale,
        &report(
            Category::Tailnet,
            vec![Hint::new(
                "tailscale-ok",
                Severity::Info,
                Default::default(),
            )],
        ),
    )));
    assert!(!view.tailscale_notice && !view.transport_attention);
    assert_eq!(view.badge(), Badge::Running);
    // Every disconnect state reads „Tailscale getrennt“.
    for code in plur1bus_desktop::tray::TAILSCALE_DISCONNECTED {
        let mut each = ready.clone();
        each.set_transport(Some((
            Transport::Tailscale,
            &report(Category::Tailnet, vec![notice(code)]),
        )));
        assert!(each.tailscale_notice && each.transport_attention, "{code}");
        assert!(
            Language::En
                .status(&each, "NAS")
                .ends_with(" — Tailscale disconnected"),
            "{code}"
        );
    }
    // Notices that are no disconnect (an unprobed subnet route, an unknown peer, an unreachable path) do not say
    // „getrennt“ and need no attention.
    for code in [
        "tailscale-subnet-route",
        "tailscale-peer-unknown",
        "tailscale-unreachable",
        "tailscale-not-installed",
    ] {
        view.set_transport(Some((
            Transport::Tailscale,
            &report(Category::Tailnet, vec![notice(code)]),
        )));
        assert!(
            !view.tailscale_notice && !view.transport_attention,
            "{code}"
        );
        assert_eq!(view.badge(), Badge::Running, "{code}");
        assert_eq!(
            Language::De.status(&view, "NAS"),
            "PLUR1BUS — NAS · Tailscale — Läuft",
            "{code}"
        );
    }
    // A confirmed public direct target.
    view.set_transport(Some((
        Transport::Direct,
        &report(
            Category::Public,
            vec![Hint::new(
                "target-public",
                Severity::Warning,
                Default::default(),
            )],
        ),
    )));
    assert_eq!(view.path, Some(PathLabel::DirectPublic));
    assert_eq!(view.badge(), Badge::Running);
    // A reconnect stopped for a confirmation: attention, the path is public, no Tailscale text.
    let mut stopped = ready.clone();
    stopped.set_transport(Some((
        Transport::Direct,
        &report(Category::Private, vec![]),
    )));
    stopped.set_confirm_needed(Transport::Direct);
    assert_eq!(stopped.badge(), Badge::Attention);
    assert_eq!(
        Language::De.status(&stopped, "NAS"),
        "PLUR1BUS — NAS · direkt, öffentlich — Läuft"
    );
    stopped.set_transport(None);
    assert_eq!(stopped.path, None);
    assert_eq!(stopped.badge(), Badge::Running);
}

fn rows(count: usize) -> Vec<SwitchRow> {
    (0..count)
        .map(|i| SwitchRow {
            id: uuid::Uuid::from_u128(i as u128 + 1),
            name: format!("Rechner {i}"),
            path: None,
        })
        .collect()
}

/// Package T4b (desktop spec §6.3): the *Connections* submenu for 0, 1, 20 and 21 connections, then *Manage
/// connections…*; at most 20 entries, then *More…*.
#[test]
fn switch_submenu_lists_at_most_twenty_connections_then_more() {
    for language in [Language::De, Language::En] {
        let empty = language.switch_menu(&[], None, None);
        assert!(empty.entries.is_empty());
        assert_eq!(empty.empty, Some(language.text("no-connection")));
        assert_eq!(empty.more, None);
        assert!(empty.offered().is_empty());

        let one = language.switch_menu(&rows(1), None, None);
        assert_eq!(one.entries.len(), 1);
        assert_eq!(one.empty, None);
        assert_eq!(one.more, None);
        assert_eq!(one.entries[0].text, "Rechner 0");
        assert!(!one.entries[0].checked);

        let twenty = language.switch_menu(&rows(20), None, None);
        assert_eq!(twenty.entries.len(), SWITCH_LIMIT);
        assert_eq!(twenty.more, None);

        let all = rows(21);
        let more = language.switch_menu(&all, None, None);
        assert_eq!(more.entries.len(), SWITCH_LIMIT);
        assert_eq!(more.more, Some(language.text("more")));
        // In the list's order; the 21st is reached through *More…* only.
        assert_eq!(
            more.offered(),
            all.iter().take(20).map(|r| r.id).collect::<Vec<_>>()
        );
        assert!(!more.offered().contains(&all[20].id));
        for entry in &more.entries {
            assert_eq!(entry.menu_id, format!("connection:{}", entry.id));
        }
        assert_eq!(more.manage, language.text("manage"));
        assert_eq!(more.title, language.text("switch"));
    }
    assert_eq!(Language::De.text("switch"), "Verbindung wechseln");
    assert_eq!(Language::En.text("switch"), "Switch connection");
    assert_eq!(Language::De.text("manage"), "Verbindungen verwalten…");
    assert_eq!(Language::En.text("manage"), "Manage connections…");
    assert_eq!(Language::De.text("more"), "Weitere Verbindungen…");
    assert_eq!(Language::En.text("more"), "More connections…");
}

/// The open connection is always listed and offered: past the 20th row it takes the 20th place (the list order is kept
/// otherwise, *More…* still follows); within the first 20 nothing moves.
#[test]
fn the_open_connection_is_always_listed_and_offered() {
    let all = rows(25);
    for language in [Language::De, Language::En] {
        for past in [20, 21, 24] {
            let open = all[past].id;
            let menu = language.switch_menu(&all, Some(open), None);
            assert_eq!(menu.entries.len(), SWITCH_LIMIT);
            let mut expected: Vec<uuid::Uuid> = all.iter().take(19).map(|r| r.id).collect();
            expected.push(open);
            assert_eq!(menu.offered(), expected);
            assert_eq!(menu.entries[19].text, format!("Rechner {past}"));
            assert!(menu.entries[19].checked);
            assert_eq!(menu.entries.iter().filter(|e| e.checked).count(), 1);
            assert_eq!(menu.more, Some(language.text("more")));
            assert_eq!(
                TrayAction::parse(&format!("connection:{open}"), &menu.offered()),
                Some(TrayAction::Switch(open))
            );
            // The 20th row it displaced is reached through *More…*.
            assert_eq!(
                TrayAction::parse(&format!("connection:{}", all[19].id), &menu.offered()),
                None
            );
        }
        for within in [0, 10, 19] {
            let menu = language.switch_menu(&all, Some(all[within].id), None);
            assert_eq!(
                menu.offered(),
                all.iter().take(20).map(|r| r.id).collect::<Vec<_>>()
            );
            let checked: Vec<usize> = menu
                .entries
                .iter()
                .enumerate()
                .filter(|(_, e)| e.checked)
                .map(|(i, _)| i)
                .collect();
            assert_eq!(checked, [within]);
        }
        // Exactly 20 rows: nothing to replace, no *More…*.
        let twenty = rows(20);
        let menu = language.switch_menu(&twenty, Some(twenty[19].id), None);
        assert_eq!(
            menu.offered(),
            twenty.iter().map(|r| r.id).collect::<Vec<_>>()
        );
        assert_eq!(menu.more, None);
    }
}

/// Transport choice spec §7.3: each entry reads `{name} ({path})`, bundled and local rows only the name; the active
/// connection is checked and shows the path of its last check.
#[test]
fn switch_entries_carry_the_path_and_check_the_active_connection() {
    let mut all = rows(4);
    all[0].name = "Dieser Mac".into();
    all[1].name = "NAS".into();
    all[1].path = Some(PathLabel::Tailscale);
    all[2].name = "Büro".into();
    all[2].path = Some(PathLabel::Direct);
    all[3].name = "VPS & Co".into();
    all[3].path = Some(PathLabel::DirectPublic);
    let de = Language::De.switch_menu(&all, Some(all[2].id), None);
    let text: Vec<&str> = de.entries.iter().map(|e| e.text.as_str()).collect();
    assert_eq!(
        text,
        [
            "Dieser Mac",
            "NAS (Tailscale)",
            "Büro (direkt)",
            // A literal `&` survives the native menus' mnemonic markers.
            "VPS && Co (direkt, öffentlich)"
        ]
    );
    let checked: Vec<bool> = de.entries.iter().map(|e| e.checked).collect();
    assert_eq!(checked, [false, false, true, false]);
    let en = Language::En.switch_menu(&all, Some(all[0].id), None);
    let text: Vec<&str> = en.entries.iter().map(|e| e.text.as_str()).collect();
    assert_eq!(
        text,
        [
            "Dieser Mac",
            "NAS (Tailscale)",
            "Büro (direct)",
            "VPS && Co (direct, public)"
        ]
    );
    assert!(en.entries[0].checked);
    // The active remote connection's fresh check (the header's path) wins over the stored one.
    let fresh = Language::De.switch_menu(&all, Some(all[2].id), Some(PathLabel::DirectPublic));
    assert_eq!(fresh.entries[2].text, "Büro (direkt, öffentlich)");
    assert_eq!(fresh.entries[1].text, "NAS (Tailscale)");
    // No active connection: nothing checked.
    assert!(Language::De
        .switch_menu(&all, None, None)
        .entries
        .iter()
        .all(|e| !e.checked));
}

/// *Start/Stop harness* (desktop spec §6.3): enabled only for the active bundled connection whose runtime is
/// reachable; otherwise disabled with the reason after the label (native menus have no tooltips).
#[test]
fn harness_controls_follow_the_active_bundled_connection_and_the_runtime() {
    use plur1bus_desktop::connections::Kind;
    use plur1bus_desktop::controller::HarnessStatus as Ctl;
    let ready = Ctl::Ready { port: 18700 };
    let stopped = Ctl::Stopped;
    let disabled = |reason| HarnessControls {
        start: Control::Disabled(reason),
        stop: Control::Disabled(reason),
    };
    // Remote, local or no connection: refused whatever the runtime says.
    for kind in [None, Some(Kind::Remote), Some(Kind::Local)] {
        for status in [None, Some(&ready), Some(&stopped)] {
            let controls = HarnessControls::of(kind.as_ref(), status, false);
            assert_eq!(controls, disabled(ControlReason::NotBundled));
            assert_eq!(
                controls.request(HarnessOp::Start),
                Err(ControlReason::NotBundled)
            );
            assert_eq!(
                controls.request(HarnessOp::Stop),
                Err(ControlReason::NotBundled)
            );
        }
    }
    let bundled = Some(Kind::Bundled);
    let of = |status: Option<&Ctl>, busy| HarnessControls::of(bundled.as_ref(), status, busy);
    // Runtime down, not installed, or no status yet.
    for status in [None, Some(&Ctl::RuntimeDown)] {
        assert_eq!(of(status, false), disabled(ControlReason::RuntimeDown));
    }
    assert_eq!(
        of(Some(&Ctl::NotInstalled), false),
        disabled(ControlReason::NotInstalled)
    );
    // An operation is running.
    assert_eq!(of(Some(&ready), true), disabled(ControlReason::Busy));
    assert_eq!(of(Some(&stopped), true), disabled(ControlReason::Busy));
    // Reachable.
    let running = of(Some(&ready), false);
    assert_eq!(running.start, Control::Disabled(ControlReason::Running));
    assert_eq!(running.stop, Control::Enabled);
    assert_eq!(running.request(HarnessOp::Stop), Ok(HarnessOp::Stop));
    assert_eq!(
        running.request(HarnessOp::Start),
        Err(ControlReason::Running)
    );
    for down in [
        Ctl::Stopped,
        Ctl::Crashed {
            exit_code: Some(1),
            log_tail: String::new(),
        },
    ] {
        let controls = of(Some(&down), false);
        assert_eq!(controls.start, Control::Enabled);
        assert_eq!(controls.stop, Control::Disabled(ControlReason::Stopped));
        assert_eq!(controls.request(HarnessOp::Start), Ok(HarnessOp::Start));
    }
    let starting = of(Some(&Ctl::Starting), false);
    assert_eq!(starting.start, Control::Disabled(ControlReason::Busy));
    assert_eq!(starting.stop, Control::Enabled);

    // Texts: the label, then the reason (du).
    assert_eq!(
        Language::De.control(HarnessOp::Start, Control::Enabled),
        "Harness starten"
    );
    assert_eq!(
        Language::En.control(HarnessOp::Stop, Control::Enabled),
        "Stop harness"
    );
    for (reason, de, en) in [
        (
            ControlReason::NotBundled,
            "Harness starten — wechsle zur gebündelten Verbindung",
            "Start harness — switch to the bundled connection",
        ),
        (
            ControlReason::RuntimeDown,
            "Harness starten — Runtime nicht erreichbar",
            "Start harness — runtime not reachable",
        ),
        (
            ControlReason::NotInstalled,
            "Harness starten — nicht installiert",
            "Start harness — not installed",
        ),
        (
            ControlReason::Busy,
            "Harness starten — Vorgang läuft",
            "Start harness — operation in progress",
        ),
        (
            ControlReason::Running,
            "Harness starten — läuft bereits",
            "Start harness — already running",
        ),
        (
            ControlReason::Stopped,
            "Harness starten — läuft nicht",
            "Start harness — not running",
        ),
    ] {
        assert_eq!(
            Language::De.control(HarnessOp::Start, Control::Disabled(reason)),
            de
        );
        assert_eq!(
            Language::En.control(HarnessOp::Start, Control::Disabled(reason)),
            en
        );
    }
}

/// Menu events: ids are the app's own; a connection id is honoured only when the menu last built offered it, in the
/// app's hyphenated form. Nothing else maps to an action.
#[test]
fn menu_event_ids_map_only_to_offered_connections_and_known_items() {
    // Hex letters in it, so another case is another spelling.
    let id = uuid::Uuid::from_u128(0x0192_abcd_ef01_7000_8000_00ab_cdef_0001);
    let offered = vec![rows(1)[0].id, id];
    assert_eq!(
        TrayAction::parse(&format!("connection:{id}"), &offered),
        Some(TrayAction::Switch(id))
    );
    // Unknown or removed (not offered by the current menu), other spellings, malformed.
    let stranger = uuid::Uuid::from_u128(99);
    for raw in [
        format!("connection:{stranger}"),
        format!("connection:{}", id.to_string().to_uppercase()),
        format!("connection:{{{id}}}"),
        format!("connection:{}", id.simple()),
        format!("connection:urn:uuid:{id}"),
        format!("connection: {id}"),
        format!("{id}"),
        "connection:".into(),
        "connection:../etc".into(),
        "start-harness".into(),
        "stop-harness".into(),
        "status".into(),
        "switch".into(),
        "switch-empty".into(),
        "start-runtime".into(),
        String::new(),
    ] {
        assert_eq!(TrayAction::parse(&raw, &offered), None, "{raw}");
    }
    assert_eq!(TrayAction::parse(&format!("connection:{id}"), &[]), None);
    for (raw, action) in [
        ("open", TrayAction::Open),
        ("connections", TrayAction::Connections),
        ("more", TrayAction::Connections),
        ("harness-start", TrayAction::HarnessStart),
        ("harness-stop", TrayAction::HarnessStop),
        ("update", TrayAction::Update),
        ("settings", TrayAction::Settings),
        ("quit", TrayAction::Quit),
    ] {
        assert_eq!(TrayAction::parse(raw, &offered), Some(action));
    }
}

/// The menu is rebuilt once per burst of changes: only the latest request rebuilds.
#[test]
fn rebuild_requests_are_debounced_to_the_latest() {
    let debounce = Debounce::default();
    let first = debounce.schedule();
    let second = debounce.schedule();
    let third = debounce.schedule();
    assert!(!debounce.is_latest(first));
    assert!(!debounce.is_latest(second));
    assert!(debounce.is_latest(third));
    assert!(REBUILD_DEBOUNCE >= std::time::Duration::from_millis(50));
    assert!(REBUILD_DEBOUNCE <= std::time::Duration::from_millis(500));
}
