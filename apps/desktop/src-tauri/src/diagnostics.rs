//! Native D111 startup: one private writer and redaction boundary per app.
use crate::{crash::CrashReporter, logging::*};
use std::{path::Path, sync::Arc};
use tauri::Manager;
pub struct Diagnostics {
    pub writer: Writer,
    pub crash: CrashReporter,
    pub secrets: Arc<SecretRegistry>,
    ticker: Option<tauri::async_runtime::JoinHandle<()>>,
}
impl Diagnostics {
    /// Caller supplies its owned location; no implicit HOME lookup in this testable seam.
    pub fn open(directory: &Path, home: &str, target: &str) -> Result<Self> {
        if !directory.is_absolute()
            || directory.components().any(|part| {
                matches!(
                    part,
                    std::path::Component::ParentDir | std::path::Component::CurDir
                )
            })
        {
            return Err(LogError::Invalid("diagnostic directory"));
        }
        // Refuse an existing symlink before creating any owned leaf. Writer rechecks ancestry and handles.
        for path in directory.ancestors() {
            match std::fs::symlink_metadata(path) {
                Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => {
                    return Err(LogError::Invalid("diagnostic ancestry"))
                }
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        let mut builder = std::fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(directory)?;
        let secrets = SecretRegistry::process();
        let formatter = Formatter::new(secrets.clone(), Arc::new(CredentialPaths::new(home)), true);
        let writer = Writer::open(
            directory,
            WriterOptions::default(),
            formatter,
            Arc::new(SystemClock),
        )?;
        let crash = CrashReporter::new(writer.clone(), target)?;
        writer.emit(RecordInput::new(Event::AppStarted))?;
        Ok(Self {
            writer,
            crash,
            secrets,
            ticker: None,
        })
    }
}
pub fn start(app: &tauri::AppHandle) -> Result<(), &'static str> {
    #[cfg(debug_assertions)]
    let fixture = std::env::var_os("PLUR1BUS_DESKTOP_CONFIG_DIR").map(std::path::PathBuf::from);
    #[cfg(not(debug_assertions))]
    let fixture: Option<std::path::PathBuf> = None;
    let (directory, home) = if let Some(root) = fixture {
        (root.join("logs"), "/synthetic/home".to_owned())
    } else {
        (
            app.path()
                .app_log_dir()
                .map_err(|_| "DIAGNOSTIC_LOCATION_FAILED")?,
            app.path()
                .home_dir()
                .map_err(|_| "DIAGNOSTIC_LOCATION_FAILED")?
                .to_string_lossy()
                .into_owned(),
        )
    };
    let target = format!("{}-{}", std::env::consts::ARCH, std::env::consts::OS);
    let mut diagnostics =
        Diagnostics::open(&directory, &home, &target).map_err(|_| "DIAGNOSTIC_START_FAILED")?;
    #[cfg(debug_assertions)]
    let install_hook = std::env::var_os("PLUR1BUS_DESKTOP_CONFIG_DIR").is_none();
    #[cfg(not(debug_assertions))]
    let install_hook = true;
    if install_hook {
        diagnostics
            .crash
            .install_hook()
            .map_err(|_| "CRASH_HOOK_INSTALL_FAILED")?;
    }
    let writer = diagnostics.writer.clone();
    diagnostics.ticker = Some(tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
            let writer = writer.clone();
            match tauri::async_runtime::spawn_blocking(move || writer.tick()).await {
                Ok(Ok(())) => {}
                _ => eprintln!("DIAGNOSTIC_TICK_FAILED"),
            }
        }
    }));
    *app.state::<crate::native::NativeState>()
        .diagnostics
        .lock()
        .unwrap() = Some(diagnostics);
    Ok(())
}

impl Drop for Diagnostics {
    fn drop(&mut self) {
        if let Some(ticker) = self.ticker.take() {
            ticker.abort();
        }
    }
}
