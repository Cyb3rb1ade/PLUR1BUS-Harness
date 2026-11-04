//! Immediate-mode frames from bounded state. Rendering cannot perform RPC, filesystem I/O or approve anything.
use super::super::{input::PromptState, lang::Language};
use super::{editor::Editor, layout, model::Screen, status::Budget, tools::State};
use ratatui::{
    layout::Rect,
    style::{Color, Style},
    text::{Line, Text},
    widgets::{Block, Borders, Clear, Paragraph, Wrap},
    Frame,
};

/// Read-only overlays share the work area and leave the composer and queue summary intact.
#[derive(Clone, Copy, Default, PartialEq, Eq)]
pub(super) enum Overlay {
    #[default]
    None,
    Help,
    Queue,
}

pub(super) struct View<'a> {
    pub screen: &'a Screen,
    pub prompt: &'a PromptState,
    pub editor: &'a Editor,
    pub lang: Language,
    pub color: bool,
    pub answer: &'a str,
    pub overlay: Overlay,
    pub question_scroll: usize,
}

/// Paint this snapshot; true means its pending question was actually visible at a usable size.
pub(super) fn render(frame: &mut Frame<'_>, view: &View<'_>) -> bool {
    let area = frame.area();
    if area.width == 0 || area.height == 0 {
        return false;
    }
    let p = layout::panes(area, !view.prompt.queue.is_empty(), view.editor.focus);
    frame.render_widget(Paragraph::new(visible(&view.prompt.header)), p.heading);
    let mut transcript = view
        .screen
        .messages
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .join("\n");
    if !view.prompt.partial.is_empty() {
        if !transcript.is_empty() {
            transcript.push('\n');
        }
        transcript.push_str(&tail(&visible(&view.prompt.partial), 32 * 1024));
    }
    if view.screen.dropped > 0 {
        transcript = format!(
            "{} {}\n{transcript}",
            view.screen.dropped,
            view.lang.text(
                "earlier display entries omitted",
                "frühere Anzeigeeinträge ausgelassen"
            )
        );
    }
    panel(
        frame,
        p.transcript,
        view.lang
            .text("Transcript · Tab: pane", "Verlauf · Tab: Bereich"),
        Text::from(tail(&transcript, 128 * 1024)),
        view.screen.transcript_scroll,
        true,
        view.color,
    );
    tools(frame, p.tools, view);
    if p.queue.height > 0 {
        panel(
            frame,
            p.queue,
            view.lang.text(
                "Queue · F2: list · /unqueue <n>",
                "Warteschlange · F2: Liste · /unqueue <n>",
            ),
            Text::from(visible(&view.prompt.queue)),
            0,
            false,
            view.color,
        );
    }
    let status = &view.screen.status;
    let tokens = status
        .tokens
        .map_or_else(|| "—".into(), |(input, output)| format!("{input}/{output}"));
    let cache = status
        .cache
        .map_or_else(|| "—".into(), |ratio| format!("{:.1}%", ratio * 100.0));
    let budget = match &status.budget {
        None => "—".into(),
        Some(Budget::Unlimited) => view.lang.text("unlimited", "unbegrenzt").into(),
        Some(Budget::Limits(limits)) => limits
            .iter()
            .map(|limit| {
                let bound = limit
                    .hard
                    .map(|n| n.to_string())
                    .or_else(|| limit.soft.map(|n| format!("~{n}")))
                    .unwrap_or_else(|| "∞".into());
                let scope = if limit.scope == "agent" {
                    view.lang.text("agent", "Agent")
                } else {
                    "global"
                };
                let period = if limit.period == "day" {
                    view.lang.text("day", "Tag")
                } else {
                    view.lang.text("month", "Monat")
                };
                let state = match limit.state.as_str() {
                    "soft" => view.lang.text("warning", "Warnung"),
                    "hard" => view.lang.text("limit", "Limit"),
                    _ => "ok",
                };
                format!("{scope}/{period} {}/{} {state}", limit.used, bound)
            })
            .collect::<Vec<_>>()
            .join("; "),
    };
    let status_text = format!(
        "{} {} · {} {tokens} · Cache {cache} · {} {budget}\n{} · {}",
        view.lang.text("Model", "Modell"),
        status.model.as_deref().unwrap_or("—"),
        view.lang.text("Last tokens", "Letzte Tokens"),
        view.lang.text("Token budget", "Tokenbudget"),
        visible(&view.prompt.status),
        view.lang.text(
            "Tab pane · PgUp/PgDn scroll · Ctrl+F fold · F1 help",
            "Tab Bereich · Bild↑/↓ blättern · Ctrl+F klappen · F1 Hilfe"
        )
    );
    frame.render_widget(Paragraph::new(status_text), p.status);
    input(frame, p.input, view);
    let work_end = if p.queue.height > 0 {
        p.queue.y
    } else {
        p.status.y
    };
    let work = Rect::new(
        area.x,
        p.heading.bottom(),
        area.width,
        work_end.saturating_sub(p.heading.bottom()),
    );
    if view.prompt.question_id.is_some() {
        return question(frame, work, view);
    }
    match view.overlay {
        Overlay::Help => help(frame, work, view),
        Overlay::Queue => {
            let area = popup(work);
            frame.render_widget(Clear, area);
            panel(
                frame,
                area,
                view.lang.text(
                    "Queue · F2/Esc closes · PgUp/PgDn",
                    "Warteschlange · F2/Esc schließt · Bild↑/↓",
                ),
                Text::from(visible(&view.prompt.queue)),
                view.question_scroll,
                false,
                view.color,
            );
        }
        Overlay::None => {}
    }
    false
}

fn input(frame: &mut Frame<'_>, area: Rect, view: &View<'_>) {
    if area.width < 3 || area.height < 3 {
        return;
    }
    let text = &view.editor.text;
    let mut cursor = view.editor.cursor.min(text.len());
    while !text.is_char_boundary(cursor) {
        cursor -= 1;
    }
    let line_start = text[..cursor].rfind('\n').map_or(0, |i| i + 1);
    let line_end = text[cursor..].find('\n').map_or(text.len(), |i| cursor + i);
    let mut start = line_start.max(cursor.saturating_sub(4096));
    while !text.is_char_boundary(start) {
        start += 1;
    }
    let mut end = line_end.min(cursor.saturating_add(4096));
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    let marker = if start > line_start { "…" } else { "" };
    let shown = format!(
        "{marker}{}{}",
        visible(&text[start..end]),
        if end < line_end { "…" } else { "" }
    );
    let prefix = format!("{marker}{}", visible(&text[start..cursor]));
    let column = Line::raw(prefix).width();
    let offset = column.saturating_sub(area.width.saturating_sub(3) as usize);
    let count = text.bytes().filter(|c| *c == b'\n').count() + 1;
    let title = if count > 1 {
        let current = text[..cursor].bytes().filter(|c| *c == b'\n').count() + 1;
        format!(
            "{} {current}/{count} · Enter · Alt+Enter",
            view.lang.text("Message line", "Nachrichtenzeile")
        )
    } else {
        view.lang
            .text(
                "Message · Enter · Alt+Enter queues",
                "Nachricht · Enter · Alt+Enter stellt an",
            )
            .into()
    };
    frame.render_widget(
        Paragraph::new(shown)
            .block(Block::default().borders(Borders::ALL).title(title))
            .scroll((0, offset.min(u16::MAX as usize) as u16)),
        area,
    );
    frame.set_cursor_position((
        area.x
            + 1
            + column
                .saturating_sub(offset)
                .min(area.width.saturating_sub(3) as usize) as u16,
        area.y + 1,
    ));
}

fn visible(text: &str) -> String {
    super::super::render::safe(text, true).replace('\t', "    ")
}

fn tail(text: &str, bytes: usize) -> String {
    let mut start = text.len().saturating_sub(bytes);
    while !text.is_char_boundary(start) {
        start += 1;
    }
    let mut remaining = text[start..].lines().rev();
    let mut lines = remaining.by_ref().take(8192).collect::<Vec<_>>();
    let omitted_lines = remaining.next().is_some();
    lines.reverse();
    let body = lines.join("\n");
    if start > 0 || omitted_lines {
        format!("…\n{body}")
    } else {
        body
    }
}

fn panel(
    frame: &mut Frame<'_>,
    area: Rect,
    title: &str,
    text: Text<'_>,
    scroll: usize,
    follow: bool,
    color: bool,
) {
    if area.width < 3 || area.height < 2 {
        return;
    }
    let block = Block::default()
        .borders(Borders::ALL)
        .title(title)
        .border_style(if color {
            Style::default().fg(Color::Cyan)
        } else {
            Style::default()
        });
    let paragraph = Paragraph::new(text).block(block).wrap(Wrap { trim: false });
    let max = paragraph
        .line_count(area.width)
        .saturating_sub(area.height as usize);
    let offset = if follow {
        max.saturating_sub(scroll.min(max))
    } else {
        scroll.min(max)
    };
    frame.render_widget(
        paragraph.scroll((offset.min(u16::MAX as usize) as u16, 0)),
        area,
    );
}

fn tools(frame: &mut Frame<'_>, area: Rect, view: &View<'_>) {
    let list = &view.screen.tools;
    let mut lines = Vec::new();
    if let Some(tool) = list.entries.get(list.selected) {
        let state = match tool.state {
            State::Running => "…",
            State::Done => "✓",
            State::Failed => "✗",
        };
        lines.push(Line::raw(format!("{state} {}", tool.name)));
        lines.extend(
            tool.summary
                .lines()
                .take(128)
                .map(|line| Line::raw(line.to_string())),
        );
        let limit = if tool.folded { 40 } else { 8192 };
        for line in tool.diff.lines().take(limit) {
            let style = if !view.color {
                Style::default()
            } else if line.starts_with('+') {
                Style::default().fg(Color::Green)
            } else if line.starts_with('-') {
                Style::default().fg(Color::Red)
            } else {
                Style::default()
            };
            lines.push(Line::styled(line.to_string(), style));
        }
        if tool.folded && tool.diff.lines().count() > 40 {
            lines.push(Line::raw(format!(
                "… {} {} · Ctrl+F",
                tool.diff.lines().count() - 40,
                view.lang.text("more lines", "weitere Zeilen")
            )));
        }
        if tool.truncated {
            lines.push(Line::raw(
                view.lang.text("Preview truncated", "Vorschau gekürzt"),
            ));
        }
    } else {
        lines.push(Line::raw(
            view.lang
                .text("No tool calls yet", "Noch keine Werkzeugaufrufe"),
        ));
    }
    let title = format!(
        "{} {}/{} · Alt+↑/↓",
        view.lang.text("Tools", "Werkzeuge"),
        if list.entries.is_empty() {
            0
        } else {
            list.selected + 1
        },
        list.entries.len()
    );
    panel(
        frame,
        area,
        &title,
        Text::from(lines),
        view.screen.tool_scroll,
        false,
        view.color,
    );
}

fn popup(area: Rect) -> Rect {
    let width = area.width.saturating_sub(2).min(90);
    let height = area.height.min(16);
    Rect::new(
        area.x + (area.width - width) / 2,
        area.y + (area.height - height) / 2,
        width,
        height,
    )
}

fn question(frame: &mut Frame<'_>, area: Rect, view: &View<'_>) -> bool {
    let area = popup(area);
    if area.width < 24 || area.height < 7 {
        frame.render_widget(
            Paragraph::new(view.lang.text(
                "Resize to review the request; Esc denies",
                "Für die Anfrage vergrößern; Esc lehnt ab",
            )),
            area,
        );
        return false;
    }
    frame.render_widget(Clear, area);
    let approval = view
        .prompt
        .question_id
        .as_deref()
        .is_some_and(|id| id.starts_with("approval:"));
    let title = if approval {
        view.lang.text("Approval", "Freigabe")
    } else {
        view.lang.text("Confirmation", "Bestätigung")
    };
    frame.render_widget(Block::default().borders(Borders::ALL).title(title), area);
    let body = Rect::new(area.x + 1, area.y + 1, area.width - 2, area.height - 5);
    let para = Paragraph::new(visible(&view.prompt.question_context)).wrap(Wrap { trim: false });
    let max = para
        .line_count(body.width)
        .saturating_sub(body.height as usize);
    frame.render_widget(
        para.scroll((
            view.question_scroll.min(max).min(u16::MAX as usize) as u16,
            0,
        )),
        body,
    );
    frame.render_widget(
        Paragraph::new(visible(&view.prompt.question)),
        Rect::new(area.x + 1, area.bottom() - 4, area.width - 2, 1),
    );
    frame.render_widget(
        Paragraph::new(format!("› {}", visible(view.answer))),
        Rect::new(area.x + 1, area.bottom() - 3, area.width - 2, 1),
    );
    frame.render_widget(
        Paragraph::new(
            view.lang
                .text("Enter confirms · Esc: no", "Enter bestätigt · Esc: nein"),
        ),
        Rect::new(area.x + 1, area.bottom() - 2, area.width - 2, 1),
    );
    let column = Line::raw(visible(view.answer))
        .width()
        .min(area.width.saturating_sub(5) as usize);
    frame.set_cursor_position((area.x + 3 + column as u16, area.bottom() - 3));
    true
}

fn help(frame: &mut Frame<'_>, area: Rect, view: &View<'_>) {
    let area = popup(area);
    frame.render_widget(Clear, area);
    let text = view.lang.text(
        concat!(
            "Enter submits / steers\n",
            "Alt+Enter or Esc then Enter queues\n",
            "Tab selects transcript / tools\n",
            "PgUp / PgDn scroll the selected pane\n",
            "Alt+Up / Alt+Down select a tool\n",
            "Ctrl+F folds its diff\n",
            "Ctrl+C cancels; twice exits\n",
            "Ctrl+D exits when idle\n",
            "F1 closes this help\n",
            "F2 shows the queue (PgUp/PgDn scroll)\n",
            "/queue and /unqueue <n> manage queued input"
        ),
        concat!(
            "Enter sendet / steuert\n",
            "Alt+Enter oder Esc dann Enter stellt an\n",
            "Tab wählt Verlauf / Werkzeuge\n",
            "Bild↑ / Bild↓ blättern im Bereich\n",
            "Alt+↑ / Alt+↓ wählen ein Werkzeug\n",
            "Ctrl+F klappt dessen Diff\n",
            "Ctrl+C bricht ab; zweimal beendet\n",
            "Ctrl+D beendet im Leerlauf\n",
            "F1 schließt diese Hilfe\n",
            "F2 zeigt die Warteschlange (Bild↑/↓ blättern)\n",
            "/queue und /unqueue <n> verwalten Eingaben"
        ),
    );
    panel(
        frame,
        area,
        view.lang.text("Keys", "Tasten"),
        Text::from(text),
        view.question_scroll,
        false,
        view.color,
    );
}

#[cfg(test)]
#[path = "view_tests.rs"]
mod tests;
