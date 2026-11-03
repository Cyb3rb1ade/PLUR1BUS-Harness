//! Frontend-independent key semantics. Native input and the TUI use the same delivery and interruption rules.
use super::{
    pump::{Bus, Event},
    render, CodeError,
};
use reedline::{
    default_emacs_keybindings, EditCommand, EditMode, Emacs, ExternalPrinter, HistoryItem, KeyCode,
    KeyModifiers, Prompt, PromptEditMode, PromptHistorySearch, Reedline, ReedlineEvent,
    ReedlineRawEvent, Signal,
};
use std::time::Duration;
use std::{
    borrow::Cow,
    io::{self, BufRead, Read, Write},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender, TrySendError},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::Instant,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum AcceptKey {
    Enter,
    AltEnter,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Delivery {
    Submit,
    Steer,
    Queue,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Interrupt {
    Cancel,
    Exit,
    Clear,
}

pub(super) fn delivery(key: AcceptKey, busy: bool) -> Delivery {
    match key {
        AcceptKey::AltEnter => Delivery::Queue,
        AcceptKey::Enter if busy => Delivery::Steer,
        AcceptKey::Enter => Delivery::Submit,
    }
}

#[derive(Default)]
pub(super) struct Interrupts {
    last: Option<Duration>,
}

impl Interrupts {
    pub fn press(&mut self, now: Duration, busy: bool) -> Interrupt {
        let repeated = self
            .last
            .is_some_and(|last| now.saturating_sub(last) <= Duration::from_secs(2));
        self.last = Some(now);
        if repeated {
            Interrupt::Exit
        } else if busy {
            Interrupt::Cancel
        } else {
            Interrupt::Clear
        }
    }
}

const MAX_INPUT_BYTES: usize = 800_000;
#[derive(Default)]
pub(super) struct PromptState {
    pub header: String,
    pub status: String,
    pub partial: String,
    pub question: String,
    pub queue: String,
}
struct CodePrompt(Arc<Mutex<PromptState>>);
impl Prompt for CodePrompt {
    fn render_prompt_left(&self) -> Cow<'_, str> {
        let state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let mut text = String::new();
        for line in [&state.partial, &state.queue, &state.question] {
            if !line.is_empty() {
                text.push_str(line);
                text.push('\n');
            }
        }
        text.push_str(&state.header);
        text.push_str(" [");
        text.push_str(&state.status);
        text.push_str("] ");
        Cow::Owned(text)
    }
    fn render_prompt_right(&self) -> Cow<'_, str> {
        Cow::Borrowed("")
    }
    fn render_prompt_indicator(&self, _: PromptEditMode) -> Cow<'_, str> {
        Cow::Borrowed("› ")
    }
    fn render_prompt_multiline_indicator(&self) -> Cow<'_, str> {
        Cow::Borrowed("… ")
    }
    fn render_prompt_history_search_indicator(&self, _: PromptHistorySearch) -> Cow<'_, str> {
        Cow::Borrowed("? ")
    }
}

enum EditorCommand {
    Restore(String),
}
/// Reedline parses a batch before executing it, then exits on the first signal. Capture every Ctrl+C before that exit.
struct CodeEditMode {
    emacs: Emacs,
    bus: Bus,
    escaped: bool,
}
impl EditMode for CodeEditMode {
    fn parse_event(&mut self, event: ReedlineRawEvent) -> ReedlineEvent {
        let event = self.emacs.parse_event(event);
        if matches!(event, ReedlineEvent::CtrlC) {
            self.escaped = false;
            self.bus.send(Event::Interrupt);
            return ReedlineEvent::Edit(vec![EditCommand::Clear]);
        }
        if matches!(event, ReedlineEvent::Esc) {
            self.escaped = true;
            return event;
        }
        let escaped = std::mem::take(&mut self.escaped);
        if escaped && matches!(event, ReedlineEvent::Enter | ReedlineEvent::Submit) {
            return ReedlineEvent::ExecuteHostCommand("queue".into());
        }
        event
    }
    fn edit_mode(&self) -> PromptEditMode {
        self.emacs.edit_mode()
    }
}
/// One owner of the line editor. Input history stays in memory, including for an incognito session.
pub(super) struct Frontend {
    pub state: Arc<Mutex<PromptState>>,
    printer: Option<SyncSender<String>>,
    repaint: Option<Box<dyn Fn() + Send + Sync>>,
    controls: Option<SyncSender<EditorCommand>>,
    break_signal: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    interactive: bool,
    pipe_next: Option<SyncSender<()>>,
}
impl Frontend {
    pub fn start(
        interactive: bool,
        read_pipe: bool,
        color: bool,
        bus: Bus,
        stop: Arc<AtomicBool>,
    ) -> Result<Self, CodeError> {
        let state = Arc::new(Mutex::new(PromptState::default()));
        let break_signal = Arc::new(AtomicBool::new(false));
        let mut frontend = Self {
            state: state.clone(),
            printer: None,
            repaint: None,
            controls: None,
            break_signal: break_signal.clone(),
            stop: stop.clone(),
            thread: None,
            interactive,
            pipe_next: None,
        };
        if interactive {
            let printer = ExternalPrinter::<String>::new(32);
            frontend.printer = Some(printer.sender());
            let (controls, receiver) = mpsc::sync_channel(8);
            frontend.controls = Some(controls);
            let mut bindings = default_emacs_keybindings();
            bindings.add_binding(
                KeyModifiers::ALT,
                KeyCode::Enter,
                ReedlineEvent::ExecuteHostCommand("queue".into()),
            );
            let mode = CodeEditMode {
                emacs: Emacs::new(bindings),
                bus: bus.clone(),
                escaped: false,
            };
            let mut editor = Reedline::create()
                .with_ansi_colors(color)
                .with_edit_mode(Box::new(mode))
                .with_external_printer(printer)
                .with_break_signal(break_signal)
                .with_poll_interval(Duration::from_millis(50));
            let repaint = editor.repaint_signal();
            frontend.repaint = Some(Box::new(move || repaint.request_repaint()));
            frontend.thread = Some(
                thread::Builder::new()
                    .name("code-input".into())
                    .spawn(move || read_terminal(&mut editor, state, receiver, bus, stop))?,
            );
        } else if read_pipe {
            let (next, ready) = mpsc::sync_channel(1);
            frontend.pipe_next = Some(next);
            frontend.thread = Some(thread::Builder::new().name("code-stdin".into()).spawn(
                move || {
                    let mut input = io::stdin().lock();
                    loop {
                        let mut bytes = Vec::new();
                        let read = Read::take(&mut input, MAX_INPUT_BYTES as u64 + 1)
                            .read_until(b'\n', &mut bytes);
                        match read {
                            Ok(0) => {
                                bus.send(Event::Eof);
                                break;
                            }
                            Ok(_) if bytes.len() > MAX_INPUT_BYTES => {
                                bus.send(Event::Failed(CodeError::new(
                                    "E_INVALID_PARAMS",
                                    "input line exceeds 200000 Unicode characters",
                                )));
                                break;
                            }
                            Ok(_) => match String::from_utf8(bytes) {
                                Ok(line) => {
                                    let line = line.trim_end_matches(['\r', '\n']);
                                    if line.chars().count() > 200_000 {
                                        bus.send(Event::Failed(CodeError::new(
                                            "E_INVALID_PARAMS",
                                            "input line exceeds 200000 Unicode characters",
                                        )));
                                        break;
                                    }
                                    if !bus.send(Event::Input(line.into(), AcceptKey::Enter)) {
                                        break;
                                    }
                                    loop {
                                        if stop.load(Ordering::Acquire) {
                                            return;
                                        }
                                        match ready.recv_timeout(Duration::from_millis(50)) {
                                            Ok(()) => break,
                                            Err(mpsc::RecvTimeoutError::Timeout) => {}
                                            Err(mpsc::RecvTimeoutError::Disconnected) => return,
                                        }
                                    }
                                }
                                Err(_) => {
                                    bus.send(Event::Failed(CodeError::new(
                                        "E_INVALID_PARAMS",
                                        "stdin is not valid UTF-8",
                                    )));
                                    break;
                                }
                            },
                            Err(error) => {
                                bus.send(Event::Failed(error.into()));
                                break;
                            }
                        }
                    }
                },
            )?);
        }
        Ok(frontend)
    }
    pub fn update(&self, f: impl FnOnce(&mut PromptState)) {
        f(&mut self.state.lock().unwrap_or_else(|e| e.into_inner()));
        if let Some(repaint) = &self.repaint {
            repaint();
        }
    }
    pub fn print(&self, text: &str) -> Result<(), CodeError> {
        if text.is_empty() {
            return Ok(());
        }
        if let Some(printer) = &self.printer {
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut text = text.trim_end_matches('\n').to_string();
            loop {
                match printer.try_send(text) {
                    Ok(()) => return Ok(()),
                    Err(TrySendError::Disconnected(_)) => {
                        return Err(CodeError::new("E_IO", "line editor closed"))
                    }
                    Err(TrySendError::Full(value)) => {
                        if self.stop.load(Ordering::Acquire) || Instant::now() >= deadline {
                            return Err(CodeError::new(
                                "E_BUSY",
                                "terminal output backlog exceeded; transcript remains replayable",
                            ));
                        }
                        text = value;
                        thread::park_timeout(Duration::from_millis(5));
                    }
                }
            }
        }
        let mut output = io::stdout().lock();
        output.write_all(text.as_bytes())?;
        if !text.ends_with('\n') {
            output.write_all(b"\n")?;
        }
        output.flush()?;
        Ok(())
    }
    pub fn restore(&self, text: &str) -> Result<(), CodeError> {
        if let Some(controls) = &self.controls {
            controls
                .try_send(EditorCommand::Restore(text.into()))
                .map_err(|_| CodeError::new("E_BUSY", "editor control backlog exceeded"))?;
            self.break_signal.store(true, Ordering::Release);
        }
        Ok(())
    }
    pub fn next_line(&self) {
        if let Some(next) = &self.pipe_next {
            let _ = next.try_send(());
        }
    }
}
impl Drop for Frontend {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        self.break_signal.store(true, Ordering::Release);
        if self.interactive {
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
            let _ = crossterm::terminal::disable_raw_mode();
        }
        // A pipe may remain open indefinitely. It owns no terminal and is detached at process exit.
    }
}

struct TerminalRestore;
impl Drop for TerminalRestore {
    fn drop(&mut self) {
        let _ = crossterm::terminal::disable_raw_mode();
        let _ = crossterm::execute!(
            io::stdout(),
            crossterm::event::DisableBracketedPaste,
            crossterm::cursor::Show
        );
    }
}
fn read_terminal(
    editor: &mut Reedline,
    state: Arc<Mutex<PromptState>>,
    controls: Receiver<EditorCommand>,
    bus: Bus,
    stop: Arc<AtomicBool>,
) {
    let _restore = TerminalRestore;
    let prompt = CodePrompt(state);
    while !stop.load(Ordering::Acquire) {
        match editor.read_line(&prompt) {
            Ok(Signal::Success(line)) => {
                if line.chars().count() > 200_000 {
                    if !bus.send(Event::Notice("input-too-long".into())) {
                        break;
                    }
                    continue;
                }
                if !bus.send(Event::Input(line, AcceptKey::Enter)) {
                    break;
                }
            }
            Ok(Signal::HostCommand(command)) if command == "queue" => {
                let line = editor.current_buffer_contents().to_string();
                if line.chars().count() > 200_000 {
                    bus.send(Event::Notice("input-too-long".into()));
                    continue;
                }
                let _ = editor
                    .history_mut()
                    .save(HistoryItem::from_command_line(&line));
                editor.run_edit_commands(&[EditCommand::Clear]);
                if !bus.send(Event::Input(line, AcceptKey::AltEnter)) {
                    break;
                }
            }
            Ok(Signal::CtrlC) => {
                if !bus.send(Event::Interrupt) {
                    break;
                }
            }
            Ok(Signal::CtrlD) => {
                if !bus.send(Event::Eof) {
                    break;
                }
            }
            Ok(Signal::ExternalBreak(_)) => {
                for control in controls.try_iter() {
                    match control {
                        EditorCommand::Restore(text)
                            if editor.current_buffer_contents().is_empty() =>
                        {
                            editor.run_edit_commands(&[EditCommand::InsertString(text)])
                        }
                        EditorCommand::Restore(text) => {
                            bus.send(Event::Notice(format!(
                                "unsent: {}",
                                render::safe(&text, true)
                            )));
                        }
                    }
                }
            }
            Ok(_) => {}
            Err(error) => {
                bus.send(Event::Failed(error.into()));
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn enter_steers_only_while_busy_and_alt_enter_explicitly_queues() {
        assert_eq!(delivery(AcceptKey::Enter, false), Delivery::Submit);
        assert_eq!(delivery(AcceptKey::Enter, true), Delivery::Steer);
        assert_eq!(delivery(AcceptKey::AltEnter, true), Delivery::Queue);
        assert_eq!(delivery(AcceptKey::AltEnter, false), Delivery::Queue);
    }
    #[test]
    fn interrupt_twice_within_two_seconds_exits_without_sleeping() {
        let mut keys = Interrupts::default();
        assert_eq!(keys.press(Duration::ZERO, true), Interrupt::Cancel);
        assert_eq!(
            keys.press(Duration::from_millis(1999), true),
            Interrupt::Exit
        );
        let mut keys = Interrupts::default();
        assert_eq!(keys.press(Duration::ZERO, false), Interrupt::Clear);
        assert_eq!(keys.press(Duration::from_secs(3), true), Interrupt::Cancel);
    }
    #[test]
    fn a_batch_keeps_both_interrupts_and_escape_enter_is_consumed_as_one_queue_intent() {
        let (bus, receiver) = Bus::channel(Arc::new(AtomicBool::new(false)));
        let mut mode = CodeEditMode {
            emacs: Emacs::new(default_emacs_keybindings()),
            bus,
            escaped: false,
        };
        let key = |code, modifiers| {
            ReedlineRawEvent::try_from(crossterm::event::Event::Key(
                crossterm::event::KeyEvent::new(code, modifiers),
            ))
            .expect("key")
        };
        for _ in 0..2 {
            assert!(matches!(
                mode.parse_event(key(KeyCode::Char('c'), KeyModifiers::CONTROL)),
                ReedlineEvent::Edit(_)
            ));
        }
        assert!(matches!(
            receiver.recv().expect("first").into_event(),
            Event::Interrupt
        ));
        assert!(matches!(
            receiver.recv().expect("second").into_event(),
            Event::Interrupt
        ));
        mode.parse_event(key(KeyCode::Esc, KeyModifiers::NONE));
        assert_eq!(
            mode.parse_event(key(KeyCode::Enter, KeyModifiers::NONE)),
            ReedlineEvent::ExecuteHostCommand("queue".into())
        );
        mode.parse_event(key(KeyCode::Esc, KeyModifiers::NONE));
        mode.parse_event(key(KeyCode::Char('x'), KeyModifiers::NONE));
        assert_ne!(
            mode.parse_event(key(KeyCode::Enter, KeyModifiers::NONE)),
            ReedlineEvent::ExecuteHostCommand("queue".into())
        );
    }
}
