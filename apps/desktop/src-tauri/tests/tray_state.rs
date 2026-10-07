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
