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
