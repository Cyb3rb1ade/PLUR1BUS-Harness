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
    // WebView2 child focus can leave Tao's top-level WM_SETFOCUS flag false.
    // Require the real foreground window AND its queue's focused descendant.
    fn window_has_keyboard_focus(window: &tauri::WebviewWindow) -> bool {
        #[cfg(target_os = "windows")]
        {
            use windows_sys::Win32::UI::WindowsAndMessaging::{
                GetForegroundWindow, GetGUIThreadInfo, GetWindowThreadProcessId, IsChild, IsIconic,
                IsWindowVisible, GUITHREADINFO,
            };
            let Ok(handle) = window.hwnd() else {
                return false;
            };
            let hwnd = handle.0 as windows_sys::Win32::Foundation::HWND;
            let mut info: GUITHREADINFO = unsafe { std::mem::zeroed() };
            info.cbSize = std::mem::size_of::<GUITHREADINFO>() as u32;
            unsafe {
                let thread = GetWindowThreadProcessId(hwnd, std::ptr::null_mut());
                !hwnd.is_null()
                    && GetForegroundWindow() == hwnd
                    && IsWindowVisible(hwnd) != 0
                    && IsIconic(hwnd) == 0
                    && thread != 0
                    && GetGUIThreadInfo(thread, &mut info) != 0
                    && info.hwndActive == hwnd
                    && !info.hwndFocus.is_null()
                    && (info.hwndFocus == hwnd || IsChild(hwnd, info.hwndFocus) != 0)
            }
        }
        #[cfg(not(target_os = "windows"))]
        window.is_focused().unwrap_or(false)
    }
    // Read-only OS observations: never activate, attach input queues or bypass foreground lock.
    fn focus_snapshot(app: &tauri::AppHandle, stage: &'static str, elapsed_ms: u128) {
        #[cfg(target_os = "windows")]
        {
            use windows_sys::Win32::UI::WindowsAndMessaging::{
                GetAncestor, GetClassNameW, GetForegroundWindow, GetGUIThreadInfo,
                GetWindowThreadProcessId, IsChild, IsIconic, IsWindowVisible, GA_ROOTOWNER,
                GUITHREADINFO,
            };
            use windows_sys::Win32::{
                Foundation::CloseHandle,
                System::Threading::{
                    OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
                },
            };
            let foreground = unsafe { GetForegroundWindow() };
            let mut foreground_pid = 0;
            let foreground_thread =
                unsafe { GetWindowThreadProcessId(foreground, &mut foreground_pid) };
            let foreground_root_owner = unsafe { GetAncestor(foreground, GA_ROOTOWNER) };
            let mut root_owner_pid = 0;
            let root_owner_thread =
                unsafe { GetWindowThreadProcessId(foreground_root_owner, &mut root_owner_pid) };
            // Query only numeric process relations; no process names or paths leave the snapshot.
            let process_relations = unsafe {
                use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
                use windows_sys::Win32::System::Diagnostics::ToolHelp::{
                    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
                    TH32CS_SNAPPROCESS,
                };
                use windows_sys::Win32::System::RemoteDesktop::ProcessIdToSessionId;
                let ids = [std::process::id(), foreground_pid, root_owner_pid];
                let mut parents = [None; 3];
                let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
                if snapshot != INVALID_HANDLE_VALUE {
                    let mut entry: PROCESSENTRY32W = std::mem::zeroed();
                    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
                    let mut available = Process32FirstW(snapshot, &mut entry) != 0;
                    while available {
                        for (index, pid) in ids.iter().enumerate() {
                            if *pid != 0 && entry.th32ProcessID == *pid {
                                parents[index] = Some(entry.th32ParentProcessID);
                            }
                        }
                        available = Process32NextW(snapshot, &mut entry) != 0;
                    }
                    let _ = CloseHandle(snapshot);
                }
                let sessions = ids.map(|pid| {
                    let mut session = 0;
                    (pid != 0 && ProcessIdToSessionId(pid, &mut session) != 0).then_some(session)
                });
                serde_json::json!({"fixtureParentPid":parents[0],
                    "foregroundParentPid":parents[1],"rootOwnerParentPid":parents[2],
                    "fixtureSessionId":sessions[0],"foregroundSessionId":sessions[1],
                    "rootOwnerSessionId":sessions[2]})
            };

            // Window class text stays local: only fixed categories leave this fixture.
            let foreground_window_kind = unsafe {
                let mut class = [0u16; 256];
                let len = GetClassNameW(foreground, class.as_mut_ptr(), class.len() as i32);
                if len == 0 {
                    "unavailable"
                } else {
                    match String::from_utf16_lossy(&class[..len as usize]).as_str() {
                        "#32770" => "dialog",
                        "Chrome_WidgetWin_0" | "Chrome_WidgetWin_1" => "chromium",
                        "ConsoleWindowClass" | "CASCADIA_HOSTING_WINDOW_CLASS" => "console",
                        "Windows.UI.Core.CoreWindow" | "ApplicationFrameWindow" => "core-window",
                        "Progman" | "WorkerW" | "Shell_TrayWnd" => "desktop-shell",
                        _ => "other",
                    }
                }
            };
            // Only a fixed process category leaves the fixture; never emit an image path.
            let foreground_process_kind = unsafe {
                let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, foreground_pid);
                if process.is_null() {
                    "unavailable"
                } else {
                    let mut image = [0u16; 1024];
                    let mut len = image.len() as u32;
                    let read = QueryFullProcessImageNameW(process, 0, image.as_mut_ptr(), &mut len);
                    let _ = CloseHandle(process);
                    if read == 0 {
                        "unavailable"
                    } else {
                        let image =
                            String::from_utf16_lossy(&image[..len as usize]).to_ascii_lowercase();
                        match image.rsplit(['\\', '/']).next().unwrap_or("") {
                            "explorer.exe" => "explorer",
                            "powershell.exe" | "pwsh.exe" => "powershell",
                            "conhost.exe" | "openconsole.exe" | "windowsterminal.exe" => "terminal",
                            "msedge.exe" | "chrome.exe" => "browser",
                            "msedgewebview2.exe" => "webview",
                            "logonui.exe" | "winlogon.exe" => "logon",
                            "dwm.exe" => "dwm",
                            "production_spa.exe" => "spa-fixture",
                            "production_driver.exe" => "spa-driver",
                            "transport_spike.exe" => "transport-fixture",
                            "production_lifecycle.exe" => "lifecycle-fixture",
                            "production_diagnostics.exe" => "diagnostics-fixture",
                            "node.exe" | "cargo.exe" | "rustc.exe" | "cmd.exe" => "build-host",
                            "applicationframehost.exe"
                            | "shellexperiencehost.exe"
                            | "startmenuexperiencehost.exe"
                            | "runtimebroker.exe" => "shell-host",
                            "werfault.exe" | "werfaultsecure.exe" => "error-dialog",
                            name if name.ends_with(".exe")
                                && [
                                    "production_spa-",
                                    "production_driver-",
                                    "transport_spike-",
                                ]
                                .iter()
                                .any(|prefix| name.starts_with(prefix)) =>
                            {
                                "fixture-test"
                            }
                            _ => "other",
                        }
                    }
                }
            };
            let queue = |thread| {
                let mut info: GUITHREADINFO = unsafe { std::mem::zeroed() };
                info.cbSize = std::mem::size_of::<GUITHREADINFO>() as u32;
                let available = thread != 0 && unsafe { GetGUIThreadInfo(thread, &mut info) } != 0;
                (available, info.hwndActive, info.hwndFocus)
            };
            let (foreground_queue_available, foreground_active, foreground_focus) =
                queue(foreground_thread);
            let windows: Vec<_> = ["shell", "spa"]
                .into_iter()
                .map(|label| {
                    let window = app.get_webview_window(label);
                    let hwnd = window
                        .as_ref()
                        .and_then(|w| w.hwnd().ok())
                        .map(|h| h.0 as windows_sys::Win32::Foundation::HWND)
                        .unwrap_or(std::ptr::null_mut());
                    let mut pid = 0;
                    let thread = unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
                    let (queue_available, active, keyboard_focus) = queue(thread);
                    let keyboard_focus_within = !hwnd.is_null()
                        && !keyboard_focus.is_null()
                        && (keyboard_focus == hwnd
                            || unsafe { IsChild(hwnd, keyboard_focus) } != 0);
                    serde_json::json!({"label":label,"hwnd":hwnd as usize,
                    "visible":unsafe { IsWindowVisible(hwnd) } != 0,
                    "minimized":unsafe { IsIconic(hwnd) } != 0,
                    "foreground":hwnd == foreground && !hwnd.is_null(),
                    "pid":pid,"thread":thread,"queueAvailable":queue_available,
                    "activeHwnd":active as usize,"keyboardFocusHwnd":keyboard_focus as usize,
                    "keyboardFocusWithin":keyboard_focus_within,
                    "tauriFocused":window.and_then(|w| w.is_focused().ok())})
                })
                .collect();
            eprintln!(
                "WP6_FOCUS_DIAGNOSTIC {}",
                serde_json::json!({
                "stage":stage,"elapsedMs":elapsed_ms,"foregroundHwnd":foreground as usize,
                "foregroundPid":foreground_pid,"foregroundThread":foreground_thread,
                "foregroundRootOwnerHwnd":foreground_root_owner as usize,"foregroundWindowKind":foreground_window_kind,
                "rootOwnerPid":root_owner_pid,"rootOwnerThread":root_owner_thread,"processRelations":process_relations,
                "processId":std::process::id(),"foregroundProcessKind":foreground_process_kind,"foregroundQueueAvailable":foreground_queue_available,
                "foregroundActiveHwnd":foreground_active as usize,"foregroundKeyboardFocusHwnd":foreground_focus as usize,
                "windows":windows})
            );
        }
        #[cfg(not(target_os = "windows"))]
        let _ = (app, stage, elapsed_ms);
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
            focus_snapshot(&app, "before-focus", 0);
            native::focus(&app);
            focus_snapshot(&app, "after-focus-call", 0);
        })?;
        let focus_started = Instant::now();
        let focus_result = observe(app, |app| {
            app.get_webview_window("spa")
                .is_some_and(|w| window_has_keyboard_focus(&w))
        });
        let elapsed_ms = focus_started.elapsed().as_millis();
        gui(app, move |app| {
            focus_snapshot(&app, "after-focus-observation", elapsed_ms)
        })?;
        focus_result.map_err(|_| "FIXTURE_SPA_NOT_FOCUSED")?;
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
                    w.is_visible().unwrap_or(false) && window_has_keyboard_focus(&w)
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
                .is_some_and(|w| window_has_keyboard_focus(&w))
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
                plur1bus_desktop::diagnostics::start(app.handle())?;
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
