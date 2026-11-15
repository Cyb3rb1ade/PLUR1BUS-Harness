//! The core's side (`secrets/isolated-backend.ts`): a [`SecretBackend`] whose work happens in a helper process.
//!
//! A keychain can block on a prompt and a file system can hang; neither may hold the core. Every call is a request to the
//! helper with a budget (three seconds, [`SECRET_IO_BUDGET_MS`]). When the budget runs out, the helper exits or its pipe
//! breaks, the helper is retired (killed, never waited for without a bound), the `unavailable` flag is raised for the
//! store, and the call answers `backend-unavailable`. The next call starts a new helper.
//!
//! The helper is started at the first call, not at construction. Its executable is fixed when the backend is made
//! ([`helper_of`]); no environment variable and no request can choose it.
//!
//! Threads: one writes requests to the helper and one reads its replies, so a helper that stops reading or writing cannot
//! block a call beyond its budget. Both end when the helper's pipes close.
use super::protocol::{
    encode_frame, error_from_json, meta_from_json, operation_failed, probe_from_json, read_frame,
    request, store_unavailable, tombstones_from_json, write_bytes, BackendDescription, Operation,
};
use crate::secrets::backend::SecretBackend;
use crate::secrets::error::SecretError;
use crate::secrets::types::{BackendKind, BackendProbe, SecretMeta};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::thread;
use std::time::{Duration, Instant};

/// The budget of one call, in milliseconds (`SECRET_IO_BUDGET_MS`).
pub const SECRET_IO_BUDGET_MS: u64 = 3000;

/// How long `close` waits for a killed helper to be gone (`CLOSE_BUDGET_MS`).
const CLOSE_BUDGET: Duration = Duration::from_millis(250);

/// How long a killed helper is looked after before it is given up (it then stays a zombie until the core ends).
const REAP_BUDGET: Duration = Duration::from_secs(30);

/// The argument that makes the core's executable a helper.
pub const HELPER_COMMAND: &str = "secrets-helper";

/// The handle on a helper that can end it.
pub trait HelperControl: Send {
    /// Kills the helper. Never blocks; a helper that is already gone is fine.
    fn kill(&mut self);

    /// Whether the helper has ended (and takes its exit status, so nothing is left of it).
    fn exited(&mut self) -> bool;
}

/// A started helper: its input, its output and the handle that ends it.
pub struct HelperProcess {
    /// Where requests are written (the helper's standard input).
    pub input: Box<dyn Write + Send>,
    /// Where replies are read (the helper's standard output).
    pub output: Box<dyn Read + Send>,
    /// Ends the helper.
    pub control: Box<dyn HelperControl>,
}

/// Starts a helper for a backend. A trusted in-process port: production uses [`helper_of`], tests hand in their own.
pub type SpawnHelper = Box<dyn FnMut(&BackendDescription) -> io::Result<HelperProcess> + Send>;

/// How an isolated backend runs.
pub struct IsolatedOptions {
    /// The budget of one call.
    pub budget: Duration,
    /// Starts a helper.
    pub spawn: SpawnHelper,
    /// Raised when a helper fails (`onUnavailable`): the store reads it (`StartupOptions::unavailable`).
    pub unavailable: Arc<AtomicBool>,
}

struct ChildControl(Child);

impl HelperControl for ChildControl {
    fn kill(&mut self) {
        let _ = self.0.kill();
    }

    fn exited(&mut self) -> bool {
        !matches!(self.0.try_wait(), Ok(None))
    }
}

/// Starts `command` as a helper: its input and output are private pipes, its error output goes nowhere (a panic message
/// must not reach a log), and on Windows it gets no console window.
pub fn spawn_process(mut command: Command) -> io::Result<HelperProcess> {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW
        command.creation_flags(0x0800_0000);
    }
    let mut child = command.spawn()?;
    match (child.stdin.take(), child.stdout.take()) {
        (Some(input), Some(output)) => Ok(HelperProcess {
            input: Box::new(input),
            output: Box::new(output),
            control: Box::new(ChildControl(child)),
        }),
        _ => {
            let _ = child.kill();
            let _ = child.wait();
            Err(io::Error::other("the helper has no pipes"))
        }
    }
}

/// The production port: `executable secrets-helper`. The path is the core's own executable, resolved by the caller once.
pub fn helper_of(executable: PathBuf) -> SpawnHelper {
    Box::new(move |_| {
        let mut command = Command::new(&executable);
        command.arg(HELPER_COMMAND);
        spawn_process(command)
    })
}

/// The helper that is running now.
struct Live {
    generation: u64,
    control: Box<dyn HelperControl>,
}

#[derive(Default)]
struct State {
    live: Option<Live>,
    closed: bool,
    generation: u64,
    /// One receiver per retired helper: it disconnects when the helper is gone or its close budget is over.
    retiring: Vec<Receiver<()>>,
}

impl State {
    /// `retire`: the generation is invalid from here on, the helper is killed, and a thread looks after its exit.
    fn retire(&mut self, mut live: Live) {
        live.control.kill();
        let (done, gone) = mpsc::channel::<()>();
        self.retiring
            .retain(|waiting| matches!(waiting.try_recv(), Err(TryRecvError::Empty)));
        self.retiring.push(gone);
        let reap = move || {
            let started = Instant::now();
            let mut done = Some(done);
            let mut control = live.control;
            while !control.exited() && started.elapsed() < REAP_BUDGET {
                if started.elapsed() >= CLOSE_BUDGET {
                    done = None;
                }
                thread::sleep(Duration::from_millis(if done.is_some() { 5 } else { 250 }));
            }
        };
        // Without a thread the helper is killed all the same; only its exit status stays uncollected.
        let _ = thread::Builder::new()
            .name("secrets-helper-reaper".into())
            .spawn(reap);
    }
}

struct Shared {
    description: BackendDescription,
    budget: Duration,
    unavailable: Arc<AtomicBool>,
    spawn: Mutex<SpawnHelper>,
    state: Mutex<State>,
}

impl Shared {
    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// `fail`: the helper of `generation` broke. When it is still the live one, the store is told and it is retired; a
    /// helper that was retired on purpose (`cancel`, `close`) fails silently.
    fn fail(&self, generation: u64) {
        let mut state = self.state();
        if state
            .live
            .as_ref()
            .is_some_and(|l| l.generation == generation)
        {
            self.unavailable.store(true, Ordering::SeqCst);
            if let Some(live) = state.live.take() {
                state.retire(live);
            }
        }
    }

    fn cancel(&self) {
        let mut state = self.state();
        if let Some(live) = state.live.take() {
            state.retire(live);
        }
    }

    fn close(&self) {
        let retiring = {
            let mut state = self.state();
            state.closed = true;
            if let Some(live) = state.live.take() {
                state.retire(live);
            }
            std::mem::take(&mut state.retiring)
        };
        for gone in retiring {
            // Disconnects when the helper is gone, at the latest when its close budget is over.
            let _ = gone.recv_timeout(CLOSE_BUDGET * 2);
        }
    }
}

/// Retires the running helper and ends the backend, from outside the store (`cancel` and `close` of
/// `createIsolatedBackend`).
#[derive(Clone)]
pub struct IsolatedHandle {
    shared: Arc<Shared>,
}

impl IsolatedHandle {
    /// Retires the running helper without telling the store; a call in flight answers `backend-unavailable`, the next
    /// call starts a new helper.
    pub fn cancel(&self) {
        self.shared.cancel();
    }

    /// Ends the backend: the helper is retired and no new one is started. Waits for the retired helpers to be gone, each
    /// for at most its close budget.
    pub fn close(&self) {
        self.shared.close();
    }
}

/// This backend's connection to the live helper.
struct Link {
    generation: u64,
    frames: Sender<Vec<u8>>,
    replies: Receiver<Value>,
}

/// A backend served by a helper process.
pub struct IsolatedBackend {
    shared: Arc<Shared>,
    link: Option<Link>,
    sequence: u64,
}

/// `createIsolatedBackend(description, options)`: the backend and the handle that retires its helper.
pub fn isolated_backend(
    description: BackendDescription,
    options: IsolatedOptions,
) -> (IsolatedBackend, IsolatedHandle) {
    let shared = Arc::new(Shared {
        description,
        budget: options.budget,
        unavailable: options.unavailable,
        spawn: Mutex::new(options.spawn),
        state: Mutex::default(),
    });
    (
        IsolatedBackend {
            shared: shared.clone(),
            link: None,
            sequence: 0,
        },
        IsolatedHandle { shared },
    )
}

impl IsolatedBackend {
    /// `start`: the link to the live helper, started when there is none. An error is "no helper": the backend is closed
    /// or the helper cannot be started.
    fn start(&mut self) -> Result<(), ()> {
        let mut state = self.shared.state();
        if state.closed {
            self.link = None;
            return Err(());
        }
        let linked = match (&self.link, &state.live) {
            (Some(link), Some(live)) => link.generation == live.generation,
            _ => false,
        };
        if linked {
            return Ok(());
        }
        self.link = None;
        if let Some(stale) = state.live.take() {
            state.retire(stale);
        }
        let spawned = {
            let mut spawn = self
                .shared
                .spawn
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            spawn(&self.shared.description)
        };
        let HelperProcess {
            mut input,
            mut output,
            control,
        } = spawned.map_err(|_| ())?;
        state.generation += 1;
        let generation = state.generation;
        let (frames, outgoing) = mpsc::channel::<Vec<u8>>();
        let (incoming, replies) = mpsc::channel::<Value>();

        let shared: Weak<Shared> = Arc::downgrade(&self.shared);
        let writer = thread::Builder::new()
            .name("secrets-helper-writer".into())
            .spawn(move || {
                for frame in outgoing {
                    if write_bytes(&mut input, &frame).is_err() {
                        if let Some(shared) = shared.upgrade() {
                            shared.fail(generation);
                        }
                        break;
                    }
                }
                // Dropping `input` closes the helper's input: a helper nobody talks to any more ends by itself.
            });
        let shared: Weak<Shared> = Arc::downgrade(&self.shared);
        let reader = thread::Builder::new()
            .name("secrets-helper-reader".into())
            .spawn(move || {
                while let Ok(Some(reply)) = read_frame(&mut output) {
                    if incoming.send(reply).is_err() {
                        return;
                    }
                }
                // The helper ended or wrote something that is no frame. The store hears of it before the caller does.
                if let Some(shared) = shared.upgrade() {
                    shared.fail(generation);
                }
            });
        let live = Live {
            generation,
            control,
        };
        if writer.is_err() || reader.is_err() {
            state.retire(live);
            return Err(());
        }
        state.live = Some(live);
        self.link = Some(Link {
            generation,
            frames,
            replies,
        });
        Ok(())
    }

    /// `request`: one operation, answered within the budget or not at all.
    fn request(
        &mut self,
        operation: Operation,
        args: &[Value],
        register: Option<&mut dyn FnMut(&str)>,
    ) -> Result<Option<Value>, SecretError> {
        let deadline = Instant::now() + self.shared.budget;
        let link = match self.start() {
            Ok(()) => self.link.as_ref(),
            Err(()) => None,
        };
        let Some(link) = link else {
            self.shared.unavailable.store(true, Ordering::SeqCst);
            return Err(store_unavailable());
        };
        self.sequence += 1;
        let id = self.sequence;
        let message = request(id, &self.shared.description, operation, args);
        // A request no frame can hold never leaves; the helper is not to blame.
        let frame = encode_frame(&message).ok_or_else(operation_failed)?;
        let generation = link.generation;
        if link.frames.send(frame).is_err() {
            self.shared.fail(generation);
            return Err(store_unavailable());
        }
        let reply = loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match link.replies.recv_timeout(left) {
                // A reply to an earlier request is nobody's any more.
                Ok(reply) if reply.get("id").and_then(Value::as_u64) == Some(id) => break reply,
                Ok(_) => {}
                Err(_) => {
                    // Out of budget, or the helper is gone (a helper retired on purpose fails silently).
                    self.shared.fail(generation);
                    return Err(store_unavailable());
                }
            }
        };
        if let Some(register) = register {
            for value in reply
                .get("registrations")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                register(value);
            }
        }
        match reply.get("error") {
            None | Some(Value::Null) => Ok(reply.get("value").cloned()),
            Some(error) => Err(error_from_json(error)),
        }
    }

    /// The value of a reply that must have one of a known shape; anything else is a helper that does not speak the
    /// protocol.
    fn answer<T>(
        reply: Result<Option<Value>, SecretError>,
        decode: impl FnOnce(&Value) -> Option<T>,
    ) -> Result<T, SecretError> {
        let value = reply?.unwrap_or(Value::Null);
        decode(&value).ok_or_else(operation_failed)
    }
}

impl Drop for IsolatedBackend {
    /// A backend nobody holds any more leaves no helper behind.
    fn drop(&mut self) {
        self.shared.cancel();
    }
}

impl SecretBackend for IsolatedBackend {
    fn kind(&self) -> BackendKind {
        self.shared.description.kind()
    }

    fn probe(&mut self) -> Result<BackendProbe, SecretError> {
        Self::answer(self.request(Operation::Probe, &[], None), probe_from_json)
    }

    fn get(&mut self, name: &str) -> Result<Option<String>, SecretError> {
        Self::answer(
            self.request(Operation::Get, &[json!(name)], None),
            |value| match value {
                Value::Null => Some(None),
                other => other.as_str().map(|s| Some(s.to_owned())),
            },
        )
    }

    fn put(
        &mut self,
        name: &str,
        value: &str,
        now_ms: i64,
        updated_by: Option<&str>,
        description: Option<&str>,
        register: Option<&mut dyn FnMut(&str)>,
    ) -> Result<SecretMeta, SecretError> {
        Self::answer(
            self.request(
                Operation::Put,
                &[
                    json!(name),
                    json!(value),
                    json!(now_ms),
                    json!(updated_by),
                    json!(description),
                ],
                register,
            ),
            meta_from_json,
        )
    }

    fn describe(
        &mut self,
        name: &str,
        description: &str,
        now_ms: i64,
        updated_by: Option<&str>,
        register: Option<&mut dyn FnMut(&str)>,
    ) -> Result<SecretMeta, SecretError> {
        Self::answer(
            self.request(
                Operation::Describe,
                &[
                    json!(name),
                    json!(description),
                    json!(now_ms),
                    json!(updated_by),
                ],
                register,
            ),
            meta_from_json,
        )
    }

    fn delete(&mut self, name: &str, tombstone_at_ms: Option<i64>) -> Result<bool, SecretError> {
        Self::answer(
            self.request(
                Operation::Delete,
                &[json!(name), json!(tombstone_at_ms)],
                None,
            ),
            Value::as_bool,
        )
    }

    /// Only the file backend keeps tombstones (the TypeScript object has the method only for `kind: "file"`).
    fn tombstones(&mut self) -> Option<Result<BTreeMap<String, String>, SecretError>> {
        (self.kind() == BackendKind::File).then(|| {
            Self::answer(
                self.request(Operation::Tombstones, &[], None),
                tombstones_from_json,
            )
        })
    }

    fn clear_tombstone(&mut self, name: &str) -> Option<Result<(), SecretError>> {
        (self.kind() == BackendKind::File).then(|| {
            self.request(Operation::ClearTombstone, &[json!(name)], None)
                .map(|_| ())
        })
    }

    fn list(&mut self) -> Result<Vec<SecretMeta>, SecretError> {
        Self::answer(self.request(Operation::List, &[], None), |value| {
            value.as_array()?.iter().map(meta_from_json).collect()
        })
    }
}
