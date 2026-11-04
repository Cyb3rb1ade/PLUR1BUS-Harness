//! Reviewed TestBackend frames, locale, viewport and composer regressions.
use super::*;
use ratatui::{backend::TestBackend, Terminal};
use serde_json::json;

fn snapshot(width: u16, height: u16, view: &View<'_>) -> String {
    let mut terminal = Terminal::new(TestBackend::new(width, height)).expect("test terminal");
    terminal
        .draw(|frame| {
            render(frame, view);
        })
        .expect("frame");
    let buffer = terminal.backend().buffer();
    let mut text = String::new();
    for y in 0..height {
        for x in 0..width {
            text.push_str(buffer[(x, y)].symbol());
        }
        // Preserve every blank cell without trailing whitespace in the reviewed fixtures.
        text.push_str("|\n");
    }
    text
}

#[test]
fn a_display_line_limit_marks_older_text_as_omitted_even_below_the_byte_limit() {
    let text = (0..9000)
        .map(|i| format!("entry {i}\n"))
        .collect::<String>();
    let shown = tail(&text, 128 * 1024);
    assert!(shown.starts_with("…\n"), "line truncation must be visible");
    assert!(shown.ends_with("entry 8999"));
    assert!(shown.lines().count() <= 8193);
}

#[test]
fn a_short_help_overlay_can_scroll_to_its_last_commands_in_both_locales() {
    let screen = Screen::default();
    let prompt = PromptState::default();
    let editor = Editor::default();
    for lang in [Language(false), Language(true)] {
        let mut view = View {
            screen: &screen,
            prompt: &prompt,
            editor: &editor,
            lang,
            color: false,
            answer: "",
            overlay: Overlay::Help,
            question_scroll: 0,
        };
        let beginning = snapshot(80, 14, &view);
        assert!(!beginning.contains("/unqueue"), "{beginning}");
        view.question_scroll = usize::MAX;
        let end = snapshot(80, 14, &view);
        assert!(end.contains("/unqueue"), "{end}");
    }
}

#[test]
fn representative_frames_match_reviewed_snapshots() {
    let directory =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/code_tui");
    let update = std::env::var("PLUR1BUS_UPDATE_TUI_SNAPSHOTS").as_deref() == Ok("1");
    for name in [
        "idle-wide",
        "running-narrow",
        "tool-diff",
        "approval-de",
        "queue",
        "queue-expanded",
    ] {
        let mut screen = Screen::default();
        let mut prompt = PromptState {
            header: "agent · main · /repo".into(),
            status: "idle".into(),
            ..Default::default()
        };
        let mut editor = Editor::default();
        let mut lang = Language(false);
        let (mut width, mut height) = (100, 20);
        screen.append("Ready for the next task.");
        match name {
            "running-narrow" => {
                width = 60;
                height = 16;
                prompt.status = "running".into();
                prompt.busy = true;
                prompt.partial = "Inspecting the worktree...\nChecking the current change".into();
                editor.paste("please keep the public interface");
            }
            "tool-diff" => {
                screen
                    .tools
                    .call(&json!({"id":"edit-1","name":"file.edit","args":{"path":"src/main.rs"}}));
                screen.tools.result("edit-1",&json!({"value":{"summary":"Updated the condition","diff":"@@ -1,2 +1,2 @@\n-old\n+new"}}).to_string(),false);
                screen.status.read_model(&json!({"profile":"local-coder"}));
                screen
                    .status
                    .usage(&json!({"usage":{"inputTokens":120,"outputTokens":34}}));
            }
            "approval-de" => {
                lang = Language(true);
                prompt.status = "läuft".into();
                prompt.question_id = Some("approval:request-1".into());
                prompt.question_context =
                    "file.write /repo/src/main.rs\nRisiko: niedrig\n+new condition".into();
                prompt.question = "[y] einmal  [n] nein  [?] Details".into();
                editor.paste("Entwurf bleibt erhalten");
            }
            "queue" | "queue-expanded" => {
                prompt.queue = "1: Run the checks\n2: Review the diff".into();
                prompt.status = "running".into();
            }
            _ => {}
        }
        let view = View {
            screen: &screen,
            prompt: &prompt,
            editor: &editor,
            lang,
            color: false,
            answer: "n",
            overlay: Overlay::None,
            question_scroll: 0,
        };
        let view = if name == "queue-expanded" {
            View {
                overlay: Overlay::Queue,
                ..view
            }
        } else {
            view
        };
        let actual = snapshot(width, height, &view);
        let path = directory.join(format!("{name}.txt"));
        if update {
            std::fs::create_dir_all(&directory).expect("snapshot directory");
            std::fs::write(&path, &actual).expect("write explicit snapshot update");
        }
        let expected = std::fs::read_to_string(&path).expect("reviewed frame snapshot");
        assert_eq!(actual, expected, "{name}");
    }
}

#[test]
fn an_unreadable_small_modal_is_never_reported_as_displayed() {
    let screen = Screen::default();
    let editor = Editor::default();
    let prompt = PromptState {
        question_id: Some("approval:one".into()),
        question: "[y] once [n] no".into(),
        ..Default::default()
    };
    let view = View {
        screen: &screen,
        prompt: &prompt,
        editor: &editor,
        lang: Language(false),
        color: false,
        answer: "y",
        overlay: Overlay::None,
        question_scroll: 0,
    };
    let mut terminal = Terminal::new(TestBackend::new(20, 6)).expect("small terminal");
    let mut shown = true;
    terminal
        .draw(|frame| {
            shown = render(frame, &view);
        })
        .expect("small frame");
    assert!(!shown);
}

#[test]
fn a_long_or_multiline_draft_shows_the_current_cursor_line_and_visible_tail() {
    let screen = Screen::default();
    let prompt = PromptState::default();
    let mut editor = Editor::default();
    editor.restore(&format!("{}VISIBLE-TAIL", "x".repeat(120)));
    let shown = snapshot(
        40,
        12,
        &View {
            screen: &screen,
            prompt: &prompt,
            editor: &editor,
            lang: Language(false),
            color: false,
            answer: "",
            overlay: Overlay::None,
            question_scroll: 0,
        },
    );
    assert!(shown.contains("VISIBLE-TAIL"), "{shown}");
    editor.restore("first draft line\nsecond draft line");
    editor.key(
        crossterm::event::KeyEvent::new(
            crossterm::event::KeyCode::Home,
            crossterm::event::KeyModifiers::NONE,
        ),
        false,
    );
    let shown = snapshot(
        60,
        16,
        &View {
            screen: &screen,
            prompt: &prompt,
            editor: &editor,
            lang: Language(false),
            color: false,
            answer: "",
            overlay: Overlay::None,
            question_scroll: 0,
        },
    );
    assert!(shown.contains("first draft line"), "{shown}");
}

#[test]
fn budget_periods_and_states_use_the_selected_display_locale() {
    let mut screen = Screen::default();
    screen.status.read_budget(&json!({"limits":[{"scope":"global","period":"day","metric":"tokens","soft":100,"hard":200,"used":150,"state":"soft"}]}),"a");
    let prompt = PromptState::default();
    let editor = Editor::default();
    let shown = snapshot(
        160,
        16,
        &View {
            screen: &screen,
            prompt: &prompt,
            editor: &editor,
            lang: Language(true),
            color: false,
            answer: "",
            overlay: Overlay::None,
            question_scroll: 0,
        },
    );
    assert!(
        shown.contains("Tag") && shown.contains("Warnung"),
        "{shown}"
    );
    assert!(shown.contains("150/200"));
}

#[test]
fn frames_present_owned_tool_changes_and_measured_status_values() {
    let mut screen = Screen::default();
    screen.append("A reply with terminal control \u{001b}[2J");
    screen
        .tools
        .call(&json!({"id":"one","name":"file.edit","args":{"path":"src/main.rs"}}));
    screen.tools.result(
        "one",
        &json!({"value":{"summary":"updated","diff":"-old\n+new"}}).to_string(),
        false,
    );
    screen
        .status
        .read_model(&json!({"profile":"coder","defaultProfile":null}));
    screen
        .status
        .usage(&json!({"usage":{"inputTokens":100,"outputTokens":20}}));
    screen.status.read_cache(&json!({"session":{"sessionId":"s","agentId":"a","models":[{"totalInputTokens":100,"cacheReadTokens":50}]}}), "s", "a");
    screen.status.read_budget(&json!({"limits":[]}), "a");
    let prompt = PromptState {
        header: "coder · main · /repo".into(),
        status: "idle".into(),
        ..Default::default()
    };
    let editor = Editor::default();
    let view = View {
        screen: &screen,
        prompt: &prompt,
        editor: &editor,
        lang: Language(false),
        color: false,
        answer: "",
        overlay: Overlay::None,
        question_scroll: 0,
    };
    let shown = snapshot(120, 24, &view);
    for required in [
        "Transcript",
        "Tools",
        "file.edit src/main.rs",
        "-old",
        "+new",
        "coder",
        "100",
        "50.0%",
        "unlimited",
    ] {
        assert!(shown.contains(required), "missing {required}:\n{shown}");
    }
    assert!(!shown.contains('\x1b'));
}

#[test]
fn folded_and_expanded_frames_keep_the_retained_patch_accessible() {
    let mut screen = Screen::default();
    screen.tools.call(&json!({"id":"one","name":"file.edit"}));
    let patch = (0..60)
        .map(|n| format!("+line {n}"))
        .collect::<Vec<_>>()
        .join("\n");
    screen
        .tools
        .result("one", &json!({"value":{"diff":patch}}).to_string(), false);
    let prompt = PromptState::default();
    let editor = Editor::default();
    let view = View {
        screen: &screen,
        prompt: &prompt,
        editor: &editor,
        lang: Language(false),
        color: false,
        answer: "",
        overlay: Overlay::None,
        question_scroll: 0,
    };
    let folded = snapshot(120, 80, &view);
    assert!(folded.contains("+line 39"));
    assert!(!folded.contains("+line 59"));
    screen.tools.entries[0].folded = false;
    let expanded = snapshot(
        120,
        80,
        &View {
            screen: &screen,
            prompt: &prompt,
            editor: &editor,
            lang: Language(false),
            color: false,
            answer: "",
            overlay: Overlay::None,
            question_scroll: 0,
        },
    );
    assert!(expanded.contains("+line 59"));
}

#[test]
fn an_approval_overlay_and_queue_remain_readable_in_both_locales_and_small_frames() {
    for german in [false, true] {
        let lang = Language(german);
        let screen = Screen::default();
        let editor = Editor::default();
        let prompt = PromptState {
            header: "agent · main · /repo".into(),
            status: lang.text("running", "läuft").into(),
            queue: lang.text("1 queued", "1 wartend").into(),
            question_id: Some("approval:one".into()),
            question_context: "file.write /repo/a\nRisk: low\n+preview".into(),
            question: lang.text("[y] once [n] no", "[y] einmal [n] nein").into(),
            ..Default::default()
        };
        let view = View {
            screen: &screen,
            prompt: &prompt,
            editor: &editor,
            lang,
            color: false,
            answer: "n",
            overlay: Overlay::None,
            question_scroll: 0,
        };
        let shown = snapshot(70, 24, &view);
        assert!(shown.contains(lang.text("Approval", "Freigabe")), "{shown}");
        assert!(shown.contains("file.write /repo/a") && shown.contains("+preview"));
        assert!(shown.contains("Enter") && shown.contains(lang.text("1 queued", "1 wartend")));
        for (width, height) in [(0, 0), (1, 1), (20, 6), (40, 12)] {
            let _ = snapshot(width, height, &view);
        }
    }
}
