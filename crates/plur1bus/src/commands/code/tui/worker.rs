//! Terminal event loop only. It paints immutable question snapshots and publishes bounded native input intents.
use super::super::{
    input::{AcceptKey, PromptState},
    lang::Language,
    pump::{Bus, Event},
    CodeError,
};
use super::{
    editor::{Action, Editor},
    layout::Focus,
    model::Screen,
    terminal::TerminalGuard,
    view::{self, Overlay, View},
    Control,
};
use crossterm::event::{self, Event as TerminalEvent, KeyCode, KeyEventKind, KeyModifiers};
use ratatui::{backend::CrosstermBackend, Terminal};
use std::{
    io,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{Receiver, SyncSender},
        Arc, Mutex,
    },
    time::Duration,
};

pub(super) struct Worker {
    pub screen: Arc<Mutex<Screen>>,
    pub prompt: Arc<Mutex<PromptState>>,
    pub bus: Bus,
    pub stop: Arc<AtomicBool>,
    pub local_stop: Arc<AtomicBool>,
    pub controls: Receiver<Control>,
    pub ready: SyncSender<Result<(), CodeError>>,
    pub color: bool,
    pub lang: Language,
}

/// Keep the terminal guard inside the unwind boundary so it drops before a failure is sent to the runtime.
pub(super) fn run(worker: Worker) -> Result<(), CodeError> {
    let _guard = match TerminalGuard::enter() {
        Ok(guard) => guard,
        Err(error) => {
            let _ = worker.ready.send(Err(error.into()));
            return Ok(());
        }
    };
    let mut terminal = match Terminal::new(CrosstermBackend::new(io::stdout())) {
        Ok(terminal) => terminal,
        Err(error) => {
            let _ = worker.ready.send(Err(error.into()));
            return Ok(());
        }
    };
    if worker.ready.send(Ok(())).is_err() {
        return Ok(());
    }
    let mut editor = Editor::default();
    let mut answer = Editor::default();
    let mut question = None;
    let mut overlay = Overlay::None;
    let mut scroll = 0usize;
    while !worker.stop.load(Ordering::Acquire) && !worker.local_stop.load(Ordering::Acquire) {
        for command in worker.controls.try_iter() {
            match command {
                Control::Restore(text) => {
                    editor.restore(&text);
                }
            }
        }
        let prompt = worker
            .prompt
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        if prompt.question_id != question {
            question = prompt.question_id.clone();
            answer = Editor::default();
            scroll = 0;
        }
        let mut shown = false;
        {
            let screen = worker.screen.lock().unwrap_or_else(|e| e.into_inner());
            terminal.draw(|frame| {
                shown = view::render(
                    frame,
                    &View {
                        screen: &screen,
                        prompt: &prompt,
                        editor: &editor,
                        lang: worker.lang,
                        color: worker.color,
                        answer: &answer.text,
                        overlay,
                        question_scroll: scroll,
                    },
                );
            })?;
        }
        // The question belongs to the frame that completed above, not a newer unseen shared state.
        let displayed = if shown { question.clone() } else { None };
        if !event::poll(Duration::from_millis(50))? {
            continue;
        }
        match event::read()? {
            TerminalEvent::Key(key) if key.kind != KeyEventKind::Release => {
                if question.is_some()
                    && key.modifiers.contains(KeyModifiers::CONTROL)
                    && key.code == KeyCode::Char('c')
                {
                    worker.bus.send(Event::Interrupt);
                    continue;
                }
                if question.is_some() {
                    if key.code == KeyCode::Esc {
                        worker.bus.send(Event::FrontendInput {
                            line: "n".into(),
                            key: AcceptKey::Enter,
                            question: question.clone(),
                        });
                    } else if shown {
                        match key.code {
                            KeyCode::PageUp => scroll = scroll.saturating_sub(8),
                            KeyCode::PageDown => scroll = scroll.saturating_add(8),
                            _ => {
                                if let Action::Accept(line, key) = answer.key(key, true) {
                                    worker.bus.send(Event::FrontendInput {
                                        line,
                                        key,
                                        question: displayed,
                                    });
                                }
                            }
                        }
                    }
                    continue;
                }
                if overlay != Overlay::None {
                    match key.code {
                        KeyCode::Esc => {
                            overlay = Overlay::None;
                            scroll = 0;
                            continue;
                        }
                        KeyCode::PageUp => {
                            scroll = scroll.saturating_sub(8);
                            continue;
                        }
                        KeyCode::PageDown => {
                            scroll = scroll.saturating_add(8);
                            continue;
                        }
                        _ => {}
                    }
                }
                let action = editor.key(key, prompt.busy);
                apply(action, &worker, &mut editor, &mut overlay, &mut scroll);
            }
            TerminalEvent::Paste(text) => {
                let action = if question.is_some() {
                    if shown {
                        answer.paste(&text)
                    } else {
                        Action::None
                    }
                } else {
                    editor.paste(&text)
                };
                if action == Action::TooLong {
                    worker.bus.send(Event::Notice("input-too-long".into()));
                }
            }
            _ => {}
        }
    }
    Ok(())
}

fn apply(
    action: Action,
    worker: &Worker,
    editor: &mut Editor,
    overlay: &mut Overlay,
    scroll: &mut usize,
) {
    match action {
        Action::Accept(line, key) => {
            worker.bus.send(Event::FrontendInput {
                line,
                key,
                question: None,
            });
        }
        Action::Interrupt => {
            worker.bus.send(Event::Interrupt);
        }
        Action::Eof => {
            worker.bus.send(Event::Eof);
        }
        Action::Help => {
            *overlay = if *overlay == Overlay::Help {
                Overlay::None
            } else {
                Overlay::Help
            };
            *scroll = 0;
        }
        Action::Queue => {
            *overlay = if *overlay == Overlay::Queue {
                Overlay::None
            } else {
                Overlay::Queue
            };
            *scroll = 0;
        }
        Action::TooLong => {
            worker.bus.send(Event::Notice("input-too-long".into()));
        }
        Action::None => {}
        action => {
            let mut screen = worker.screen.lock().unwrap_or_else(|e| e.into_inner());
            match action {
                Action::Fold => {
                    let selected = screen.tools.selected;
                    if let Some(tool) = screen.tools.entries.get_mut(selected) {
                        tool.folded = !tool.folded;
                    }
                    screen.tool_scroll = 0;
                }
                Action::SelectTool { previous } => {
                    screen.tools.select(previous);
                    screen.tool_scroll = 0;
                }
                Action::Scroll { up } => match editor.focus {
                    Focus::Transcript => {
                        screen.transcript_scroll = if up {
                            screen.transcript_scroll.saturating_add(8)
                        } else {
                            screen.transcript_scroll.saturating_sub(8)
                        }
                    }
                    Focus::Tools => {
                        screen.tool_scroll = if up {
                            screen.tool_scroll.saturating_sub(8)
                        } else {
                            screen.tool_scroll.saturating_add(8)
                        }
                    }
                },
                Action::Edge { start } => match editor.focus {
                    Focus::Transcript => {
                        screen.transcript_scroll = if start { usize::MAX } else { 0 }
                    }
                    Focus::Tools => screen.tool_scroll = if start { 0 } else { usize::MAX },
                },
                _ => {}
            }
        }
    }
}
