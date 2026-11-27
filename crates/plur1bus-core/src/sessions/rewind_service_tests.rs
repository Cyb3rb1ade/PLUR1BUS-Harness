//! The rewind service and the `/rewind` parser without Git: ports of `rewind-service.test.ts`, the pure parts of
//! `rewind-core.test.ts` and the command-failure checks of `rewind-command-failures.test.ts`, and the file-restore sequence
//! against a stand-in files port. What has a recorded TypeScript answer is replayed in `rewind_vectors.rs`.
#![cfg(test)]
use super::compaction::SummaryMessage;
use super::rewind::{
    is_rewind_command, parse_rewind_command, LessonSummarizer, RestoreInput, RewindCommand,
    RewindFilesPort, RewindRequest, RewindService, RewindServiceDeps,
};
use super::rewind_checkpoints::{ProjectBinding, TurnApprover};
use super::rewind_git::{Cancel, RewindError};
use super::rewind_test_store::{audit_pair, clock, store_with};
use super::{
    CreateSessionInput, EventRecord, EventType, ReasoningChange, RewindTarget, RewindTrigger,
    SessionKind, SessionStore,
};
use crate::approvals::js_json::J;
use crate::rbac::audit::AuditEvent;
use std::cell::{Cell, RefCell};
use std::rc::Rc;

type Seen = Rc<RefCell<Vec<(Vec<SummaryMessage>, i64)>>>;

struct Sum {
    answer: Result<String, String>,
    seen: Seen,
}

impl LessonSummarizer for Sum {
    fn summarize(
        &self,
        messages: &[SummaryMessage],
        max: i64,
        _s: &str,
        _c: Option<&J>,
    ) -> Result<String, String> {
        self.seen.borrow_mut().push((messages.to_vec(), max));
        self.answer.clone()
    }
}

struct Rig {
    store: SessionStore,
    session: String,
    audit: Rc<RefCell<Vec<AuditEvent>>>,
    service: RewindService,
    seen: Seen,
    notified: Rc<RefCell<Vec<String>>>,
    errors: Rc<RefCell<Vec<String>>>,
}

fn rig_with(artifact: J, summarize: Option<Result<String, String>>, kind: SessionKind) -> Rig {
    let mut store = store_with(clock(42));
    let session = store
        .create_session(&CreateSessionInput::new(kind, "a", "owner"))
        .unwrap()
        .id;
    let first = store
        .begin_turn(&session, "inspect the types", 4, &Default::default())
        .unwrap();
    store
        .complete_turn(&first.turn.id, "types inspected", 4, None)
        .unwrap();
    let failed = store
        .begin_turn(&session, "try the edit", 4, &Default::default())
        .unwrap();
    let t = &failed.turn.id;
    let ev = |s: &mut SessionStore, kind: EventType, data: J| {
        s.append_event(t, kind, data).unwrap();
    };
    ev(
        &mut store,
        EventType::ToolCall,
        J::obj([
            ("id", J::s("edit")),
            ("name", J::s("file.write")),
            ("args", J::obj([("path", J::s("src/example.ts"))])),
        ]),
    );
    let ok = J::obj([
        ("isError", J::Bool(false)),
        ("value", J::obj([("written", J::Bool(true))])),
    ])
    .stringify();
    ev(
        &mut store,
        EventType::ToolResult,
        J::obj([("id", J::s("edit")), ("output", J::s(&ok))]),
    );
    ev(
        &mut store,
        EventType::ToolCall,
        J::obj([
            ("id", J::s("check")),
            ("name", J::s("exec.run")),
            (
                "args",
                J::obj([("argv", J::Arr(vec![J::s("node"), J::s("--test")]))]),
            ),
        ]),
    );
    let result = J::obj([
        ("isError", J::Bool(false)),
        (
            "value",
            J::obj([
                ("exitCode", J::Num(1.0)),
                (
                    "stdout",
                    J::s("FAIL type contract\nARTIFACT_BODY_MUST_NOT_REACH_SUMMARIZE"),
                ),
                ("stderr", J::s("")),
                (
                    "artifact",
                    J::obj([("id", artifact), ("bytes", J::Num(1_000_000.0))]),
                ),
                ("essence", J::s("FAIL type contract")),
            ]),
        ),
    ])
    .stringify();
    ev(
        &mut store,
        EventType::ToolResult,
        J::obj([("id", J::s("check")), ("output", J::s(&result))]),
    );
    store
        .complete_turn(&failed.turn.id, "the test failed", 4, None)
        .unwrap();
    let (audit, events) = audit_pair();
    let seen: Seen = Rc::new(RefCell::new(Vec::new()));
    let notified = Rc::new(RefCell::new(Vec::new()));
    let errors = Rc::new(RefCell::new(Vec::new()));
    let (n2, e2) = (notified.clone(), errors.clone());
    let service = RewindService::new(RewindServiceDeps {
        audit,
        clock: clock(42),
        summarize: summarize.map(|answer| {
            Box::new(Sum {
                answer,
                seen: seen.clone(),
            }) as Box<dyn LessonSummarizer>
        }),
        files: None,
        signal: None,
        notify: Some(Box::new(move |e: &EventRecord| {
            n2.borrow_mut().push(e.kind.clone());
            Ok(())
        })),
        on_error: Some(Box::new(move |m: &str| e2.borrow_mut().push(m.to_owned()))),
        project: None,
        auto_projects: None,
    });
    Rig {
        store,
        session,
        audit: events,
        service,
        seen,
        notified,
        errors,
    }
}

fn rig(summarize: Option<Result<String, String>>) -> Rig {
    rig_with(J::s("artifact-a"), summarize, SessionKind::Direct)
}

fn rewind(r: &mut Rig, to: i64, lesson: Option<&str>) -> Result<super::RewindRecord, RewindError> {
    let mut q = RewindRequest::new(&r.session, RewindTarget::Seq(to), "owner");
    q.lesson = lesson.map(str::to_owned);
    r.service.rewind(&mut r.store, q)
}

fn last_text(r: &Rig) -> String {
    r.store
        .context_messages(&r.session, None)
        .unwrap()
        .last()
        .unwrap()
        .text
        .clone()
}

fn units(s: &str) -> usize {
    s.encode_utf16().count()
}

#[test]
fn a_human_note_of_1567_characters_is_kept_verbatim_even_when_the_attempt_changed_files() {
    let mut r = rig(Some(Err("a human note must not call a model".into())));
    let note = format!(" {} ", "N".repeat(1565));
    rewind(&mut r, 2, Some(&note)).unwrap();
    assert_eq!(
        last_text(&r),
        format!("Lesson from a discarded attempt: {note}")
    );
    assert!(
        !format!("{:?}", r.audit.borrow()).contains("NNNN"),
        "the audit carries no note text"
    );
    assert!(r.seen.borrow().is_empty());
}

#[test]
fn an_oversized_or_blank_note_is_refused_and_nothing_is_written() {
    for note in ["N".repeat(1568), "   ".to_owned(), String::new()] {
        let mut r = rig(None);
        let before = r
            .store
            .list_messages(&r.session, &Default::default())
            .unwrap();
        let e = rewind(&mut r, 2, Some(&note)).unwrap_err();
        assert_eq!(e.reason(), Some("rewind-lesson"));
        assert_eq!(
            r.store
                .list_messages(&r.session, &Default::default())
                .unwrap(),
            before
        );
        assert!(r.audit.borrow().is_empty());
    }
}

#[test]
fn clipping_model_output_or_file_context_never_splits_a_surrogate_pair() {
    for leading in ["", "x"] {
        let mut r = rig(Some(Ok(format!("{leading}{}", "\u{1F600}".repeat(2000)))));
        rewind(&mut r, 2, None).unwrap();
        let text = last_text(&r);
        assert!(
            !text.contains('\u{FFFD}'),
            "storage must not have to replace a surrogate cut in half"
        );
        assert!(units(&text) <= 1600);
    }
}

#[test]
fn an_artifact_body_disguised_as_an_identifier_is_not_passed_on() {
    let ids = [
        J::obj([("body", J::s("MISLABELED_ARTIFACT_BODY"))]),
        J::s(&"x".repeat(10_000)),
        J::s(""),
    ];
    for id in ids {
        let mut r = rig_with(
            id,
            Some(Ok("Validate the types first.".into())),
            SessionKind::Direct,
        );
        rewind(&mut r, 2, None).unwrap();
        let input: String = r.seen.borrow()[0]
            .0
            .iter()
            .map(|m| m.text.clone())
            .collect();
        assert!(!input.contains("MISLABELED_ARTIFACT_BODY") && !input.contains(&"x".repeat(257)));
        assert!(
            !input.contains("\"artifact\""),
            "an id that is not a string of 1 to 256 characters is dropped"
        );
    }
}

#[test]
fn an_artifact_id_of_a_reasonable_size_is_kept() {
    let mut r = rig(Some(Ok("Validate the types first.".into())));
    rewind(&mut r, 2, None).unwrap();
    let input: String = r.seen.borrow()[0]
        .0
        .iter()
        .map(|m| m.text.clone())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        input.contains(r#""artifact":{"id":"artifact-a"}"#),
        "{input}"
    );
}

#[test]
fn an_already_discarded_partial_turn_and_its_metadata_stay_out_of_a_later_lesson() {
    let mut r = rig(Some(Ok("Try another approach.".into())));
    rewind(&mut r, 3, Some("Inspect the interface.")).unwrap();
    assert!(r.store.context_tool_events(&r.session).unwrap().is_empty());
    rewind(&mut r, 2, None).unwrap();
    let input = r.seen.borrow()[0].0.clone();
    let text: String = input.iter().map(|m| m.text.clone()).collect();
    assert!(!text.contains("artifact-a") && !text.contains("FAIL type contract"));
    assert!(!input
        .iter()
        .any(|m| m.role == super::MessageRole::Assistant && m.seq == 4));
}

#[test]
fn a_persons_note_is_used_directly_with_a_content_free_audit_carrying_the_hidden_digest() {
    let mut r = rig(Some(Err("an explicit note must not invoke a model".into())));
    let rewound = rewind(&mut r, 2, Some("Check the interface first.")).unwrap();
    assert_eq!(
        last_text(&r),
        "Lesson from a discarded attempt: Files changed: src/example.ts. Check the interface first."
    );
    let events = r.audit.borrow().clone();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].action, "session.rewind");
    assert_eq!(
        (
            events[0].user.as_str(),
            events[0].host.as_str(),
            events[0].at
        ),
        ("owner", "core", 42)
    );
    let digest = events[0]
        .detail
        .iter()
        .find(|(k, _)| k == "hiddenDigest")
        .unwrap()
        .1
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(digest, rewound.hidden_digest);
    let dump = format!("{events:?}");
    for secret in ["Check the interface", "try the edit", "ARTIFACT_BODY"] {
        assert!(!dump.contains(secret));
    }
    let keys: Vec<&str> = events[0].detail.iter().map(|(k, _)| k.as_str()).collect();
    assert_eq!(
        keys,
        [
            "sessionId",
            "rewindId",
            "parentSeq",
            "hiddenFrom",
            "hiddenTo",
            "trigger",
            "actor",
            "hiddenDigest"
        ]
    );
    r.service
        .undo(&mut r.store, &r.session, &rewound.id, "owner", None)
        .unwrap();
    assert_eq!(
        r.audit.borrow().last().unwrap().action,
        "session.rewind.undone"
    );
    assert_eq!(
        *r.notified.borrow(),
        ["session.rewind", "session.rewind.undone"]
    );
}

#[test]
fn the_lesson_goes_through_the_summarise_port_with_a_400_token_cap_and_tool_envelopes_not_artifact_bodies(
) {
    let mut r = rig(Some(Ok("Inspect types before writing.".into())));
    rewind(&mut r, 2, None).unwrap();
    let (messages, cap) = r.seen.borrow()[0].clone();
    assert!(cap <= 400);
    let text: String = messages
        .iter()
        .map(|m| m.text.clone())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(text.contains("src/example.ts") && text.contains("FAIL type contract"));
    assert!(!text.contains("ARTIFACT_BODY_MUST_NOT_REACH_SUMMARIZE"));
    assert!(last_text(&r).contains("Inspect types before writing"));
    let last = messages.last().unwrap();
    assert_eq!((last.role, last.seq), (super::MessageRole::System, 4));
    assert_eq!(
        last.text,
        "Rewind facts: Files changed: src/example.ts. FAIL type contract"
    );
}

#[test]
fn without_a_model_or_when_the_budget_refuses_the_note_is_deterministic_and_bounded() {
    for answer in [None, Some(Err("budget_exceeded".to_owned()))] {
        let unavailable = answer.is_none();
        let mut r = rig(answer);
        rewind(&mut r, 2, None).unwrap();
        let note = last_text(&r);
        assert!(
            note.contains("Files changed: src/example.ts") && note.contains("FAIL type contract")
        );
        assert!(units(&note) <= 1600 && !note.contains("ARTIFACT_BODY"));
        assert_eq!(
            r.errors.borrow().len(),
            usize::from(!unavailable),
            "a refused budget is reported, a missing role is not"
        );
    }
}

#[test]
fn the_whole_harness_note_including_its_prefix_is_bounded_for_oversized_model_output() {
    let mut r = rig(Some(Ok("x".repeat(20_000))));
    rewind(&mut r, 2, None).unwrap();
    assert!(units(&last_text(&r)) <= 1600);
}

#[test]
fn a_blank_model_answer_falls_back_to_the_deterministic_note() {
    let mut r = rig(Some(Ok("   \n".into())));
    rewind(&mut r, 2, None).unwrap();
    assert!(last_text(&r).contains("Files changed: src/example.ts. FAIL type contract"));
}

#[test]
fn a_person_note_gets_the_file_context_only_in_the_room_that_is_left() {
    // 1567 - 1500 - 1 = 66 units of room: the whole file note (30) fits.
    let mut r = rig(None);
    let note = "n".repeat(1500);
    rewind(&mut r, 2, Some(&note)).unwrap();
    assert_eq!(
        last_text(&r),
        format!("Lesson from a discarded attempt: Files changed: src/example.ts. {note}")
    );
    // Room 10 is less than the file note and less than the 16 units of a shortened one: no notice at all.
    let mut r = rig(None);
    let note = "n".repeat(1556);
    rewind(&mut r, 2, Some(&note)).unwrap();
    assert_eq!(
        last_text(&r),
        format!("Lesson from a discarded attempt: {note}")
    );
    // Room 20: shortened to 19 units and an ellipsis.
    let mut r = rig(None);
    let note = "n".repeat(1546);
    rewind(&mut r, 2, Some(&note)).unwrap();
    assert_eq!(
        last_text(&r),
        format!("Lesson from a discarded attempt: Files changed: src/… {note}")
    );
}

#[test]
fn rewind_with_files_reserves_the_path_restores_first_and_writes_the_overlay_last() {
    struct Stub(Rc<RefCell<Vec<String>>>, Rc<Cell<Option<bool>>>);
    impl RewindFilesPort for Stub {
        fn restore(
            &self,
            store: &mut SessionStore,
            input: RestoreInput<'_>,
        ) -> Result<(), RewindError> {
            self.0.borrow_mut().push(format!(
                "restore turn={} parent={}",
                input.checkpoint_turn_id, input.parent_seq
            ));
            self.1.set(Some(store.rewind_reserved(&input.session_id)));
            // The overlay is not there yet while the restore runs.
            assert!(store.rewinds(&input.session_id).unwrap().is_empty());
            (input.validate)(store)
        }
    }
    let mut r = rig(None);
    let (log, reserved) = (Rc::new(RefCell::new(Vec::new())), Rc::new(Cell::new(None)));
    r.service = with_files(&r, Rc::new(Stub(log.clone(), reserved.clone())));
    let failed_turn = r.store.list_turns(&r.session).unwrap()[1].id.clone();
    let mut q = RewindRequest::new(&r.session, RewindTarget::Seq(2), "owner");
    q.files = true;
    q.approver = Some(TurnApprover {
        person: Some("owner".into()),
        surface: 2,
    });
    q.lesson = Some("note".into());
    r.service.rewind(&mut r.store, q).unwrap();
    assert_eq!(
        *log.borrow(),
        [format!("restore turn={failed_turn} parent=2")]
    );
    assert_eq!(
        reserved.get(),
        Some(true),
        "the path is reserved while the restore waits"
    );
    assert!(
        !r.store.rewind_reserved(&r.session),
        "and released afterwards"
    );
    assert_eq!(r.store.rewinds(&r.session).unwrap().len(), 1);
}

fn with_files(r: &Rig, files: Rc<dyn RewindFilesPort>) -> RewindService {
    let _ = r;
    let (audit, _events) = audit_pair();
    // The audit sink of the rig is the one its `audit` list reads; a files test reads the store instead.
    RewindService::new(RewindServiceDeps {
        audit,
        clock: clock(42),
        summarize: None,
        files: Some(files),
        signal: None,
        notify: None,
        on_error: None,
        project: None,
        auto_projects: None,
    })
}

#[test]
fn a_failed_file_restore_leaves_the_transcript_and_releases_the_reservation() {
    struct Fail;
    impl RewindFilesPort for Fail {
        fn restore(&self, _s: &mut SessionStore, _i: RestoreInput<'_>) -> Result<(), RewindError> {
            Err(super::SessionError::new(
                super::ErrorCode::Immutable,
                "file restore was not approved",
                Some("rewind-files-not-approved"),
            )
            .into())
        }
    }
    let mut r = rig(None);
    r.service = with_files(&r, Rc::new(Fail));
    let before = r
        .store
        .list_messages(&r.session, &Default::default())
        .unwrap();
    let mut q = RewindRequest::new(&r.session, RewindTarget::Seq(2), "owner");
    q.files = true;
    q.approver = Some(TurnApprover {
        person: Some("owner".into()),
        surface: 2,
    });
    let e = r.service.rewind(&mut r.store, q).unwrap_err();
    assert_eq!(e.reason(), Some("rewind-files-not-approved"));
    assert_eq!(
        r.store
            .list_messages(&r.session, &Default::default())
            .unwrap(),
        before
    );
    assert!(!r.store.rewind_reserved(&r.session));
    assert!(r.store.rewinds(&r.session).unwrap().is_empty());
}

#[test]
fn files_need_a_port_a_person_and_an_ordinary_turn_to_restore_from() {
    struct Never;
    impl RewindFilesPort for Never {
        fn restore(&self, _s: &mut SessionStore, _i: RestoreInput<'_>) -> Result<(), RewindError> {
            panic!("must not be reached");
        }
    }
    let ask = |r: &mut Rig, approver: Option<TurnApprover>| {
        let mut q = RewindRequest::new(&r.session, RewindTarget::Seq(2), "owner");
        q.files = true;
        q.approver = approver;
        r.service
            .rewind(&mut r.store, q)
            .unwrap_err()
            .reason()
            .map(str::to_owned)
    };
    // No port at all.
    let mut r = rig(None);
    assert_eq!(
        ask(
            &mut r,
            Some(TurnApprover {
                person: Some("owner".into()),
                surface: 2
            })
        )
        .as_deref(),
        Some("rewind-checkpoint-unavailable")
    );
    // A port but no person, or an empty one.
    let mut r = rig(None);
    r.service = with_files(&r, Rc::new(Never));
    assert_eq!(
        ask(&mut r, None).as_deref(),
        Some("rewind-checkpoint-unavailable")
    );
    assert_eq!(
        ask(
            &mut r,
            Some(TurnApprover {
                person: Some(String::new()),
                surface: 2
            })
        )
        .as_deref(),
        Some("rewind-checkpoint-unavailable")
    );
    assert!(
        !r.store.rewind_reserved(&r.session),
        "refused before anything was reserved"
    );
}

#[test]
fn a_session_that_changes_while_the_file_restore_waits_refuses_the_stale_plan() {
    struct Bump;
    impl RewindFilesPort for Bump {
        fn restore(
            &self,
            store: &mut SessionStore,
            input: RestoreInput<'_>,
        ) -> Result<(), RewindError> {
            // Anything that appends an event moves the revision the plan was made at.
            store.set_model_profile(
                &input.session_id,
                "other",
                0,
                &ReasoningChange::Keep,
                None,
                None,
            )?;
            (input.validate)(store)
        }
    }
    let mut r = rig(None);
    r.service = with_files(&r, Rc::new(Bump));
    let mut q = RewindRequest::new(&r.session, RewindTarget::Seq(2), "owner");
    q.files = true;
    q.approver = Some(TurnApprover {
        person: Some("owner".into()),
        surface: 2,
    });
    let e = r.service.rewind(&mut r.store, q).unwrap_err();
    assert_eq!(e.reason(), Some("rewind-stale"));
    assert!(r.store.rewinds(&r.session).unwrap().is_empty());
    assert!(!r.store.rewind_reserved(&r.session));
}

#[test]
fn an_aborted_signal_stops_the_rewind_before_anything_is_written() {
    let mut r = rig(None);
    let cancel = Cancel::new();
    cancel.abort(super::rewind_git::AbortReason::Caller);
    let mut q = RewindRequest::new(&r.session, RewindTarget::Seq(2), "owner");
    q.signal = Some(cancel);
    assert!(matches!(
        r.service.rewind(&mut r.store, q),
        Err(RewindError::Aborted(_))
    ));
    assert!(r.store.rewinds(&r.session).unwrap().is_empty());
    let mut q = RewindRequest::new(&r.session, RewindTarget::Seq(2), "owner");
    q.validate = Some(Box::new(|| {
        Err(super::SessionError::conflict("no", "rewind-project-changed").into())
    }));
    assert_eq!(
        r.service.rewind(&mut r.store, q).unwrap_err().reason(),
        Some("rewind-project-changed")
    );
    assert!(r.store.rewinds(&r.session).unwrap().is_empty());
}

#[test]
fn an_audit_sink_that_refuses_rolls_the_whole_rewind_back() {
    let mut r = rig(None);
    let sink: Box<dyn crate::rbac::audit::AuditSink> =
        Box::new(|_: &AuditEvent| Err("sink down".to_owned()));
    let service = RewindService::new(RewindServiceDeps {
        audit: Rc::new(RefCell::new(sink)),
        clock: clock(42),
        summarize: None,
        files: None,
        signal: None,
        notify: None,
        on_error: None,
        project: None,
        auto_projects: None,
    });
    let before = r
        .store
        .list_messages(&r.session, &Default::default())
        .unwrap();
    let q = RewindRequest::new(&r.session, RewindTarget::Seq(2), "owner");
    assert!(service.rewind(&mut r.store, q).is_err());
    assert_eq!(
        r.store
            .list_messages(&r.session, &Default::default())
            .unwrap(),
        before,
        "no lesson without its audit line"
    );
    assert!(r.store.rewinds(&r.session).unwrap().is_empty());
}

// ---- after a turn ------------------------------------------------------------------------------------------------------

fn failing_cycles(kind: SessionKind, cycles: usize) -> Rig {
    let mut r = rig_with(J::s("artifact-a"), None, kind);
    // Replace the rig's two turns' cycle by `cycles` fresh edit-then-failing-check turns.
    for i in 0..cycles {
        let turn = r
            .store
            .begin_turn(&r.session, &format!("attempt {i}"), 4, &Default::default())
            .unwrap();
        let t = turn.turn.id.clone();
        let call = |id: &str, name: &str, args: J| {
            J::obj([("id", J::s(id)), ("name", J::s(name)), ("args", args)])
        };
        let out = |id: &str, v: J| {
            J::obj([
                ("id", J::s(id)),
                (
                    "output",
                    J::s(&J::obj([("isError", J::Bool(false)), ("value", v)]).stringify()),
                ),
            ])
        };
        let (w, c) = (format!("w{i}"), format!("c{i}"));
        r.store
            .append_event(
                &t,
                EventType::ToolCall,
                call(&w, "file.write", J::obj([("path", J::s("f.ts"))])),
            )
            .unwrap();
        r.store
            .append_event(
                &t,
                EventType::ToolResult,
                out(&w, J::obj([("written", J::Bool(true))])),
            )
            .unwrap();
        r.store
            .append_event(
                &t,
                EventType::ToolCall,
                call(
                    &c,
                    "exec.run",
                    J::obj([("argv", J::Arr(vec![J::s("node"), J::s("--test")]))]),
                ),
            )
            .unwrap();
        r.store
            .append_event(
                &t,
                EventType::ToolResult,
                out(&c, J::obj([("exitCode", J::Num(1.0))])),
            )
            .unwrap();
        r.store.complete_turn(&t, "failed", 4, None).unwrap();
    }
    r
}

#[test]
fn three_failed_edit_cycles_propose_a_rewind_once_per_observed_check() {
    let mut r = failing_cycles(SessionKind::Direct, 3);
    r.service
        .after_turn(&mut r.store, &r.session, "owner", true)
        .unwrap();
    assert_eq!(*r.notified.borrow(), ["session.rewind.proposed"]);
    let proposal = r.store.rewind_proposal(&r.session).unwrap().unwrap();
    // The first failing attempt is the rig's own "try the edit" turn (it also edited and then failed its check): the
    // proposal rewinds to the message before it.
    assert_eq!(proposal.agent_id, "a");
    assert!(proposal.failed_cycles >= 3);
    r.service
        .after_turn(&mut r.store, &r.session, "owner", true)
        .unwrap();
    assert_eq!(
        r.notified.borrow().len(),
        1,
        "no second proposal for the same check"
    );
    assert!(
        r.store.rewinds(&r.session).unwrap().is_empty(),
        "a proposal is not a rewind"
    );
}

#[test]
fn fewer_than_three_failed_cycles_or_a_running_turn_propose_nothing() {
    let mut r = failing_cycles(SessionKind::Direct, 1);
    r.service
        .after_turn(&mut r.store, &r.session, "owner", true)
        .unwrap();
    assert!(
        r.notified.borrow().is_empty(),
        "the rig's own failed attempt plus one is two cycles"
    );
    let mut r = failing_cycles(SessionKind::Direct, 3);
    r.store
        .begin_turn(&r.session, "running", 1, &Default::default())
        .unwrap();
    r.service
        .after_turn(&mut r.store, &r.session, "owner", true)
        .unwrap();
    assert!(
        r.notified.borrow().is_empty(),
        "a running turn is never interrupted"
    );
}

#[test]
fn an_opted_in_unattended_card_session_is_rewound_by_the_agent_and_a_changed_binding_refuses() {
    let binding = Rc::new(RefCell::new(ProjectBinding {
        project_id: "p".into(),
        card_id: "c".into(),
        root: "/w".into(),
    }));
    let auto = Rc::new(RefCell::new(vec!["p".to_owned()]));
    let mut r = failing_cycles(SessionKind::Card, 3);
    let (b2, a2, a3) = (binding.clone(), auto.clone(), auto.clone());
    let (audit, events) = audit_pair();
    r.service = RewindService::new(RewindServiceDeps {
        audit,
        clock: clock(42),
        summarize: None,
        files: None,
        signal: None,
        notify: None,
        on_error: None,
        project: Some(Box::new(move |_, _| Some(b2.borrow().clone()))),
        auto_projects: Some(Box::new(move || a2.borrow().clone())),
    });
    // Attended: only a proposal.
    r.service
        .after_turn(&mut r.store, &r.session, "owner", false)
        .unwrap();
    assert!(r.store.rewinds(&r.session).unwrap().is_empty());
    assert!(r.store.rewind_proposal(&r.session).unwrap().is_some());
    // Unattended but the project is not opted in: still only a proposal.
    a3.borrow_mut().clear();
    r.service
        .after_turn(&mut r.store, &r.session, "owner", true)
        .unwrap();
    assert!(r.store.rewinds(&r.session).unwrap().is_empty());
    *a3.borrow_mut() = vec!["p".into()];
    r.service
        .after_turn(&mut r.store, &r.session, "owner", true)
        .unwrap();
    let rewinds = r.store.rewinds(&r.session).unwrap();
    assert_eq!(rewinds.len(), 1);
    assert_eq!(
        (rewinds[0].actor.as_str(), rewinds[0].trigger),
        ("agent:a", RewindTrigger::Agent)
    );
    assert_eq!(events.borrow()[0].user, "agent:a");
}

#[test]
fn a_project_binding_that_changes_before_the_automatic_rewind_commits_refuses_it() {
    // The validator runs between the plan and the commit; the binding moves in the project lookup it makes.
    let moved = Rc::new(Cell::new(false));
    let calls = Rc::new(Cell::new(0));
    let (m2, c2) = (moved.clone(), calls.clone());
    let mut r = failing_cycles(SessionKind::Card, 3);
    let (audit, _e) = audit_pair();
    r.service = RewindService::new(RewindServiceDeps {
        audit,
        clock: clock(42),
        summarize: None,
        files: None,
        signal: None,
        notify: None,
        on_error: None,
        project: Some(Box::new(move |_, _| {
            c2.set(c2.get() + 1);
            // The first lookup is the sensor's; the second is the validator's.
            let root = if c2.get() >= 2 && m2.get() {
                "/elsewhere"
            } else {
                "/w"
            };
            Some(ProjectBinding {
                project_id: "p".into(),
                card_id: "c".into(),
                root: root.into(),
            })
        })),
        auto_projects: Some(Box::new(|| vec!["p".to_owned()])),
    });
    moved.set(true);
    let e = r
        .service
        .after_turn(&mut r.store, &r.session, "owner", true)
        .unwrap_err();
    assert_eq!(e.reason(), Some("rewind-project-changed"));
    assert!(r.store.rewinds(&r.session).unwrap().is_empty());
    assert_eq!(calls.get(), 2);
}

// ---- the transcript command --------------------------------------------------------------------------------------------

fn p(text: &str) -> Option<RewindCommand> {
    parse_rewind_command(text).unwrap()
}

#[test]
fn the_command_parses_last_a_kept_sequence_a_quoted_lesson_files_and_undo_without_a_shell() {
    use RewindTarget::{Last, Seq};
    assert_eq!(
        p("/rewind"),
        Some(RewindCommand::Rewind {
            to: Last,
            lesson: None,
            files: false
        })
    );
    assert_eq!(
        p("/rewind 12 --lesson \"Keep the API stable\" --files"),
        Some(RewindCommand::Rewind {
            to: Seq(12),
            lesson: Some("Keep the API stable".into()),
            files: true
        })
    );
    assert_eq!(
        p("/rewind --undo rew_123"),
        Some(RewindCommand::Undo("rew_123".into()))
    );
    assert_eq!(p("please /rewind 12"), None);
    assert_eq!(p("/rewinding"), None);
    assert_eq!(
        p("  /rewind last  "),
        Some(RewindCommand::Rewind {
            to: Last,
            lesson: None,
            files: false
        })
    );
    assert_eq!(
        p("/rewind\t007"),
        Some(RewindCommand::Rewind {
            to: Seq(7),
            lesson: None,
            files: false
        })
    );
    assert_eq!(
        p(r#"/rewind --lesson 'it''s \"fine\"' "#),
        Some(RewindCommand::Rewind {
            to: Last,
            lesson: Some("its \\\"fine\\\"".into()),
            files: false
        })
    );
    assert_eq!(
        p(r#"/rewind --lesson "a \"b\" $(rm -rf /) `x`""#),
        Some(RewindCommand::Rewind {
            to: Last,
            lesson: Some("a \"b\" $(rm -rf /) `x`".into()),
            files: false
        }),
        "data only: nothing is expanded"
    );
}

#[test]
fn the_command_refuses_ambiguous_flags_unsafe_numbers_and_incomplete_quotes() {
    for bad in [
        "/rewind -1",
        "/rewind 9007199254740992",
        "/rewind 1 2",
        "/rewind --lesson",
        "/rewind --lesson 'unterminated",
        "/rewind --undo rew_1 --files",
        "/rewind --unknown",
        "/rewind --files --files",
        "/rewind --lesson a --lesson b",
        "/rewind --lesson \"   \"",
        "/rewind --undo",
        "/rewind --undo bad/id",
        "/rewind --undo a b",
        "/rewind 1 \\",
        "/rewind 1.5",
    ] {
        let e = parse_rewind_command(bad).unwrap_err();
        assert_eq!(e.reason.as_deref(), Some("rewind-command"), "{bad}");
    }
    let long = format!("/rewind --lesson {}", "n".repeat(1568));
    assert!(parse_rewind_command(&long).is_err());
    let ok = format!("/rewind --lesson {}", "n".repeat(1567));
    assert!(parse_rewind_command(&ok).unwrap().is_some());
    assert_eq!(
        p("/rewind 9007199254740991"),
        Some(RewindCommand::Rewind {
            to: RewindTarget::Seq(9_007_199_254_740_991),
            lesson: None,
            files: false
        })
    );
    assert!(
        is_rewind_command("/rewind")
            && is_rewind_command(" /rewind\n1")
            && !is_rewind_command("/rewind1")
    );
}
