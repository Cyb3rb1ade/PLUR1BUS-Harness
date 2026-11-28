use log::{LevelFilter, Log, Metadata, Record};
use std::sync::{Arc, Mutex};

struct Recorder(Arc<Mutex<Vec<String>>>);

impl Log for Recorder {
    fn enabled(&self, _: &Metadata<'_>) -> bool {
        true
    }

    fn log(&self, record: &Record<'_>) {
        if let Ok(mut entries) = self.0.lock() {
            entries.push(record.args().to_string());
        }
    }

    fn flush(&self) {}
}

#[test]
fn installed_logger_applies_the_wire_record_policy() -> Result<(), Box<dyn std::error::Error>> {
    let entries = Arc::new(Mutex::new(Vec::new()));
    plur1bus_wire_log::install(Recorder(entries.clone()))?;
    log::set_max_level(LevelFilter::Debug);
    log::info!(target: "wire_dependency", "info");
    log::warn!(target: "wire_dependency", "warning");
    log::debug!(target: "plur1bus_channels", "debug");
    let recorded = entries.lock().map_err(|_| "recording lock poisoned")?;
    assert_eq!(*recorded, ["warning", "debug"]);
    Ok(())
}
