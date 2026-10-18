#[cfg(debug_assertions)]
mod fixture {
    use plur1bus_desktop::{
        deeplink::{self, DeepLink, LinkState},
        native, spa,
    };
    use std::time::{Duration, Instant};
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

    fn take(app: &tauri::AppHandle) -> Option<DeepLink> {
        app.state::<LinkState>()
            .0
            .lock()
            .unwrap()
            .take()
            .map(|e| e.intent)
    }
    pub fn run() {
        let root = std::env::var_os("PLUR1BUS_DEEPLINK_FIXTURE_ROOT")
            .map(std::path::PathBuf::from)
            .and_then(|p| p.canonicalize().ok())
            .expect("FIXTURE_ROOT_REQUIRED");
        std::env::set_var("PLUR1BUS_DESKTOP_CONFIG_DIR", &root);
        let mut context = tauri::generate_context!();
        context.config_mut().identifier = plur1bus_desktop::lifecycle::fixture_identifier(
            plur1bus_desktop::ids::BUNDLE_ID,
            &root.to_string_lossy(),
        );
        context.config_mut().app.windows.clear();
        let app = tauri::Builder::default()
            .plugin(tauri_plugin_single_instance::init(deeplink::second_instance))
            .manage(native::NativeState::default())
            .manage(LinkState::default())
            .manage(spa::SpaState::default())
            .setup(move |app| {
                // Startup and the real singleton callback both enter production dispatch.
                deeplink::dispatch(app.handle(), std::env::args().collect());
                let initial = take(app.handle()).ok_or("FIXTURE_STARTUP_MISSING")?;
                if initial != deeplink::parse("plur1bus://pair?origin=http%3A%2F%2F127.0.0.1%3A1&code=0123-4567") {
                    return Err("FIXTURE_STARTUP_INVALID".into());
                }
                let mut logs = Vec::new();
                let mut invalid = deeplink::Inbox::default();
                for input in ["plur1bus://unknown?code=PRIVATE", "plur1bus://pair?code=%ZZ", "plur1bus://open?path=https://foreign.test"] {
                    invalid.ingest(input, |event| logs.push(event));
                }
                let ignored_fixed_only = logs == vec![deeplink::IGNORED_LOG; 3] && invalid.take().is_none();
                let route_refused_without_session = spa::navigate_active(app.handle(), uuid::Uuid::now_v7(), "/home") == Err("pairing-needed".into());
                WebviewWindowBuilder::new(app, "shell", WebviewUrl::App("index.html".into()))
                    .incognito(true).data_directory(root.join("profile")).visible(false).build()?;
                eprintln!("FIXTURE_DEEPLINK_READY");
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    let deadline = Instant::now() + Duration::from_secs(15);
                    while Instant::now() < deadline {
                        if let Some(forwarded) = take(&handle) {
                            let same = forwarded == initial;
                            println!("{}", serde_json::json!({"startup_pair_intent":true,"second_instance_same_intent":same,"ignored_fixed_only":ignored_fixed_only,"route_refused_without_session":route_refused_without_session}));
                            handle.exit(if same && ignored_fixed_only && route_refused_without_session {0} else {2});
                            return;
                        }
                        std::thread::sleep(Duration::from_millis(20));
                    }
                    eprintln!("FIXTURE_DEEPLINK_TIMEOUT");
                    handle.exit(2);
                });
                Ok(())
            }).build(context).expect("FIXTURE_BUILD_FAILED");
        std::process::exit(app.run_return(|_, _| {}));
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
