//! Fullscreen presentation behind the native frontend. The shared runtime retains every RPC and permission decision.
mod editor;
mod layout;
mod model;
mod status;
mod terminal;
mod tools;
mod view;
mod worker;

use super::{
    input::PromptState,
    lang::Language,
    pump::{Bus, Event},
    CodeError,
};
use serde_json::Value;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, SyncSender},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::Duration,
};

pub(super) enum Control {
    Restore(String),
}

/// A presentation lease only. The caller retains the existing RPC client and event reader.
pub(super) struct Handle {
    screen: Arc<Mutex<model::Screen>>,
    controls: SyncSender<Control>,
    local_stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Handle {
    /// Start one terminal-owning thread; fail before returning when terminal acquisition fails.
    pub fn start(
        prompt: Arc<Mutex<PromptState>>,
        bus: Bus,
        stop: Arc<AtomicBool>,
        color: bool,
        lang: Language,
    ) -> Result<Self, CodeError> {
        let screen = Arc::new(Mutex::new(model::Screen::default()));
        let local_stop = Arc::new(AtomicBool::new(false));
        let (controls, receiver) = mpsc::sync_channel(8);
        let (ready, started) = mpsc::sync_channel(1);
        let bus = bus.with_stop(local_stop.clone());
        let context = worker::Worker {
            screen: screen.clone(),
            prompt,
            bus: bus.clone(),
            stop,
            local_stop: local_stop.clone(),
            controls: receiver,
            ready,
            color,
            lang,
        };
        let thread = thread::Builder::new()
            .name("code-tui".into())
            .spawn(move || {
                let result =
                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| worker::run(context)));
                match result {
                    Ok(Err(error)) => {
                        bus.send(Event::Failed(error));
                    }
                    Err(_) => {
                        bus.send(Event::Failed(CodeError::new(
                            "E_IO",
                            lang.text("Terminal renderer stopped", "Terminalanzeige beendet"),
                        )));
                    }
                    Ok(Ok(())) => {}
                }
            })?;
        let mut handle = Self {
            screen,
            controls,
            local_stop,
            thread: Some(thread),
        };
        match started.recv_timeout(Duration::from_secs(10)) {
            Ok(Ok(())) => Ok(handle),
            Ok(Err(error)) => {
                handle.shutdown();
                Err(error)
            }
            Err(_) => {
                handle.shutdown();
                Err(CodeError::new(
                    "E_IO",
                    lang.text(
                        "Terminal initialization failed",
                        "Terminal konnte nicht initialisiert werden",
                    ),
                ))
            }
        }
    }

    /// Append human display text; its retained window never alters the durable transcript.
    pub fn append(&self, text: &str) {
        self.screen
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .append(text);
    }

    /// Consume only the caller's already-filtered session events.
    pub fn observe(&self, kind: &str, data: &Value) {
        let mut screen = self.screen.lock().unwrap_or_else(|e| e.into_inner());
        match kind {
            "tool.call" => screen.tools.call(data),
            "tool.result" => screen.tools.result(
                data["id"].as_str().unwrap_or(""),
                data["output"].as_str().unwrap_or(""),
                data["isError"] == true,
            ),
            "turn.completed" => screen.status.usage(data),
            _ => {}
        }
    }

    /// Read-only core metadata; null/error values clear only their own unavailable projection.
    pub fn metadata(&self, method: &str, value: &Value, session: &str, agent: &str) {
        let mut screen = self.screen.lock().unwrap_or_else(|e| e.into_inner());
        match method {
            "session.model.get" => screen.status.read_model(value),
            "telemetry.cache.summary" => screen.status.read_cache(value, session, agent),
            "budget.status" => screen.status.read_budget(value, agent),
            _ => {}
        }
    }

    /// Display another page from the same bound core diff operation.
    pub fn diff(&self, patch: &str, append: bool) {
        let mut screen = self.screen.lock().unwrap_or_else(|e| e.into_inner());
        screen.tools.show_diff(patch, append);
        screen.tool_scroll = 0;
    }

    /// Restore an unsubmitted draft after a concurrent question or busy operation.
    pub fn restore(&self, text: &str) -> Result<(), CodeError> {
        self.controls
            .try_send(Control::Restore(text.into()))
            .map_err(|_| CodeError::new("E_BUSY", "terminal control backlog exceeded"))
    }

    fn shutdown(&mut self) {
        self.local_stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
impl Drop for Handle {
    fn drop(&mut self) {
        self.shutdown();
    }
}
