//! Pure pane allocation. Focus lets a small terminal offer both transcript and tools without a mouse.
use ratatui::layout::{Constraint, Layout, Rect};

/// The keyboard-selected work pane; input and pending questions remain available in either focus.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) enum Focus {
    #[default]
    Transcript,
    Tools,
}

/// Split the work area into transcript and tools; an empty rectangle hides one pane.
/// Wide terminals can retain both contexts; small terminals trade simultaneous context for reading space.
pub(super) fn split_work(area: Rect, focus: Focus) -> (Rect, Rect) {
    if area.width < 90 {
        return match focus {
            Focus::Transcript => (area, Rect::default()),
            Focus::Tools => (Rect::default(), area),
        };
    }
    let columns =
        Layout::horizontal([Constraint::Percentage(60), Constraint::Percentage(40)]).split(area);
    (columns[0], columns[1])
}

/// Fixed chrome is reserved before dividing the remaining work area.
pub(super) struct Panes {
    pub heading: Rect,
    pub transcript: Rect,
    pub tools: Rect,
    pub queue: Rect,
    pub status: Rect,
    pub input: Rect,
}

/// Keep dimensions bounded even while a terminal is resized down to zero cells.
pub(super) fn panes(area: Rect, queued: bool, focus: Focus) -> Panes {
    let rows = Layout::vertical([
        Constraint::Length(1),
        Constraint::Min(0),
        Constraint::Length(if queued { 3 } else { 0 }),
        Constraint::Length(2),
        Constraint::Length(3),
    ])
    .split(area);
    let (transcript, tools) = split_work(rows[1], focus);
    Panes {
        heading: rows[0],
        transcript,
        tools,
        queue: rows[2],
        status: rows[3],
        input: rows[4],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_wide_work_area_shows_both_contexts_without_overlap_or_unused_columns() {
        let area = Rect::new(7, 4, 120, 20);
        let (transcript, tools) = split_work(area, Focus::Transcript);
        assert!(transcript.width > tools.width && tools.width > 0);
        assert_eq!(transcript.x, area.x);
        assert_eq!(tools.right(), area.right());
        assert_eq!(transcript.right(), tools.x);
        assert_eq!(transcript.height, area.height);
        assert_eq!(tools.height, area.height);
    }

    #[test]
    fn a_narrow_work_area_keeps_the_focused_context_readable() {
        let area = Rect::new(2, 3, 40, 10);
        let (transcript, tools) = split_work(area, Focus::Transcript);
        assert_eq!(transcript, area);
        assert_eq!(tools.area(), 0);
        let (transcript, tools) = split_work(area, Focus::Tools);
        assert_eq!(tools, area);
        assert_eq!(transcript.area(), 0);
    }

    #[test]
    fn queued_and_resized_layouts_stay_inside_even_a_zero_sized_terminal() {
        for width in [0, 1, 20, 90, 120] {
            for height in [0, 1, 6, 24] {
                let area = Rect::new(3, 5, width, height);
                for focus in [Focus::Transcript, Focus::Tools] {
                    for queued in [false, true] {
                        let p = panes(area, queued, focus);
                        for rect in [p.heading, p.transcript, p.tools, p.queue, p.status, p.input] {
                            if rect.area() > 0 {
                                assert_eq!(rect.intersection(area), rect);
                            }
                        }
                    }
                }
            }
        }
    }
}
