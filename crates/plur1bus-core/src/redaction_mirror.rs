//! The front door's mirror of the legacy core's redaction registry (P4-20 flip A, `docs/phase4/bridge.md`).
//!
//! Two processes write log lines, and the front door answers `logs.query` itself: both have to mask the same values. The
//! legacy core holds the registry (the secret store's values, configuration values, tokens from logins). The front door
//! asks for its changes with `legacy.redaction.changes` on the control link and keeps them in its own
//! [`SecretSet`], which its log writer and its log methods mask with.
//!
//! - **Start.** After the control link is up and before the front door listens, it asks until nothing is waiting
//!   ([`RedactionMirror::catch_up`]): no client is served before the set is there.
//! - **Afterwards** a thread keeps asking in a long poll ([`RedactionMirror::follow`]). An answer that brought nothing
//!   and came at once is followed by a short rest, so that a legacy core that does not wait is not asked in a loop.
//!
//! The legacy core is trusted with the values, not with being right: numbers beyond the schema's bound are refused, an
//! answer that claims more is waiting without bringing anything is not chased, and a late answer of another epoch is
//! dropped.
//! - **Before a native read** the caller catches up once more, so that the answer is masked with everything the legacy
//!   core knows at that moment, as its own answer would be.
//!
//! Numbers. Every change has a number within an epoch of the legacy core's journal. The mirror remembers the last number
//! it applied and passes it as `after`, which also lets the legacy core forget up to there. Answers may arrive on two
//! threads (the follower and a catch-up): each is applied under one lock, and a change whose number was already applied
//! is passed over. An answer that does not continue where the mirror stands is not applied; the mirror then asks for a
//! new epoch.
//!
//! The first journal is applied as it arrives. A later epoch replays the legacy core's whole registry, possibly in
//! several answers. Its changes are collected and applied to the set in one step when the replay is complete
//! ([`SecretSet::restate`]). Applied piece by piece, a
//! replay would retire every value its first answer does not name, and with many values those would push the oldest
//! retired ones off the bound until a later answer named them again: values the legacy core masks the whole time
//! would be unmasked here for that long. Until the step the set holds what it held; afterwards it holds what the
//! legacy core holds, and what only the old epoch held is retired behind it (first to leave the bound).
//!
//! What a value is here: the ones a name or a group holds in the legacy core (`pinned`) are one group of the set, so they
//! are never displaced; a value that stopped being held leaves the group and counts among the retired ones (bounded, as
//! in the legacy core); a value that never was held is registered without a name.
//!
//! No value is ever logged or put into an error: failures are short codes.
use crate::logs::redact::{SecretSet, MAX_REGISTERED_SECRETS};
use serde_json::Value;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::{Duration, Instant};

/// The group of the set that holds what the legacy core has pinned.
pub const GROUP: &str = "legacy-core";
/// How long the follower's call waits in the legacy core for a change.
pub const POLL_WAIT_MS: u64 = 20_000;
/// The largest answer asked for (the link's line limit is 4 MiB).
pub const MAX_BYTES: u64 = 1024 * 1024;
/// How long a catch-up before a native read may take.
pub const CATCH_UP_WAIT: Duration = Duration::from_secs(5);
/// How long the catch-up at the start may take.
pub const START_WAIT: Duration = Duration::from_secs(10);
/// The largest number an answer may carry (the schema's bound, `Number.MAX_SAFE_INTEGER`): the arithmetic below
/// stays far from an overflow whatever the peer sends.
const MAX_NUMBER: u64 = 9_007_199_254_740_991;
/// How long a catch-up pauses after an answer that says more is waiting and brought nothing new.
const NO_PROGRESS_PAUSE: Duration = Duration::from_millis(20);
/// How long the follower rests after a call that failed.
const RETRY_AFTER: Duration = Duration::from_secs(1);
/// How long the follower rests after an answer that brought nothing and did not wait for it. A legacy core that is
/// stopping answers at once (its handlers must not hold the stop); without the rest the follower would ask it in a
/// tight loop until the link ends.
const EMPTY_REST: Duration = Duration::from_millis(250);

/// Why the mirror could not be brought in step: a short code for a log line or an error reason, never content.
pub type Code = String;
/// The code of a link that has ended; the follower stops on it.
pub const LINK_GONE: &str = "link-gone";

/// Where the changes come from: `legacy.redaction.changes` on the control link.
pub trait ChangesSource: Send + Sync {
    /// One call. `wait_ms` is how long the legacy core may hold it; the result is the method's result.
    fn changes(&self, epoch: &str, after: u64, wait_ms: u64, max_bytes: u64)
        -> Result<Value, Code>;
}

#[derive(Default)]
struct State {
    epoch: String,
    /// The number of the last change applied in `epoch`.
    cursor: u64,
    /// What the legacy core has pinned, in the order it was told.
    pinned: Vec<String>,
    /// Whether the last call succeeded and left nothing waiting.
    synced: bool,
    /// The replay of a new epoch that is not complete yet; `pinned` and the set are the old epoch's until it is.
    staged: Option<Staged>,
    /// Whether an answer was ever applied: the first journal has nothing to replace and is applied as it arrives.
    seen: bool,
}

/// The registry a new epoch's replay describes so far.
#[derive(Default)]
struct Staged {
    pinned: Vec<String>,
    /// Oldest first; no more than the set keeps.
    retired: Vec<String>,
}

impl Staged {
    fn take(&mut self, change: &Change<'_>) {
        self.retired.retain(|v| v != change.secret);
        let held = self.pinned.iter().position(|v| v == change.secret);
        match (change.pinned, held) {
            (true, None) => self.pinned.push(change.secret.to_owned()),
            (true, Some(_)) => {}
            (false, held) => {
                if let Some(at) = held {
                    self.pinned.remove(at);
                }
                self.retired.push(change.secret.to_owned());
                if self.retired.len() > MAX_REGISTERED_SECRETS {
                    self.retired.remove(0);
                }
            }
        }
    }
}

/// The mirror: a [`SecretSet`] and where it stands in the legacy core's journal.
pub struct RedactionMirror {
    set: Arc<SecretSet>,
    state: Mutex<State>,
    source: OnceLock<Arc<dyn ChangesSource>>,
}

/// One change of an answer.
struct Change<'a> {
    secret: &'a str,
    pinned: bool,
}

/// The members of an answer, or `None` when it is not one.
fn parse(answer: &Value) -> Option<(&str, u64, Vec<Change<'_>>, bool)> {
    let epoch = answer.get("epoch")?.as_str().filter(|e| !e.is_empty())?;
    let next = answer.get("next")?.as_u64()?;
    let more = answer.get("more")?.as_bool()?;
    let secrets = answer
        .get("secrets")?
        .as_array()?
        .iter()
        .map(|change| {
            Some(Change {
                secret: change.get("secret")?.as_str()?,
                pinned: change.get("pinned")?.as_bool()?,
            })
        })
        .collect::<Option<Vec<_>>>()?;
    Some((epoch, next, secrets, more))
}

impl RedactionMirror {
    /// A mirror that fills `set`. Until a source is set it has nothing to ask.
    pub fn new(set: Arc<SecretSet>) -> RedactionMirror {
        RedactionMirror {
            set,
            state: Mutex::default(),
            source: OnceLock::new(),
        }
    }

    /// The set the mirror fills.
    pub fn set(&self) -> &Arc<SecretSet> {
        &self.set
    }

    /// Where to ask: the control link, once it is up. A second call changes nothing.
    pub fn set_source(&self, source: Arc<dyn ChangesSource>) {
        let _ = self.source.set(source);
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Whether the mirror is in step: its last call succeeded and nothing was waiting. A native `logs.query` is only
    /// served while this holds; otherwise the legacy core answers it.
    pub fn synced(&self) -> bool {
        self.state().synced
    }

    /// Where the mirror stands: the epoch and the number of the last change applied.
    fn position(&self) -> (String, u64) {
        let state = self.state();
        (state.epoch.clone(), state.cursor)
    }

    fn out_of_step(&self, code: &str) -> Code {
        self.state().synced = false;
        code.to_owned()
    }

    /// One call and its application. `Ok(more)`: whether further changes are waiting.
    fn pull(&self, wait_ms: u64) -> Result<bool, Code> {
        let Some(source) = self.source.get() else {
            return Err(self.out_of_step("no-source"));
        };
        let (epoch, after) = {
            let state = self.state();
            (state.epoch.clone(), state.cursor)
        };
        match source.changes(&epoch, after, wait_ms, MAX_BYTES) {
            Ok(answer) => self.apply(&epoch, &answer),
            Err(code) => Err(self.out_of_step(&code)),
        }
    }

    /// Applies one answer of `legacy.redaction.changes`. `asked` is the epoch the call named.
    ///
    /// Two threads ask, so an answer can be applied after the mirror has moved on. Within an epoch that is harmless
    /// (numbers already applied are passed over). Across epochs it is not: the complete journal of an older epoch
    /// starts at 1 like a new one. An answer of another epoch is therefore only taken as a new epoch when the mirror
    /// still stands where the call left it; otherwise it is late, and it is dropped.
    fn apply(&self, asked: &str, answer: &Value) -> Result<bool, Code> {
        let Some((epoch, next, changes, more)) = parse(answer) else {
            return Err(self.out_of_step("malformed"));
        };
        let count = changes.len() as u64;
        // The changes of an answer are numbered `first..=next`, and numbers start at 1.
        if count > next || next > MAX_NUMBER {
            return Err(self.out_of_step("malformed"));
        }
        let first = next + 1 - count;
        let mut state = self.state();
        if epoch != state.epoch && asked != state.epoch {
            // Nothing is known from it; the caller asks again from where the mirror stands now.
            return Ok(true);
        }
        let gap = if epoch == state.epoch {
            first > state.cursor + 1
        } else {
            // A journal we have never seen the start of.
            first != 1
        };
        if gap {
            // Ask for a new one.
            state.epoch.clear();
            state.cursor = 0;
            state.synced = false;
            state.staged = None;
            return Err("out-of-order".to_owned());
        }
        if epoch != state.epoch {
            state.epoch = epoch.to_owned();
            state.cursor = 0;
            if state.seen {
                state.staged = Some(Staged::default());
            }
        }
        let cursor = state.cursor;
        let fresh = (first..)
            .zip(&changes)
            .filter(|(number, _)| *number > cursor)
            .map(|(_, change)| change);
        if let Some(mut staged) = state.staged.take() {
            fresh.for_each(|change| staged.take(change));
            if more {
                state.staged = Some(staged);
            } else {
                let held: Vec<&str> = staged.pinned.iter().map(String::as_str).collect();
                let retired: Vec<&str> = staged.retired.iter().map(String::as_str).collect();
                self.set.restate(GROUP, &held, &retired);
                state.pinned = staged.pinned;
            }
        } else {
            self.apply_in_step(&mut state.pinned, fresh);
        }
        // An answer that ends before where the mirror stands (a late one of the other thread) says nothing about
        // what is waiting now.
        if next >= state.cursor {
            state.synced = !more;
        }
        state.cursor = state.cursor.max(next);
        state.seen = true;
        Ok(more)
    }

    /// The changes of an epoch the set is in step with, one by one.
    fn apply_in_step<'a>(
        &self,
        pinned: &mut Vec<String>,
        changes: impl Iterator<Item = &'a Change<'a>>,
    ) {
        let mut group_changed = false;
        let flush = |pinned: &[String], changed: &mut bool| {
            if *changed {
                let values: Vec<&str> = pinned.iter().map(String::as_str).collect();
                self.set.replace_group(GROUP, &values);
                *changed = false;
            }
        };
        for change in changes {
            let held = pinned.iter().position(|v| v == change.secret);
            match (change.pinned, held) {
                (true, None) => {
                    pinned.push(change.secret.to_owned());
                    group_changed = true;
                }
                (true, Some(_)) => {}
                (false, Some(at)) => {
                    // Leaves the group; the set keeps it among the retired values.
                    pinned.remove(at);
                    group_changed = true;
                }
                (false, None) => {
                    // In the order of the journal: what left the group before this value retired before it.
                    flush(pinned, &mut group_changed);
                    self.set.register(change.secret);
                }
            }
        }
        flush(pinned, &mut group_changed);
    }

    /// Asks until nothing is waiting, for at most `budget`: the barrier at the start and the catch-up before a native
    /// read. Never waits in the legacy core.
    pub fn catch_up(&self, budget: Duration) -> Result<(), Code> {
        let deadline = Instant::now() + budget;
        loop {
            let before = self.position();
            match self.pull(0) {
                Ok(false) => return Ok(()),
                // More is waiting. An answer that says so and brought nothing (a late one, or a peer that is
                // wrong) is not asked for again at the speed of the link.
                Ok(true) => {
                    if self.position() == before {
                        std::thread::sleep(NO_PROGRESS_PAUSE);
                    }
                }
                // The mirror asked for a new epoch: once more, from the start.
                Err(code) if code == "out-of-order" => {}
                Err(code) => return Err(code),
            }
            if Instant::now() >= deadline {
                return Err(self.out_of_step("timeout"));
            }
        }
    }

    /// Keeps asking in a long poll until the link has ended or `stopped` says so. `failed` is told the code of a call
    /// that failed, once for a run of the same failure (for one log line; it gets no content).
    pub fn follow(&self, stopped: &dyn Fn() -> bool, failed: &dyn Fn(&str)) {
        self.follow_resting(stopped, failed, RETRY_AFTER);
    }

    fn follow_resting(
        &self,
        stopped: &dyn Fn() -> bool,
        failed: &dyn Fn(&str),
        retry_after: Duration,
    ) {
        let mut failing: Option<Code> = None;
        while !stopped() {
            let (before, asked) = (self.position(), Instant::now());
            match self.pull(POLL_WAIT_MS) {
                Ok(_) => {
                    failing = None;
                    // Nothing new, and it did not wait for it: whether it says more is waiting or not.
                    if asked.elapsed() < EMPTY_REST && self.position() == before {
                        std::thread::sleep(EMPTY_REST);
                    }
                }
                Err(code) if code == LINK_GONE => return,
                Err(code) => {
                    if failing.as_deref() != Some(code.as_str()) {
                        failed(&code);
                    }
                    failing = Some(code);
                    std::thread::sleep(retry_after);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicBool, Ordering};

    /// A source that answers from a script and records what it was asked.
    #[derive(Default)]
    struct Scripted {
        answers: Mutex<VecDeque<Result<Value, Code>>>,
        asked: Mutex<Vec<(String, u64, u64, u64)>>,
    }

    impl Scripted {
        fn with(answers: Vec<Result<Value, Code>>) -> Arc<Scripted> {
            Arc::new(Scripted {
                answers: Mutex::new(answers.into()),
                asked: Mutex::default(),
            })
        }

        fn asked(&self) -> Vec<(String, u64, u64, u64)> {
            self.asked.lock().unwrap().clone()
        }
    }

    impl ChangesSource for Scripted {
        fn changes(
            &self,
            epoch: &str,
            after: u64,
            wait_ms: u64,
            max_bytes: u64,
        ) -> Result<Value, Code> {
            self.asked
                .lock()
                .unwrap()
                .push((epoch.to_owned(), after, wait_ms, max_bytes));
            self.answers
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| Err(LINK_GONE.to_owned()))
        }
    }

    fn word(n: u32) -> String {
        format!("plain value number {n:04}")
    }

    /// An answer whose changes are `(n, pinned)` for `word(n)`.
    fn answer(epoch: &str, next: u64, changes: &[(u32, bool)], more: bool) -> Result<Value, Code> {
        let secrets: Vec<Value> = changes
            .iter()
            .map(|(n, pinned)| json!({ "secret": word(*n), "pinned": pinned }))
            .collect();
        Ok(json!({ "epoch": epoch, "next": next, "secrets": secrets, "more": more }))
    }

    fn mirror_over(source: &Arc<Scripted>) -> RedactionMirror {
        let mirror = RedactionMirror::new(Arc::new(SecretSet::new()));
        mirror.set_source(source.clone());
        mirror
    }

    fn words(numbers: &[u32]) -> Vec<String> {
        numbers.iter().map(|n| word(*n)).collect()
    }

    #[test]
    fn the_start_asks_until_nothing_is_waiting_and_acknowledges_what_it_applied() {
        let source = Scripted::with(vec![
            answer("1", 2, &[(1, true), (2, true)], true),
            answer("1", 3, &[(3, false)], false),
        ]);
        let mirror = mirror_over(&source);
        assert!(!mirror.synced());
        assert_eq!(mirror.catch_up(START_WAIT), Ok(()));
        assert!(mirror.synced());
        // Pinned values first (the group), then the retired one; the set masks all three.
        assert_eq!(mirror.set().values(), words(&[1, 2, 3]));
        assert_eq!(
            source.asked(),
            [
                (String::new(), 0, 0, MAX_BYTES),
                ("1".to_owned(), 2, 0, MAX_BYTES)
            ],
            "no epoch at first, then the epoch and the last number applied; a catch-up never waits"
        );
        assert_eq!(
            mirror.set().mask(&format!("a line with {} in it", word(3))),
            "a line with [redacted] in it"
        );
    }

    #[test]
    fn a_value_that_is_no_longer_held_retires_and_a_value_never_held_is_registered_without_a_name()
    {
        let source = Scripted::with(vec![
            answer("1", 3, &[(1, true), (2, true), (3, true)], false),
            // A rotation: the old value retires, the new one is pinned; then a value that never was held; then a value
            // that is told as pinned twice (nothing changes) and one retired that the mirror never held.
            answer(
                "1",
                8,
                &[(2, false), (4, true), (5, false), (4, true), (6, false)],
                false,
            ),
        ]);
        let mirror = mirror_over(&source);
        mirror.catch_up(START_WAIT).unwrap();
        mirror.catch_up(START_WAIT).unwrap();
        // The group in the order told (1, 3, 4), then the retired ones oldest first: 2 left the group before 5 was told.
        assert_eq!(mirror.set().values(), words(&[1, 3, 4, 2, 5, 6]));
        // Pinned values are never displaced, however many retired ones follow.
        let flood: Vec<(u32, bool)> = (100..100 + 300).map(|n| (n, false)).collect();
        let more = Scripted::with(vec![
            answer("1", 3, &[(1, true), (2, true), (3, true)], false),
            answer("1", 303, &flood, false),
        ]);
        let mirror = mirror_over(&more);
        mirror.catch_up(START_WAIT).unwrap();
        mirror.catch_up(START_WAIT).unwrap();
        let values = mirror.set().values();
        assert_eq!(values[..3], words(&[1, 2, 3]));
        assert_eq!(values.len(), 3 + MAX_REGISTERED_SECRETS);
        assert_eq!(
            values.last(),
            Some(&word(399)),
            "the newest retired value is kept, the oldest are gone"
        );
    }

    #[test]
    fn a_change_that_was_already_applied_is_passed_over() {
        // Two callers asked with the same `after`: the second answer overlaps the first.
        let source = Scripted::with(vec![
            answer("1", 2, &[(1, true), (2, true)], false),
            answer("1", 3, &[(2, false), (2, true), (3, true)], false),
        ]);
        let mirror = mirror_over(&source);
        mirror.catch_up(START_WAIT).unwrap();
        // The overlapping answer: its changes are 1..=3, of which 1 and 2 are known. Had `(2, false)` (number 1) been
        // applied again, the value 2 would have left the group.
        assert_eq!(
            mirror.apply(
                "",
                &answer("1", 3, &[(1, true), (2, true), (3, true)], false).unwrap()
            ),
            Ok(false)
        );
        assert_eq!(mirror.set().values(), words(&[1, 2, 3]));
        // An answer that is wholly behind changes nothing, not even the number the mirror stands at.
        assert_eq!(
            mirror.apply(
                "1",
                &answer("1", 2, &[(1, false), (2, false)], false).unwrap()
            ),
            Ok(false)
        );
        assert_eq!(mirror.set().values(), words(&[1, 2, 3]));
        mirror.catch_up(START_WAIT).unwrap();
        assert_eq!(
            source.asked()[1],
            ("1".to_owned(), 3, 0, MAX_BYTES),
            "the number never goes back"
        );
    }

    #[test]
    fn a_new_epoch_replaces_what_the_mirror_held() {
        let source = Scripted::with(vec![
            answer("1", 3, &[(1, true), (2, true), (3, false)], false),
            // The legacy core dropped its journal: a new epoch with the whole registry, in which 2 is no longer held.
            answer("2", 2, &[(1, true), (4, true)], false),
        ]);
        let mirror = mirror_over(&source);
        mirror.catch_up(START_WAIT).unwrap();
        mirror.catch_up(START_WAIT).unwrap();
        assert!(mirror.synced());
        // 1 and 4 are held; 3 was retired before, 2 retired with the old epoch. Nothing that was masked stops being masked.
        assert_eq!(mirror.set().values(), words(&[1, 4, 3, 2]));
        mirror.catch_up(START_WAIT).unwrap_err();
        assert_eq!(source.asked()[2], ("2".to_owned(), 2, 0, MAX_BYTES));
    }

    #[test]
    fn an_answer_that_does_not_continue_where_the_mirror_stands_is_not_applied() {
        for gap in [
            // The same epoch, but the changes start beyond the next number.
            answer("1", 6, &[(5, true), (6, true)], false),
            // An epoch the mirror has never seen the start of.
            answer("2", 6, &[(5, true), (6, true)], false),
        ] {
            let source = Scripted::with(vec![
                answer("1", 2, &[(1, true), (2, true)], false),
                gap,
                answer("3", 3, &[(1, true), (2, true), (7, true)], false),
            ]);
            let mirror = mirror_over(&source);
            mirror.catch_up(START_WAIT).unwrap();
            // The catch-up asks again at once, without an epoch, and takes the new one.
            assert_eq!(mirror.catch_up(START_WAIT), Ok(()));
            assert_eq!(
                mirror.set().values(),
                words(&[1, 2, 7]),
                "5 and 6 were never applied"
            );
            let asked = source.asked();
            assert_eq!(asked[1], ("1".to_owned(), 2, 0, MAX_BYTES));
            assert_eq!(asked[2], (String::new(), 0, 0, MAX_BYTES));
            assert!(mirror.synced());
            // Alone, the answer that does not fit leaves a mirror that was in step out of step.
            let alone = Scripted::with(vec![
                answer("1", 2, &[(1, true), (2, true)], false),
                answer("1", 6, &[(5, true), (6, true)], false),
            ]);
            let mirror = mirror_over(&alone);
            mirror.catch_up(START_WAIT).unwrap();
            assert!(mirror.synced());
            assert_eq!(mirror.pull(0), Err("out-of-order".to_owned()));
            assert!(!mirror.synced());
        }
    }

    #[test]
    fn a_failing_or_malformed_answer_leaves_the_mirror_out_of_step_with_a_code() {
        let odd = [
            json!(null),
            json!({}),
            json!({ "epoch": "", "next": 0, "secrets": [], "more": false }),
            json!({ "epoch": "1", "next": 0, "secrets": [], "more": "no" }),
            json!({ "epoch": "1", "next": -1, "secrets": [], "more": false }),
            json!({ "epoch": "1", "next": 1, "secrets": [{ "value": word(1), "pinned": true }], "more": false }),
            json!({ "epoch": "1", "next": 1, "secrets": [{ "secret": word(1) }], "more": false }),
            json!({ "epoch": "1", "next": 1, "secrets": [{ "secret": 5, "pinned": true }], "more": false }),
            // More changes than numbers.
            json!({ "epoch": "1", "next": 0, "secrets": [{ "secret": word(1), "pinned": true }], "more": false }),
        ];
        for answer in odd {
            let source = Scripted::with(vec![
                Ok(json!({ "epoch": "1", "next": 0, "secrets": [], "more": false })),
                Ok(answer.clone()),
            ]);
            let mirror = mirror_over(&source);
            mirror.catch_up(START_WAIT).unwrap();
            assert!(mirror.synced());
            assert_eq!(
                mirror.catch_up(START_WAIT),
                Err("malformed".to_owned()),
                "{answer}"
            );
            assert!(!mirror.synced(), "{answer}");
            assert!(mirror.set().values().is_empty(), "{answer}");
        }
        let source = Scripted::with(vec![
            answer("1", 1, &[(1, true)], false),
            Err("timeout".to_owned()),
            answer("1", 1, &[], false),
        ]);
        let mirror = mirror_over(&source);
        mirror.catch_up(START_WAIT).unwrap();
        assert_eq!(mirror.catch_up(START_WAIT), Err("timeout".to_owned()));
        assert!(!mirror.synced());
        // What it held stays masked; the next call that succeeds puts it in step again.
        assert_eq!(mirror.set().values(), words(&[1]));
        assert_eq!(mirror.catch_up(START_WAIT), Ok(()));
        assert!(mirror.synced());
        // Without a source there is nothing to ask.
        let alone = RedactionMirror::new(Arc::new(SecretSet::new()));
        assert_eq!(alone.catch_up(START_WAIT), Err("no-source".to_owned()));
    }

    #[test]
    fn a_catch_up_gives_up_at_its_budget() {
        struct Endless;
        impl ChangesSource for Endless {
            fn changes(&self, _: &str, after: u64, _: u64, _: u64) -> Result<Value, Code> {
                std::thread::sleep(Duration::from_millis(5));
                Ok(
                    json!({ "epoch": "1", "next": after + 1, "secrets": [{ "secret": format!("plain value number {after:06}"), "pinned": false }], "more": true }),
                )
            }
        }
        let mirror = RedactionMirror::new(Arc::new(SecretSet::new()));
        mirror.set_source(Arc::new(Endless));
        let started = Instant::now();
        assert_eq!(
            mirror.catch_up(Duration::from_millis(60)),
            Err("timeout".to_owned())
        );
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(!mirror.synced());
        assert!(
            !mirror.set().values().is_empty(),
            "what arrived is masked all the same"
        );
    }

    #[test]
    fn the_follower_waits_in_the_legacy_core_reports_failures_and_ends_with_the_link() {
        let source = Scripted::with(vec![
            answer("1", 1, &[(1, true)], false),
            Err("refused:E_INTERNAL".to_owned()),
            answer("1", 2, &[(2, false)], true),
            answer("1", 3, &[(3, true)], false),
            // Then the script is empty: the link is gone.
        ]);
        let mirror = mirror_over(&source);
        let failures: Mutex<Vec<String>> = Mutex::default();
        let started = Instant::now();
        mirror.follow(&|| false, &|code| {
            failures.lock().unwrap().push(code.to_owned())
        });
        assert!(started.elapsed() < Duration::from_secs(10));
        assert_eq!(*failures.lock().unwrap(), ["refused:E_INTERNAL"]);
        assert_eq!(mirror.set().values(), words(&[1, 3, 2]));
        let asked = source.asked();
        assert!(
            asked
                .iter()
                .all(|(_, _, wait, max)| *wait == POLL_WAIT_MS && *max == MAX_BYTES),
            "{asked:?}"
        );
        assert_eq!(
            asked
                .iter()
                .map(|(epoch, after, _, _)| (epoch.as_str(), *after))
                .collect::<Vec<_>>(),
            [("", 0), ("1", 1), ("1", 1), ("1", 2), ("1", 3)]
        );
        assert!(!mirror.synced(), "the last call failed");
        // A stop is looked at before every call.
        let stopped = AtomicBool::new(true);
        let idle = Scripted::with(Vec::new());
        mirror_over(&idle).follow(&|| stopped.load(Ordering::SeqCst), &|_| {});
        assert!(idle.asked().is_empty());
    }

    /// A new epoch that comes in pieces, into a set whose retired values are at the bound: no value the legacy core
    /// holds the whole time is unmasked between the pieces, and at the end the set holds what the legacy core holds.
    #[test]
    fn a_new_epoch_in_pieces_never_unmasks_what_the_legacy_core_still_holds() {
        let bound = u32::try_from(MAX_REGISTERED_SECRETS).unwrap();
        // 1 to 3 are held, 11.. are retired and fill the bound.
        let retired: Vec<(u32, bool)> = (11..11 + bound).map(|n| (n, false)).collect();
        let mut first = vec![(1, true), (2, true), (3, true)];
        first.extend(&retired);
        let whole = u64::from(bound) + 3;
        // The new epoch: 1 in the first answer; 2, a new 4 and the retired ones in the second. 3 is no longer held.
        let mut second = vec![(2, true), (4, true)];
        second.extend(&retired);
        let source = Scripted::with(vec![
            answer("1", whole, &first, false),
            answer("2", 1, &[(1, true)], true),
            answer("2", whole, &second, false),
        ]);
        let mirror = mirror_over(&source);
        mirror.catch_up(START_WAIT).unwrap();
        let before = mirror.set().values();
        assert_eq!(before.len(), MAX_REGISTERED_SECRETS + 3);

        // The first piece alone: the mirror is not in step, and the set is what it was.
        assert_eq!(mirror.pull(0), Ok(true));
        assert!(!mirror.synced());
        assert_eq!(mirror.set().values(), before);
        assert_eq!(mirror.position(), ("2".to_owned(), 1));

        assert_eq!(mirror.pull(0), Ok(false));
        assert!(mirror.synced());
        // What the legacy core holds: 1, 2 and 4, and every retired value. 3 retired before them and left the bound.
        let mut expected = words(&[1, 2, 4]);
        expected.extend(retired.iter().map(|(n, _)| word(*n)));
        assert_eq!(mirror.set().values(), expected);
        // The epoch goes on in step: one more change.
        source
            .answers
            .lock()
            .unwrap()
            .push_back(answer("2", whole + 1, &[(5, false)], false));
        assert_eq!(mirror.pull(0), Ok(false));
        assert!(mirror.set().values().contains(&word(5)));
        assert!(
            !mirror.set().values().contains(&word(11)),
            "the oldest retired value made room"
        );
        // And a held value: the mirror knows what the new epoch holds (1, 2 and 4), not what the old one did.
        source
            .answers
            .lock()
            .unwrap()
            .push_back(answer("2", whole + 2, &[(6, true)], false));
        assert_eq!(mirror.pull(0), Ok(false));
        assert_eq!(mirror.set().values()[..4], words(&[1, 2, 4, 6]));
    }

    /// Within a replay a value can be held and let go of again: it ends retired, not held.
    #[test]
    fn a_replay_ends_with_what_its_last_change_says() {
        let source = Scripted::with(vec![
            answer("1", 1, &[(1, true)], false),
            answer("2", 3, &[(1, true), (4, true), (5, false)], true),
            answer("2", 5, &[(4, false), (5, true)], false),
        ]);
        let mirror = mirror_over(&source);
        mirror.catch_up(START_WAIT).unwrap();
        mirror.catch_up(START_WAIT).unwrap();
        // Held: 1 and 5 (in the order they were last taken up). Retired: 4.
        assert_eq!(mirror.set().values(), words(&[1, 5, 4]));
        // The next change is judged by that: 4 is not held, so letting go of it again changes no group.
        source
            .answers
            .lock()
            .unwrap()
            .push_back(answer("2", 6, &[(1, false)], false));
        assert_eq!(mirror.pull(0), Ok(false));
        assert_eq!(mirror.set().values(), words(&[5, 4, 1]));
    }

    /// One change that only lets go of a held value: it leaves the group at once.
    #[test]
    fn letting_go_of_a_held_value_alone_retires_it() {
        let source = Scripted::with(vec![
            answer("1", 3, &[(1, true), (2, true), (3, true)], false),
            answer("1", 4, &[(2, false)], false),
        ]);
        let mirror = mirror_over(&source);
        mirror.catch_up(START_WAIT).unwrap();
        mirror.catch_up(START_WAIT).unwrap();
        assert_eq!(mirror.set().values(), words(&[1, 3, 2]));
    }

    /// The legacy core is not trusted to be right (review F1 to F3).
    #[test]
    fn numbers_beyond_the_schema_are_refused() {
        for next in [u64::MAX, MAX_NUMBER + 1] {
            let source = Scripted::with(vec![
                answer("1", 1, &[(1, true)], false),
                Ok(json!({ "epoch": "1", "next": next, "secrets": [], "more": false })),
            ]);
            let mirror = mirror_over(&source);
            mirror.catch_up(START_WAIT).unwrap();
            assert_eq!(mirror.catch_up(START_WAIT), Err("malformed".to_owned()));
            assert!(!mirror.synced());
            assert_eq!(mirror.position(), ("1".to_owned(), 1));
        }
        // The bound itself is a number like any other.
        let source = Scripted::with(vec![Ok(
            json!({ "epoch": "1", "next": MAX_NUMBER, "secrets": [], "more": false }),
        )]);
        assert_eq!(mirror_over(&source).pull(0), Err("out-of-order".to_owned()));
    }

    #[test]
    fn an_answer_that_promises_more_and_brings_nothing_is_not_chased() {
        /// Says more is waiting, every time, and never has anything.
        struct Promising(std::sync::atomic::AtomicU64);
        impl ChangesSource for Promising {
            fn changes(&self, _: &str, after: u64, _: u64, _: u64) -> Result<Value, Code> {
                self.0.fetch_add(1, Ordering::SeqCst);
                answer("1", after, &[], true)
            }
        }
        let calls = |source: &Promising| source.0.load(Ordering::SeqCst);
        // The follower rests as after any answer without news.
        let source = Arc::new(Promising(std::sync::atomic::AtomicU64::new(0)));
        let mirror = RedactionMirror::new(Arc::new(SecretSet::new()));
        mirror.set_source(source.clone());
        let started = Instant::now();
        mirror.follow(
            &|| started.elapsed() > Duration::from_millis(700),
            &|code| panic!("no call failed: {code}"),
        );
        assert!(
            (2..=5).contains(&calls(&source)),
            "{} calls",
            calls(&source)
        );
        assert!(!mirror.synced(), "more is said to be waiting");
        // A catch-up pauses between such answers and gives up at its budget.
        let source = Arc::new(Promising(std::sync::atomic::AtomicU64::new(0)));
        let mirror = RedactionMirror::new(Arc::new(SecretSet::new()));
        mirror.set_source(source.clone());
        assert_eq!(
            mirror.catch_up(Duration::from_millis(200)),
            Err("timeout".to_owned())
        );
        assert!(
            (2..=14).contains(&calls(&source)),
            "{} calls",
            calls(&source)
        );
    }

    #[test]
    fn a_late_answer_of_another_epoch_is_dropped() {
        let source = Scripted::with(vec![
            answer("1", 2, &[(1, true), (2, true)], false),
            // The legacy core began a new epoch: 2 is no longer held, 3 is.
            answer("2", 2, &[(1, true), (3, true)], false),
        ]);
        let mirror = mirror_over(&source);
        mirror.catch_up(START_WAIT).unwrap();
        mirror.catch_up(START_WAIT).unwrap();
        let held = mirror.set().values();
        assert_eq!(held, words(&[1, 3, 2]));
        // The other thread's call was made in epoch 1 and its answer, the whole journal of epoch 1, arrives now.
        let late = answer("1", 2, &[(1, true), (2, true)], false).unwrap();
        assert_eq!(mirror.apply("1", &late), Ok(true));
        assert_eq!(mirror.set().values(), held);
        assert_eq!(mirror.position(), ("2".to_owned(), 2));
        assert!(
            mirror.synced(),
            "a late answer says nothing about what is waiting now"
        );
        // One that does not even start at 1 is late too, not a gap: the mirror keeps its epoch.
        let late = answer("1", 4, &[(8, true), (9, true)], false).unwrap();
        assert_eq!(mirror.apply("1", &late), Ok(true));
        assert_eq!(mirror.position(), ("2".to_owned(), 2));
        // The same answer for a call made where the mirror stands is a new epoch: the legacy core says so.
        assert_eq!(
            mirror.apply("2", &answer("3", 1, &[(7, true)], false).unwrap()),
            Ok(false)
        );
        assert_eq!(mirror.position(), ("3".to_owned(), 1));
    }

    #[test]
    fn an_older_answer_of_the_same_epoch_does_not_say_the_mirror_is_in_step() {
        let source = Scripted::with(vec![
            answer("1", 1, &[(1, true)], false),
            answer("1", 3, &[(2, true), (3, true)], true),
        ]);
        let mirror = mirror_over(&source);
        mirror.catch_up(START_WAIT).unwrap();
        assert_eq!(mirror.pull(0), Ok(true));
        assert!(!mirror.synced());
        // The other thread's answer, asked for earlier: up to 2, and at that time nothing more was waiting.
        let older = answer("1", 2, &[(2, true)], false).unwrap();
        assert_eq!(mirror.apply("1", &older), Ok(false));
        assert!(!mirror.synced(), "more was waiting after 3");
        assert_eq!(mirror.position(), ("1".to_owned(), 3));
    }

    #[test]
    fn a_run_of_the_same_failure_is_reported_once_and_again_after_a_success() {
        let source = Scripted::with(vec![
            answer("1", 1, &[(1, true)], false),
            Err("timeout".to_owned()),
            Err("timeout".to_owned()),
            Err("timeout".to_owned()),
            answer("1", 2, &[(2, true)], false),
            Err("timeout".to_owned()),
            Err("refused:E_INTERNAL".to_owned()),
            Err("refused:E_INTERNAL".to_owned()),
        ]);
        let mirror = mirror_over(&source);
        let failures: Mutex<Vec<String>> = Mutex::default();
        mirror.follow_resting(
            &|| false,
            &|code| failures.lock().unwrap().push(code.to_owned()),
            Duration::from_millis(2),
        );
        assert_eq!(
            *failures.lock().unwrap(),
            ["timeout", "timeout", "refused:E_INTERNAL"]
        );
    }

    /// A long poll that came back empty after its wait is followed by the next one at once.
    #[test]
    fn an_empty_answer_that_waited_is_not_rested_on() {
        struct Patient(std::sync::atomic::AtomicU64);
        impl ChangesSource for Patient {
            fn changes(&self, _: &str, after: u64, _: u64, _: u64) -> Result<Value, Code> {
                self.0.fetch_add(1, Ordering::SeqCst);
                std::thread::sleep(EMPTY_REST + Duration::from_millis(50));
                answer("1", after, &[], false)
            }
        }
        let source = Arc::new(Patient(std::sync::atomic::AtomicU64::new(0)));
        let mirror = RedactionMirror::new(Arc::new(SecretSet::new()));
        mirror.set_source(source.clone());
        let started = Instant::now();
        mirror.follow(&|| started.elapsed() > Duration::from_millis(1300), &|_| {});
        // Calls begin at 0, 300, 600, 900 and 1200 ms; with a rest after each there would be three.
        let calls = source.0.load(Ordering::SeqCst);
        assert!(calls >= 4, "{calls} calls in 1.3 s");
    }

    /// A replay that is given up (the next answer does not continue it) leaves the set as it was, and the next epoch
    /// starts from nothing.
    #[test]
    fn a_replay_that_breaks_off_changes_nothing() {
        let source = Scripted::with(vec![
            answer("1", 2, &[(1, true), (2, false)], false),
            answer("2", 1, &[(3, true)], true),
            // Not the next piece: numbers 5 and 6.
            answer("2", 6, &[(5, true), (6, true)], false),
            answer("3", 2, &[(1, true), (7, true)], false),
        ]);
        let mirror = mirror_over(&source);
        mirror.catch_up(START_WAIT).unwrap();
        assert_eq!(mirror.pull(0), Ok(true));
        assert_eq!(mirror.pull(0), Err("out-of-order".to_owned()));
        assert!(!mirror.synced());
        assert_eq!(mirror.set().values(), words(&[1, 2]));
        assert_eq!(mirror.position(), (String::new(), 0));
        assert_eq!(mirror.pull(0), Ok(false));
        // 3, 5 and 6 never arrived whole: they are not in the set.
        assert_eq!(mirror.set().values(), words(&[1, 7, 2]));
    }

    #[test]
    fn restate_is_one_step_and_retires_what_left_the_group_behind_the_named_values() {
        let set = SecretSet::new();
        set.replace_group("g", &["value number one", "value number two"]);
        set.register("retired value a");
        set.register("retired value b");
        set.restate(
            "g",
            &["value number two", "value number three"],
            &["retired value b", "retired value c"],
        );
        // Held: two and three. Retired, oldest first: a (untouched), one (left the group), then b and c as named.
        assert_eq!(
            set.values(),
            [
                "value number two",
                "value number three",
                "retired value a",
                "value number one",
                "retired value b",
                "retired value c"
            ]
        );
        // A value the group holds is not retired by being named.
        set.restate("g", &["value number two"], &["value number two"]);
        assert_eq!(set.values()[0], "value number two");
        assert_eq!(
            set.values()
                .iter()
                .filter(|v| *v == "value number two")
                .count(),
            1
        );
    }

    /// A source that answers at once, every time: with one more change per call, or with nothing.
    struct Eager {
        calls: std::sync::atomic::AtomicU64,
        changes: bool,
    }

    impl ChangesSource for Eager {
        fn changes(&self, _: &str, after: u64, _: u64, _: u64) -> Result<Value, Code> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if self.changes {
                let n = u32::try_from(after + 1).unwrap();
                answer("1", after + 1, &[(n, true)], false)
            } else {
                answer("1", after, &[], false)
            }
        }
    }

    #[test]
    fn a_source_that_does_not_wait_is_not_asked_in_a_tight_loop() {
        let run = |changes: bool| {
            let source = Arc::new(Eager {
                calls: std::sync::atomic::AtomicU64::new(0),
                changes,
            });
            let mirror = RedactionMirror::new(Arc::new(SecretSet::new()));
            mirror.set_source(source.clone());
            let started = Instant::now();
            mirror.follow(
                &|| started.elapsed() > Duration::from_millis(700),
                &|code| panic!("no call failed: {code}"),
            );
            (source.calls.load(Ordering::SeqCst), mirror)
        };
        // Nothing new, at once (a legacy core that is stopping): a rest after every answer. Calls at 0, 250, 500 and
        // 750 ms; the bound leaves room for a slow machine, not for a loop.
        let (calls, mirror) = run(false);
        assert!((2..=4).contains(&calls), "{calls} calls in 700 ms");
        assert!(mirror.synced());
        // Changes that come at once are taken at once: the rest is for empty answers only.
        let (calls, mirror) = run(true);
        assert!(calls > 20, "{calls} calls in 700 ms");
        assert_eq!(mirror.set().values().len(), usize::try_from(calls).unwrap());
    }

    #[test]
    fn two_threads_may_apply_overlapping_answers() {
        // Every answer covers 1..=n for a growing n; whichever order they are applied in, the mirror ends at the largest.
        let mirror = Arc::new(RedactionMirror::new(Arc::new(SecretSet::new())));
        let answers: Vec<Value> = (1..=40u32)
            .map(|n| {
                let changes: Vec<(u32, bool)> = (1..=n).map(|i| (i, true)).collect();
                answer("1", u64::from(n), &changes, false).unwrap()
            })
            .collect();
        let (even, odd): (Vec<_>, Vec<_>) = answers
            .into_iter()
            .enumerate()
            .partition(|(i, _)| i % 2 == 0);
        let threads: Vec<_> = [even, odd]
            .into_iter()
            .map(|part| {
                let mirror = mirror.clone();
                std::thread::spawn(move || {
                    for (_, answer) in part.into_iter().rev() {
                        let _ = mirror.apply("", &answer);
                    }
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        let expected: Vec<u32> = (1..=40).collect();
        assert_eq!(mirror.set().values(), words(&expected));
    }
}
