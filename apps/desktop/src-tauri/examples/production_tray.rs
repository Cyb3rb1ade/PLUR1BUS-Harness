#[cfg(all(debug_assertions, target_os = "macos"))]
mod fixture {
    use plur1bus_desktop::{
        commands, native,
        secrets::MemoryStore,
        settings::{Locale, Settings, SettingsStore},
        spa::SpaState,
        tray::{HarnessState, RuntimeState, TrayState},
    };
    use std::{
        sync::{
            atomic::{AtomicU8, Ordering},
            Arc, Mutex,
        },
        time::{Duration, Instant},
    };
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

    #[derive(Default, serde::Serialize)]
    struct Report {
        english_headers: bool,
        german_headers: bool,
        runtime_and_secrets_words: bool,
        settings_ipc_refresh: bool,
        native_tooltip_matches: bool,
        colour_image_default: bool,
        decoder_fallback_is_native_template: bool,
        colour_image_restored: bool,
    }
    fn gui<T: Send + 'static>(
        app: &tauri::AppHandle,
        action: impl FnOnce(tauri::AppHandle) -> T + Send + 'static,
        budget: Duration,
    ) -> Result<T, &'static str> {
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        let handle = app.clone();
        app.run_on_main_thread(move || {
            let _ = sender.send(action(handle));
        })
        .map_err(|_| "TRAY_FIXTURE_DISPATCH_FAILED")?;
        receiver
            .recv_timeout(budget)
            .map_err(|_| "TRAY_FIXTURE_GUI_TIMEOUT")
    }
    fn observe(
        app: &tauri::AppHandle,
        check: impl Fn(&tauri::AppHandle) -> bool + Send + Sync + 'static,
    ) -> Result<(), &'static str> {
        let check = Arc::new(check);
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            let check = check.clone();
            if gui(
                app,
                move |app| check(&app),
                deadline.saturating_duration_since(Instant::now()),
            )? {
                return Ok(());
            }
            std::thread::sleep(
                Duration::from_millis(20).min(deadline.saturating_duration_since(Instant::now())),
            );
        }
        Err("TRAY_FIXTURE_OBSERVER_TIMEOUT")
    }
    // Pinned muda0.20 reads NSMenuItem.title rather than a cached model string.
    fn header(app: &tauri::AppHandle) -> Option<String> {
        app.state::<native::NativeState>()
            .header
            .lock()
            .unwrap()
            .as_ref()?
            .text()
            .ok()
    }
    #[allow(deprecated)]
    fn image_and_tooltip(app: &tauri::AppHandle) -> Option<(bool, String)> {
        app.tray_by_id("resident")?
            .with_inner_tray_icon(|icon| {
                let item = icon.ns_status_item()?;
                Some((item.image()?.isTemplate(), item.toolTip()?.to_string()))
            })
            .ok()?
    }
    fn exercise(
        app: &tauri::AppHandle,
        report: &Arc<Mutex<Report>>,
        settings_ack: &Arc<AtomicU8>,
    ) -> Result<(), &'static str> {
        observe(app, |app| header(app).is_some()).map_err(|_| "TRAY_FIXTURE_HEADER_MISSING")?;
        if !gui(
            app,
            |app| image_and_tooltip(&app).is_some_and(|(template, _)| !template),
            Duration::from_secs(5),
        )? {
            return Err("TRAY_FIXTURE_COLOUR_FAILED");
        }
        report.lock().unwrap().colour_image_default = true;
        let states = [
            HarnessState::Starting,
            HarnessState::Ready,
            HarnessState::Degraded,
            HarnessState::Down,
            HarnessState::Unpaired,
            HarnessState::Updating,
            HarnessState::Rollback,
            HarnessState::Crashed,
        ];
        for (locale, words) in [
            (
                Locale::En,
                [
                    "Starting",
                    "Running",
                    "Degraded",
                    "Stopped",
                    "Not paired",
                    "Updating",
                    "Rolling back",
                    "Crashed",
                ],
            ),
            (
                Locale::De,
                [
                    "Startet",
                    "Läuft",
                    "Eingeschränkt",
                    "Gestoppt",
                    "Nicht gekoppelt",
                    "Wird aktualisiert",
                    "Wird zurückgesetzt",
                    "Abgestürzt",
                ],
            ),
        ] {
            let german = locale == Locale::De;
            // Actual protected Shell settings_write IPC, not direct mutation of the language flag.
            settings_ack.store(0, Ordering::SeqCst);
            let ack = settings_ack.clone();
            let script = if german {
                r#"window.__TAURI_INTERNALS__.invoke('settings_set',{request:{settings:{theme:'system',locale:'de'}}}).then(()=>{document.title='WP6_TRAY_SETTINGS_DE';});"#
            } else {
                r#"window.__TAURI_INTERNALS__.invoke('settings_set',{request:{settings:{theme:'system',locale:'en'}}}).then(()=>{document.title='WP6_TRAY_SETTINGS_EN';});"#
            };
            observe(app, move |app| {
                let _ = app.get_webview_window("shell").unwrap().eval(script);
                ack.load(Ordering::SeqCst) == if german { 2 } else { 1 }
                    && native::language(app)
                        == if german {
                            plur1bus_desktop::tray::Language::De
                        } else {
                            plur1bus_desktop::tray::Language::En
                        }
            })
            .map_err(|_| "TRAY_FIXTURE_SETTINGS_IPC_FAILED")?;
            for (state, word) in states.into_iter().zip(words) {
                gui(
                    app,
                    move |app| {
                        *app.state::<native::NativeState>().view.lock().unwrap() = TrayState {
                            harness: state,
                            runtime: Some(RuntimeState::Missing),
                            secrets_locked: true,
                            ..Default::default()
                        };
                        native::refresh_language(&app, locale);
                    },
                    Duration::from_secs(5),
                )?;
                let expected = format!(
                    "PLUR1BUS — {} — {} — {} — {}",
                    if german {
                        "Keine Verbindung"
                    } else {
                        "No connection"
                    },
                    word,
                    if german {
                        "Runtime fehlt"
                    } else {
                        "Runtime missing"
                    },
                    if german {
                        "Geheimnisspeicher gesperrt"
                    } else {
                        "Secrets store locked"
                    }
                );
                observe(app, move |app| {
                    header(app).as_ref() == Some(&expected)
                        && image_and_tooltip(app).is_some_and(|(_, text)| text == expected)
                })
                .map_err(|_| "TRAY_FIXTURE_NATIVE_TEXT_FAILED")?;
            }
            if german {
                report.lock().unwrap().german_headers = true;
            } else {
                report.lock().unwrap().english_headers = true;
            }
        }
        report.lock().unwrap().runtime_and_secrets_words = true;
        report.lock().unwrap().settings_ipc_refresh = true;
        report.lock().unwrap().native_tooltip_matches = true;
        gui(
            app,
            |app| {
                let (image, template) = native::decode_tray_image(
                    b"invalid-png",
                    Some(include_bytes!("../icons/tray/attention-light-template.png")),
                )
                .map_err(|_| "TRAY_FIXTURE_DECODER_FAILED")?;
                if !template {
                    return Err("TRAY_FIXTURE_DECODER_FAILED");
                }
                app.tray_by_id("resident")
                    .unwrap()
                    .set_icon_with_as_template(Some(image), template)
                    .map_err(|_| "TRAY_FIXTURE_TEMPLATE_SET_FAILED")
            },
            Duration::from_secs(5),
        )??;
        observe(app, |app| {
            image_and_tooltip(app).is_some_and(|(template, _)| template)
        })
        .map_err(|_| "TRAY_FIXTURE_TEMPLATE_FLAG_FAILED")?;
        report.lock().unwrap().decoder_fallback_is_native_template = true;
        gui(
            app,
            |app| native::refresh_language(&app, Locale::De),
            Duration::from_secs(5),
        )?;
        observe(app, |app| {
            image_and_tooltip(app).is_some_and(|(template, _)| !template)
        })
        .map_err(|_| "TRAY_FIXTURE_COLOUR_RESTORE_FAILED")?;
        report.lock().unwrap().colour_image_restored = true;
        Ok(())
    }
    pub fn run() {
        let root = std::env::args_os()
            .nth(1)
            .map(std::path::PathBuf::from)
            .expect("TRAY_FIXTURE_ROOT_REQUIRED")
            .canonicalize()
            .expect("TRAY_FIXTURE_ROOT_INVALID");
        std::env::set_var("PLUR1BUS_DESKTOP_CONFIG_DIR", &root);
        SettingsStore::new(root.clone())
            .set(&Settings {
                locale: Locale::En,
                ..Default::default()
            })
            .unwrap();
        let mut context = tauri::generate_context!();
        context.config_mut().app.windows.clear();
        context.config_mut().identifier = plur1bus_desktop::lifecycle::fixture_identifier(
            plur1bus_desktop::ids::BUNDLE_ID,
            &root.to_string_lossy(),
        );
        let settings_ack = Arc::new(AtomicU8::new(0));
        let app = tauri::Builder::default()
            .manage(native::NativeState::default())
            .manage(SpaState::default())
            .manage(commands::ConnectionState(Arc::new(
                tokio::sync::Mutex::new(Some(Box::new(MemoryStore::default()))),
            )))
            .invoke_handler(tauri::generate_handler![
                commands::app_info,
                commands::settings_get,
                commands::settings_set,
                commands::connections_list,
                commands::background_hint,
                commands::crash_offers
            ])
            .setup(move |app| {
                native::build_tray(app.handle())?;
                let title_ack = settings_ack.clone();
                WebviewWindowBuilder::new(app, "shell", WebviewUrl::App("index.html".into()))
                    .visible(false)
                    .incognito(true)
                    .data_directory(root.join("shell-profile"))
                    .on_document_title_changed(move |_, title| match title.as_str() {
                        "WP6_TRAY_SETTINGS_EN" => title_ack.store(1, Ordering::SeqCst),
                        "WP6_TRAY_SETTINGS_DE" => title_ack.store(2, Ordering::SeqCst),
                        _ => {}
                    })
                    .build()?;
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    let report = Arc::new(Mutex::new(Report::default()));
                    let result = exercise(&handle, &report, &settings_ack);
                    if let Err(reason) = result {
                        eprintln!("{reason}");
                    }
                    println!(
                        "{}",
                        serde_json::to_string(&*report.lock().unwrap()).unwrap()
                    );
                    use std::io::Write;
                    let _ = std::io::stdout().flush();
                    handle.exit(if result.is_ok() { 0 } else { 2 });
                });
                Ok(())
            })
            .build(context)
            .expect("TRAY_FIXTURE_BUILD_FAILED");
        // No resident close/quit handler: this fixture tests only its owned status item.
        app.run(|_, _| {});
    }
}
#[cfg(all(debug_assertions, target_os = "macos"))]
fn main() {
    fixture::run();
}
#[cfg(not(all(debug_assertions, target_os = "macos")))]
fn main() {
    eprintln!("NATIVE_TRAY_FIXTURE_UNAVAILABLE");
    std::process::exit(2);
}
