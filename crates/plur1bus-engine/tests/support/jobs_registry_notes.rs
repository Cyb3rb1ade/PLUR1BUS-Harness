use super::*;
use std::sync::Mutex;
struct NotesProbe {
    mode: &'static str,
    retained: Mutex<Option<JobContext>>,
}
impl JobBody for NotesProbe {
    fn name(&self) -> JobName {
        JobName::KnowledgeUpdate
    }
    fn run(&self, context: &JobContext, cancel: &Cancel) -> Result<JobReport, EngineError> {
        *self.retained.lock().unwrap() = Some(context.clone());
        context.mark_completed_key("done")?;
        assert!(!context.has_completed_key("done")?);
        assert!(context.note_pending_key(&"a".repeat(4097)).is_err());
        assert!(context.note_pending_key(&"😀".repeat(2049)).is_err());
        assert!(context.note_diary(true, Some(&"a".repeat(4097))).is_err());
        context.mark_completed_key("")?;
        match self.mode {
            "concurrent" => {
                let threads: Vec<_> = (0..8)
                    .map(|_| {
                        let copied = context.clone();
                        std::thread::spawn(move || copied.note_pending_key("same"))
                    })
                    .collect();
                for thread in threads {
                    thread.join().unwrap()?;
                }
            }
            "count" => {
                for index in 0..999 {
                    context.note_pending_key(&format!("key-{index}"))?;
                }
                assert!(context.note_pending_key("overflow").is_err());
                context.note_pending_key("key-0")?;
            }
            "bytes" | "escapes" => {
                let mut accepted = 0;
                for index in 0..1000 {
                    let key = format!(
                        "{index:04}{}",
                        if self.mode == "escapes" { "\0" } else { "a" }.repeat(4092)
                    );
                    if context.note_pending_key(&key).is_err() {
                        break;
                    }
                    accepted += 1;
                }
                assert_eq!(accepted, if self.mode == "escapes" { 10 } else { 63 });
            }
            "cancel" => {
                cancel.cancel();
                assert!(context.note_pending_key("late").is_err());
                assert!(context.has_completed_key("done").is_err());
                return Err(plur1bus_engine::contract::StoreError::Unavailable.into());
            }
            _ => {}
        }
        Ok(JobReport::completed())
    }
}
#[test]
fn bounded_run_notes_deduplicate_concurrently_and_seal_retained_contexts() {
    for (mode, pending_count) in [
        ("concurrent", 1),
        ("count", 999),
        ("bytes", 63),
        ("escapes", 10),
        ("cancel", 0),
    ] {
        let root = root();
        let body = Arc::new(NotesProbe {
            mode,
            retained: Mutex::new(None),
        });
        let registry = Registry::new(root.path(), Arc::new(|| 1800000000000)).unwrap();
        registry.bind(body.clone()).unwrap();
        let result = registry.run(
            JobName::KnowledgeUpdate,
            &agent(),
            options(),
            &Cancel::never(),
        );
        assert_eq!(result.is_err(), mode == "cancel", "{mode}: {result:?}");
        let retained = body.retained.lock().unwrap().clone().unwrap();
        assert!(retained.mark_completed_key("too-late").is_err());
        assert!(retained.has_completed_key("done").is_err());
        assert!(retained.disable_diary().is_err());
        assert!(retained.note_diary(true, None).is_err());
        let history = registry
            .history(
                &agent(),
                serde_json::from_value(serde_json::json!({})).unwrap(),
            )
            .unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(
            history[0].keys.as_deref(),
            Some(["done".to_owned()].as_slice())
        );
        assert_eq!(
            history[0].pending_keys.as_ref().map_or(0, Vec::len),
            pending_count
        );
        if mode == "cancel" {
            assert_eq!(history[0].reason.as_deref(), Some("aborted"));
        }
    }
}
