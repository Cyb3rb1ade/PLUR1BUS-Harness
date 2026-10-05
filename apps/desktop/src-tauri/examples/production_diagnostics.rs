#[cfg(debug_assertions)]
mod fixture {
    use plur1bus_desktop::{commands, diagnostics, native, secrets::MemoryStore, spa::SpaState};
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    };
    use std::time::{Duration, Instant};
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

    #[derive(Default, serde::Serialize)]
    struct Report {
        restart_offers_crash: bool,
        modal_plain_text_redacted: bool,
        escape_preserves_offer: bool,
        dismiss_consumes_offer: bool,
        idle_timer_flushes: bool,
        confirmed_quit_takes_diagnostics: bool,
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
        .map_err(|_| "DIAGNOSTICS_GUI_DISPATCH_FAILED")?;
        receiver
            .recv_timeout(budget)
            .map_err(|_| "DIAGNOSTICS_GUI_TIMEOUT")
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
        Err("DIAGNOSTICS_OBSERVER_TIMEOUT")
    }
    fn eval(app: &tauri::AppHandle, source: &'static str) -> Result<(), &'static str> {
        gui(
            app,
            move |app| {
                app.get_webview_window("shell")
                    .unwrap()
                    .eval(source)
                    .map_err(|_| "DIAGNOSTICS_EVAL_FAILED")
            },
            Duration::from_secs(5),
        )?
    }
    fn exercise(
        app: &tauri::AppHandle,
        report: &Arc<Mutex<Report>>,
        modal: &Arc<AtomicBool>,
        escaped: &Arc<AtomicBool>,
        root: &std::path::Path,
    ) -> Result<(), &'static str> {
        let reporter = app
            .state::<native::NativeState>()
            .diagnostics
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .crash
            .clone();
        let offers = reporter
            .pending()
            .map_err(|_| "DIAGNOSTICS_CRASH_READ_FAILED")?;
        if offers.len() != 1 {
            return Err("DIAGNOSTICS_CRASH_MISSING");
        }
        report.lock().unwrap().restart_offers_crash = true;
        eval(
            app,
            r#"(() => { const timer = setInterval(() => {
          const dialog = document.querySelector('dialog[data-crash-offer]');
          if (!dialog?.open) return;
          clearInterval(timer);
          const pre = dialog.querySelector('pre');
          const text = pre?.textContent || '';
          if (text.includes('PLUR1BUS desktop crash') && text.includes('Backtrace:') && pre.childElementCount === 0
            && !text.includes('wp06NativeCrashCanary') && !text.includes('wp06NativeTicket') && !text.includes('wp06NativeCookie')) document.title = 'WP6_CRASH_MODAL';
        }, 20); })();"#,
        )?;
        let seen = modal.clone();
        observe(app, move |_| seen.load(Ordering::SeqCst))
            .map_err(|_| "DIAGNOSTICS_MODAL_MISSING")?;
        report.lock().unwrap().modal_plain_text_redacted = true;
        eval(
            app,
            r#"(() => { const d = document.querySelector('dialog[data-crash-offer]');
          const e = new Event('cancel', {cancelable:true}); d.dispatchEvent(e);
          if (e.defaultPrevented && d.open) document.title = 'WP6_CRASH_ESCAPE'; })();"#,
        )?;
        let seen = escaped.clone();
        observe(app, move |_| seen.load(Ordering::SeqCst))
            .map_err(|_| "DIAGNOSTICS_ESCAPE_FAILED")?;
        if reporter
            .pending()
            .map_err(|_| "DIAGNOSTICS_CRASH_READ_FAILED")?
            .len()
            != 1
        {
            return Err("DIAGNOSTICS_ESCAPE_CONSUMED");
        }
        report.lock().unwrap().escape_preserves_offer = true;
        eval(
            app,
            "document.querySelector('dialog[data-crash-offer] .button-primary').click();",
        )?;
        observe(app, move |_| {
            reporter.pending().is_ok_and(|offers| offers.is_empty())
        })
        .map_err(|_| "DIAGNOSTICS_DISMISS_FAILED")?;
        report.lock().unwrap().dismiss_consumes_offer = true;
        // No manual tick or injected clock: observe the native 60-second task on disk.
        // The first timer wake can precede the dedup window by milliseconds; allow the next wake.
        let deadline = Instant::now() + Duration::from_secs(125);
        let mut flushed = false;
        while Instant::now() < deadline {
            for entry in
                std::fs::read_dir(root.join("logs")).map_err(|_| "DIAGNOSTICS_LOG_READ_FAILED")?
            {
                let path = entry.map_err(|_| "DIAGNOSTICS_LOG_READ_FAILED")?.path();
                if path
                    .extension()
                    .is_none_or(|extension| extension != "jsonl")
                {
                    continue;
                }
                let text =
                    std::fs::read_to_string(path).map_err(|_| "DIAGNOSTICS_LOG_READ_FAILED")?;
                flushed |= text.lines().any(|line| {
                    serde_json::from_str::<serde_json::Value>(line).is_ok_and(|record| {
                        record["event"] == "desktop.deeplink.ignored"
                            && record["attrs"]["repeat"] == 2
                    })
                });
            }
            if flushed {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        if !flushed {
            return Err("DIAGNOSTICS_IDLE_TIMER_FAILED");
        }
        report.lock().unwrap().idle_timer_flushes = true;
        eval(
            app,
            r#"(() => { const timer = setInterval(() => {
          const d = document.querySelector('dialog[data-quit]'); if (!d?.open) return;
          clearInterval(timer); d.querySelector('.button-primary').click(); },20); })();"#,
        )?;
        app.exit(0);
        Ok(())
    }
    pub fn run() {
        let root = std::env::args_os()
            .nth(1)
            .map(std::path::PathBuf::from)
            .expect("DIAGNOSTICS_ROOT_REQUIRED")
            .canonicalize()
            .expect("DIAGNOSTICS_ROOT_INVALID");
        std::env::set_var("PLUR1BUS_DESKTOP_CONFIG_DIR", &root);
        if std::env::args_os().any(|arg| arg == "--panic") {
            let diagnostics = diagnostics::Diagnostics::open(
                &root.join("logs"),
                "/synthetic/home",
                "native-fixture",
            )
            .unwrap();
            diagnostics
                .secrets
                .register("wp06NativeCrashCanary")
                .unwrap();
            diagnostics.crash.install_hook().unwrap();
            panic!("wp06NativeCrashCanary ticket=wp06NativeTicket Cookie: sid=wp06NativeCookie");
        }
        let report = Arc::new(Mutex::new(Report::default()));
        let modal = Arc::new(AtomicBool::new(false));
        let escaped = Arc::new(AtomicBool::new(false));
        let mut context = tauri::generate_context!();
        context.config_mut().identifier = plur1bus_desktop::lifecycle::fixture_identifier(
            plur1bus_desktop::ids::BUNDLE_ID,
            &root.to_string_lossy(),
        );
        context.config_mut().app.windows.clear();
        let setup_report = report.clone();
        let setup_modal = modal.clone();
        let setup_escaped = escaped.clone();
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
                commands::quit_offer,
                commands::quit_response,
                commands::background_hint,
                commands::crash_offers,
                commands::crash_handled
            ])
            .setup(move |app| {
                diagnostics::start(app.handle())?;
                let writer = app
                    .state::<native::NativeState>()
                    .diagnostics
                    .lock()
                    .unwrap()
                    .as_ref()
                    .unwrap()
                    .writer
                    .clone();
                for _ in 0..2 {
                    writer.emit(plur1bus_desktop::logging::RecordInput::new(
                        plur1bus_desktop::logging::Event::DeeplinkIgnored,
                    ))?;
                }
                let title_modal = setup_modal.clone();
                let title_escaped = setup_escaped.clone();
                WebviewWindowBuilder::new(app, "shell", WebviewUrl::App("index.html".into()))
                    .incognito(true)
                    .data_directory(root.join("shell-profile"))
                    .on_document_title_changed(move |_, title| {
                        if title == "WP6_CRASH_MODAL" {
                            title_modal.store(true, Ordering::SeqCst);
                        }
                        if title == "WP6_CRASH_ESCAPE" {
                            title_escaped.store(true, Ordering::SeqCst);
                        }
                    })
                    .build()?;
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    if let Err(reason) =
                        exercise(&handle, &setup_report, &setup_modal, &setup_escaped, &root)
                    {
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
            .expect("DIAGNOSTICS_BUILD_FAILED");
        let native_exit_code = app.run_return(move |app, event| {
            if native::guard_exit(app, &event) {
                return;
            }
            if matches!(event, tauri::RunEvent::ExitRequested { .. })
                && app.state::<native::NativeState>().quit.is_approved()
            {
                let mut result = report.lock().unwrap();
                result.confirmed_quit_takes_diagnostics = app
                    .state::<native::NativeState>()
                    .diagnostics
                    .lock()
                    .unwrap()
                    .is_none();
                println!("{}", serde_json::to_string(&*result).unwrap());
                use std::io::Write;
                let _ = std::io::stdout().flush();
                if !result.restart_offers_crash
                    || !result.modal_plain_text_redacted
                    || !result.escape_preserves_offer
                    || !result.dismiss_consumes_offer
                    || !result.idle_timer_flushes
                    || !result.confirmed_quit_takes_diagnostics
                {
                    std::process::exit(2);
                }
            }
        });
        if native_exit_code != 0 {
            std::process::exit(native_exit_code);
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
