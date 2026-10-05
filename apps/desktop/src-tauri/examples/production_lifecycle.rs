#[cfg(debug_assertions)]
mod fixture {
    // Native Wry lifecycle proof; private temporary profiles, no real credentials/services.
    use plur1bus_desktop::{
        commands, native,
        secrets::MemoryStore,
        settings::{Locale, Settings, SettingsStore},
        spa::SpaState,
    };
    use std::{
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc, Mutex,
        },
        time::{Duration, Instant},
    };
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

    #[derive(Default, serde::Serialize)]
    struct Report {
        spa_focus: bool,
        second_instance_focus: bool,
        close_hides: bool,
        close_minimizes: bool,
        shell_focus: bool,
        quit_modal_default: bool,
        quit_cancel_preserves_app: bool,
        quit_confirm_exits: bool,
    }
    fn gui_budget<T: Send + 'static>(
        app: &tauri::AppHandle,
        action: impl FnOnce(tauri::AppHandle) -> T + Send + 'static,
        budget: Duration,
    ) -> Result<T, &'static str> {
        let (send, receive) = std::sync::mpsc::sync_channel(1);
        let handle = app.clone();
        app.run_on_main_thread(move || {
            let _ = send.send(action(handle));
        })
        .map_err(|_| "FIXTURE_GUI_DISPATCH_FAILED")?;
        receive
            .recv_timeout(budget)
            .map_err(|_| "FIXTURE_GUI_TIMEOUT")
    }
    fn gui<T: Send + 'static>(
        app: &tauri::AppHandle,
        action: impl FnOnce(tauri::AppHandle) -> T + Send + 'static,
    ) -> Result<T, &'static str> {
        gui_budget(app, action, Duration::from_secs(5))
    }
    fn observe(
        app: &tauri::AppHandle,
        check: impl Fn(&tauri::AppHandle) -> bool + Send + Sync + 'static,
    ) -> Result<(), &'static str> {
        let check = Arc::new(check);
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            let check = check.clone();
            if gui_budget(
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
        Err("FIXTURE_OBSERVER_TIMEOUT")
    }
    fn exercise(
        app: &tauri::AppHandle,
        report: &Arc<Mutex<Report>>,
        modal: &Arc<AtomicBool>,
        root: &std::path::Path,
        second: &Arc<AtomicBool>,
    ) -> Result<(), &'static str> {
        gui(app, |app| {
            #[cfg(target_os = "macos")]
            {
                let _ = app.show();
            }
            app.get_webview_window("shell").unwrap().show().unwrap();
        })?;
        observe(app, |app| {
            app.get_webview_window("shell")
                .is_some_and(|w| w.is_visible().unwrap_or(false))
        })
        .map_err(|_| "FIXTURE_SHELL_NOT_VISIBLE")?;
        eprintln!("FIXTURE_SHELL_VISIBLE");
        gui(app, |app| {
            native::focus(&app);
        })?;
        observe(app, |app| {
            app.get_webview_window("spa")
                .is_some_and(|w| w.is_focused().unwrap_or(false))
        })
        .map_err(|_| "FIXTURE_SPA_NOT_FOCUSED")?;
        report.lock().unwrap().spa_focus = true;
        eprintln!("FIXTURE_SPA_FOCUS_OBSERVED");
        gui(app, |app| {
            app.get_webview_window("spa").unwrap().hide().unwrap();
            app.get_webview_window("shell")
                .unwrap()
                .set_focus()
                .unwrap();
        })?;
        let mut child = std::process::Command::new(
            std::env::current_exe().map_err(|_| "FIXTURE_EXECUTABLE_FAILED")?,
        )
        .arg(root)
        .arg("--secondary")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|_| "FIXTURE_SECOND_INSTANCE_FAILED")?;
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match child
                .try_wait()
                .map_err(|_| "FIXTURE_SECOND_INSTANCE_WAIT_FAILED")?
            {
                Some(status) if status.success() => break,
                Some(_) => return Err("FIXTURE_SECOND_INSTANCE_REJECTED"),
                None if Instant::now() >= deadline => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("FIXTURE_SECOND_INSTANCE_TIMEOUT");
                }
                None => std::thread::sleep(
                    Duration::from_millis(20)
                        .min(deadline.saturating_duration_since(Instant::now())),
                ),
            }
        }
        let seen = second.clone();
        observe(app, move |app| {
            seen.load(Ordering::SeqCst)
                && app.get_webview_window("spa").is_some_and(|w| {
                    w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false)
                })
        })?;
        report.lock().unwrap().second_instance_focus = true;
        eprintln!("FIXTURE_SECOND_INSTANCE_FOCUS_OBSERVED");

        gui(app, |app| {
            app.state::<native::NativeState>()
                .background
                .store(true, Ordering::SeqCst);
            app.get_webview_window("spa").unwrap().close().unwrap();
        })?;
        observe(app, |app| {
            app.get_webview_window("spa")
                .is_some_and(|w| !w.is_visible().unwrap_or(true))
        })?;
        report.lock().unwrap().close_hides = true;
        eprintln!("FIXTURE_CLOSE_HIDES_OBSERVED");
        gui(app, |app| {
            app.state::<native::NativeState>()
                .background
                .store(false, Ordering::SeqCst);
            native::focus(&app);
            app.get_webview_window("spa").unwrap().close().unwrap();
        })?;
        observe(app, |app| {
            app.get_webview_window("spa")
                .is_some_and(|w| w.is_minimized().unwrap_or(false))
        })?;
        report.lock().unwrap().close_minimizes = true;
        eprintln!("FIXTURE_CLOSE_MINIMIZES_OBSERVED");
        gui(app, |app| {
            app.get_webview_window("spa").unwrap().destroy().unwrap();
        })?;
        observe(app, |app| app.get_webview_window("spa").is_none())?;
        gui(app, |app| native::focus(&app))?;
        observe(app, |app| {
            app.get_webview_window("shell")
                .is_some_and(|w| w.is_focused().unwrap_or(false))
        })?;
        report.lock().unwrap().shell_focus = true;
        eprintln!("FIXTURE_SHELL_FOCUS_OBSERVED");
        // Exercise the actual ExitRequested event, shared guard and renderer modal.
        app.exit(0);
        let seen = modal.clone();
        observe(app, move |app| {
            let _ = app.get_webview_window("shell").unwrap().eval("if(document.querySelector('dialog[data-quit] input[value=\"keep-running\"]:checked')) document.title='WP6_QUIT_DEFAULT';");
            seen.load(Ordering::SeqCst)
        })?;
        if app.state::<native::NativeState>().quit.is_approved() {
            return Err("FIXTURE_EARLY_APPROVAL");
        }
        report.lock().unwrap().quit_modal_default = true;
        eprintln!("FIXTURE_QUIT_MODAL_DEFAULT_OBSERVED");
        gui(app, |app| {
            app.get_webview_window("shell")
                .unwrap()
                .eval("document.querySelector('dialog[data-quit]').close();")
                .unwrap();
        })?;
        observe(app, |app| {
            !app.state::<native::NativeState>().quit.is_pending()
        })?;
        if app.state::<native::NativeState>().quit.is_approved() {
            return Err("FIXTURE_CANCEL_APPROVED");
        }
        report.lock().unwrap().quit_cancel_preserves_app = true;
        eprintln!("FIXTURE_QUIT_CANCEL_PRESERVES_APP_OBSERVED");
        modal.store(false, Ordering::SeqCst);
        gui(app, |app| {
            native::request_quit(&app);
        })?;
        let seen = modal.clone();
        observe(app, move |app| {
            let _ = app.get_webview_window("shell").unwrap().eval("if(document.querySelector('dialog[data-quit] input[value=\"keep-running\"]:checked')) document.title='WP6_QUIT_DEFAULT_2';");
            seen.load(Ordering::SeqCst)
        })?;
        gui(app, |app| {
            app.get_webview_window("shell")
                .unwrap()
                .eval("document.querySelector('dialog[data-quit] .button-primary').click();")
                .unwrap();
        })?;
        Ok(())
    }
    pub fn run() {
        eprintln!("FIXTURE_START");
        // The external driver owns deletion: Tauri may terminate without unwinding.
        let root = std::env::args_os()
            .nth(1)
            .map(std::path::PathBuf::from)
            .expect("NATIVE_FIXTURE_ROOT_REQUIRED")
            .canonicalize()
            .expect("NATIVE_FIXTURE_ROOT_INVALID");
        std::env::set_var("PLUR1BUS_DESKTOP_CONFIG_DIR", &root);
        SettingsStore::new(root.clone())
            .set(&Settings {
                locale: Locale::En,
                ..Default::default()
            })
            .unwrap();
        let secondary = std::env::args_os().any(|arg| arg == "--secondary");
        let second = Arc::new(AtomicBool::new(false));
        let singleton_second = second.clone();
        let setup_second = second.clone();
        let report = Arc::new(Mutex::new(Report::default()));
        let modal = Arc::new(AtomicBool::new(false));
        let failed = Arc::new(AtomicBool::new(false));
        let mut context = tauri::generate_context!();
        context.config_mut().identifier = plur1bus_desktop::lifecycle::fixture_identifier(
            plur1bus_desktop::ids::BUNDLE_ID,
            &root.to_string_lossy(),
        );
        context.config_mut().app.windows.clear();
        let setup_root = root.clone();
        let setup_report = report.clone();
        let setup_modal = modal.clone();
        let setup_failed = failed.clone();
        let app = tauri::Builder::default()
            .plugin(tauri_plugin_single_instance::init(move |app, _, _| {
                singleton_second.store(true, Ordering::SeqCst);
                native::focus(app);
            }))
            .manage(native::NativeState::default())
            .manage(SpaState::default())
            .manage(commands::ConnectionState(Arc::new(
                tokio::sync::Mutex::new(Some(Box::new(MemoryStore::default()))),
            )))
            .on_window_event(native::close)
            .invoke_handler(tauri::generate_handler![
                commands::app_info,
                commands::settings_get,
                commands::settings_set,
                commands::connections_list,
                commands::quit_request,
                commands::quit_offer,
                commands::quit_response,
                commands::background_hint,
                commands::crash_offers,
                commands::crash_handled
            ])
            .setup(move |app| {
                if secondary {
                    return Err("FIXTURE_SINGLETON_BYPASSED".into());
                }
                eprintln!("FIXTURE_SETUP");
                native::build_tray(app.handle())?;
                let title_modal = setup_modal.clone();
                WebviewWindowBuilder::new(app, "shell", WebviewUrl::App("index.html".into()))
                    .incognito(true)
                    .data_directory(setup_root.join("shell-profile"))
                    .on_document_title_changed(move |_, title| {
                        if matches!(title.as_str(), "WP6_QUIT_DEFAULT" | "WP6_QUIT_DEFAULT_2") {
                            title_modal.store(true, Ordering::SeqCst);
                        }
                    })
                    .build()?;
                WebviewWindowBuilder::new(app, "spa", WebviewUrl::App("index.html".into()))
                    .incognito(true)
                    .data_directory(setup_root.join("spa-profile"))
                    .build()?;
                let handle = app.handle().clone();
                let report = setup_report.clone();
                let modal = setup_modal.clone();
                let failed = setup_failed.clone();
                let root = setup_root.clone();
                let second = setup_second.clone();
                std::thread::spawn(move || {
                    if let Err(reason) = exercise(&handle, &report, &modal, &root, &second) {
                        failed.store(true, Ordering::SeqCst);
                        eprintln!("{reason}");
                        handle.state::<native::NativeState>().quit.request(false);
                        let _ = handle
                            .state::<native::NativeState>()
                            .quit
                            .approve(plur1bus_desktop::lifecycle::QuitChoice::KeepRunning, false);
                        handle.exit(2);
                    }
                });
                Ok(())
            })
            .build(context)
            .expect("NATIVE_FIXTURE_BUILD_FAILED");
        let final_report = report.clone();
        app.run(move |app, event| {
            if native::guard_exit(app, &event) {
                return;
            }
            if matches!(event, tauri::RunEvent::ExitRequested { .. })
                && app.state::<native::NativeState>().quit.is_approved()
            {
                let mut result = final_report.lock().unwrap();
                result.quit_confirm_exits = true;
                let complete = result.second_instance_focus
                    && result.spa_focus
                    && result.close_hides
                    && result.close_minimizes
                    && result.shell_focus
                    && result.quit_modal_default
                    && result.quit_cancel_preserves_app;
                println!("{}", serde_json::to_string(&*result).unwrap());
                use std::io::Write;
                let _ = std::io::stdout().flush();
                if !complete {
                    std::process::exit(2);
                }
            }
        });
        let report = report.lock().unwrap();
        let complete = report.second_instance_focus
            && report.spa_focus
            && report.close_hides
            && report.close_minimizes
            && report.shell_focus
            && report.quit_modal_default
            && report.quit_cancel_preserves_app
            && report.quit_confirm_exits;
        println!("{}", serde_json::to_string(&*report).unwrap());
        if failed.load(Ordering::SeqCst) || !complete {
            std::process::exit(2);
        }
    }
}
#[cfg(debug_assertions)]
fn main() {
    fixture::run();
}
#[cfg(not(debug_assertions))]
fn main() {
    eprintln!("NATIVE_FIXTURE_UNAVAILABLE");
    std::process::exit(2);
}
