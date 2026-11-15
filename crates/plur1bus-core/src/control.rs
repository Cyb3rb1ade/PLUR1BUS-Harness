//! The front door's own link to the legacy core: the control link.
//!
//! One connection, opened at start before the front door listens. Its handshake names it (`core.auth.frontDoor.caller =
//! "front-door"`, owner credentials) and gives the engine `contract` the front door reports; `core.shutdown` goes over it
//! at stop. Since P4-12 flip A2 it also carries the front door's own calls to the legacy core, the `legacy.*` methods of
//! `docs/phase4/bridge.md` ([`Control::call`]): the legacy core serves those on this connection only, and the front door
//! relays no client's request under that namespace (`route::Route::Legacy`).
//!
//! A reader thread takes every line the legacy core writes on the link. The answer to a call that is waiting goes to its
//! caller; anything else (the answer to `core.shutdown`, a notification) is dropped. When the link ends every waiting
//! call ends with it, and no later call is sent.
use crate::frame;
use crate::native::LegacyCore;
use crate::relay;
use crate::run_files::RunFiles;
use crate::server;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fmt;
use std::io::BufReader;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

/// How long the control link's handshake may take.
const AUTH_TIMEOUT: Duration = Duration::from_secs(30);

/// How long a `legacy.*` call waits for its answer. The methods are short (a notification, a reconcile); the caller is
/// a connection thread that has already committed its change.
pub const CALL_WAIT: Duration = Duration::from_secs(5);

/// Why a call on the control link has no result.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CallError {
    /// The link has ended, or ended before the answer came.
    Gone,
    /// No answer within the wait.
    Timeout,
    /// The legacy core refused: its error code (`E_...`), or `no-result` for an answer without one.
    Refused(String),
}

impl fmt::Display for CallError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CallError::Gone => f.write_str("link-gone"),
            CallError::Timeout => f.write_str("timeout"),
            CallError::Refused(code) => write!(f, "refused:{code}"),
        }
    }
}

#[derive(Default)]
struct Waiting {
    calls: HashMap<String, mpsc::SyncSender<Value>>,
    ended: bool,
}

/// The calls that wait for their answer on the link.
#[derive(Default)]
struct Pending(Mutex<Waiting>);

impl Pending {
    fn lock(&self) -> std::sync::MutexGuard<'_, Waiting> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Registers a call before it is sent: where its answer will arrive, or nothing once the link has ended.
    fn expect(&self, id: &str) -> Option<mpsc::Receiver<Value>> {
        let mut waiting = self.lock();
        if waiting.ended {
            return None;
        }
        let (answer, receiver) = mpsc::sync_channel(1);
        waiting.calls.insert(id.to_owned(), answer);
        Some(receiver)
    }

    /// A call that stopped waiting: a late answer is dropped.
    fn forget(&self, id: &str) {
        self.lock().calls.remove(id);
    }

    /// One line of the link: an answer (a `result` or an `error` under a string id) to a waiting call goes to it, once.
    fn deliver(&self, line: &[u8]) {
        let Ok(message) = serde_json::from_slice::<Value>(line) else {
            return;
        };
        let answered = message.get("result").is_some() || message.get("error").is_some();
        let Some(id) = message
            .get("id")
            .and_then(Value::as_str)
            .filter(|_| answered)
        else {
            return;
        };
        if let Some(answer) = self.lock().calls.remove(id) {
            let _ = answer.try_send(message);
        }
    }

    /// The link has ended: every waiting call learns it, and none is registered any more.
    fn end(&self) {
        let mut waiting = self.lock();
        waiting.ended = true;
        waiting.calls.clear();
    }
}

/// The control link.
pub struct Control {
    /// The writing half.
    pub(crate) link: relay::Link,
    /// Set once the link's reader has seen its end: a stop then cannot reach the legacy core through it.
    pub(crate) gone: Arc<AtomicBool>,
    pending: Arc<Pending>,
}

impl Control {
    /// Sends `method` with `params` and waits up to `wait` for the legacy core's answer: its `result`.
    pub fn call(&self, method: &str, params: &Value, wait: Duration) -> Result<Value, CallError> {
        if self.gone.load(Ordering::SeqCst) {
            return Err(CallError::Gone);
        }
        let id = self.link.next_id();
        let Some(answer) = self.pending.expect(&id) else {
            return Err(CallError::Gone);
        };
        let request = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        if self.link.send(&frame::encode(&request)).is_err() {
            self.pending.forget(&id);
            return Err(CallError::Gone);
        }
        match answer.recv_timeout(wait) {
            Ok(reply) => outcome(&reply),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                self.pending.forget(&id);
                Err(CallError::Timeout)
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(CallError::Gone),
        }
    }
}

/// An answer's `result`, or the code of its `error`.
fn outcome(reply: &Value) -> Result<Value, CallError> {
    if let Some(result) = reply.get("result") {
        return Ok(result.clone());
    }
    let code = reply
        .pointer("/error/data/error")
        .and_then(Value::as_str)
        .filter(|code| code.starts_with("E_") && code.len() <= 32)
        .unwrap_or("no-result");
    Err(CallError::Refused(code.to_owned()))
}

impl LegacyCore for Control {
    fn reachable(&self) -> bool {
        !self.gone.load(Ordering::SeqCst)
    }

    fn account_changed(&self, user_id: &str, rights: bool, learning: bool) -> Result<(), String> {
        let params = json!({"userId": user_id, "rights": rights, "learning": learning});
        let mut answer = self.call("legacy.account.changed", &params, CALL_WAIT);
        // A refusal is the handler failing in the legacy core: once more (both follow-ups may run twice). A call
        // without an answer is not repeated: the request is in the legacy core's queue and runs when it gets to it.
        if matches!(answer, Err(CallError::Refused(_))) {
            answer = self.call("legacy.account.changed", &params, CALL_WAIT);
        }
        answer.map(|_| ()).map_err(|e| e.to_string())
    }
}

/// Opens the control link to the legacy core `legacy_pid` and authenticates it. Returns the link and the engine
/// `contract` of the legacy core's handshake.
pub fn connect(
    files: &RunFiles,
    credentials: &server::Credentials,
    legacy_pid: u32,
) -> Result<(Arc<Control>, String), String> {
    let (link, reader) = relay::Link::connect(&files.legacy_address, legacy_pid)
        .map_err(|e| format!("cannot connect to the legacy core: {e}"))?;
    let id = link.next_id();
    let hello = json!({"jsonrpc":"2.0","id": id,"method":"core.auth","params":{
        "token": credentials.core.expose(),
        "frontDoor": {"token": credentials.link.expose(), "caller": "front-door"},
    }});
    reader
        .set_read_timeout(Some(AUTH_TIMEOUT))
        .map_err(|e| e.to_string())?;
    link.send(&frame::encode(&hello))
        .map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(reader);
    let reply = match frame::read_line(&mut reader) {
        Ok(frame::Line::Data(bytes)) => {
            serde_json::from_slice::<Value>(&bytes).map_err(|e| e.to_string())?
        }
        _ => return Err("the legacy core closed the control link".into()),
    };
    let contract = reply
        .pointer("/result/contract")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            let reason = reply
                .pointer("/error/data/reason")
                .and_then(Value::as_str)
                .unwrap_or("no result");
            format!("the legacy core refused the control link ({reason})")
        })?
        .to_owned();
    reader
        .get_ref()
        .set_read_timeout(None)
        .map_err(|e| e.to_string())?;
    let gone = Arc::new(AtomicBool::new(false));
    let pending = Arc::new(Pending::default());
    let (ended, waiting) = (gone.clone(), pending.clone());
    std::thread::Builder::new()
        .name("core-control".into())
        .spawn(move || {
            while let Ok(frame::Line::Data(line)) = frame::read_line(&mut reader) {
                waiting.deliver(&line);
            }
            ended.store(true, Ordering::SeqCst);
            waiting.end();
            // After the flag: once this line is out, a stop takes the lifeline path (task review L1, re-review M-e).
            server::log("info", "the control link ended", Value::Null);
        })
        .map_err(|e| e.to_string())?;
    Ok((
        Arc::new(Control {
            link,
            gone,
            pending,
        }),
        contract,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(value: &Value) -> Vec<u8> {
        serde_json::to_vec(value).unwrap()
    }

    #[test]
    fn an_answer_reaches_the_call_that_waits_for_it_once() {
        let pending = Pending::default();
        let first = pending.expect("fd-ab-1").unwrap();
        let second = pending.expect("fd-ab-2").unwrap();
        pending.deliver(&line(&json!({"jsonrpc":"2.0","id":"fd-ab-2","result":{}})));
        assert_eq!(second.try_recv().unwrap()["result"], json!({}));
        assert!(first.try_recv().is_err(), "the other call still waits");
        // The same id again finds nobody; the first call is untouched.
        pending.deliver(&line(
            &json!({"jsonrpc":"2.0","id":"fd-ab-2","result":{"again":true}}),
        ));
        assert!(second.try_recv().is_err());
        pending.deliver(&line(&json!({"jsonrpc":"2.0","id":"fd-ab-1","error":{"code":-32000,"data":{"error":"E_DENIED"}}})));
        assert_eq!(
            outcome(&first.try_recv().unwrap()),
            Err(CallError::Refused("E_DENIED".into()))
        );
    }

    #[test]
    fn what_is_no_answer_to_a_waiting_call_is_dropped() {
        let pending = Pending::default();
        let call = pending.expect("fd-ab-1").unwrap();
        for other in [
            json!({"jsonrpc":"2.0","method":"core.state","params":{"state":"ready"}}),
            // A request or a notification that carries the id is no answer.
            json!({"jsonrpc":"2.0","id":"fd-ab-1","method":"core.state","params":{}}),
            json!({"jsonrpc":"2.0","id":"fd-ab-9","result":{}}),
            json!({"jsonrpc":"2.0","id":1,"result":{}}),
            json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700}}),
            json!(["fd-ab-1"]),
        ] {
            pending.deliver(&line(&other));
        }
        pending.deliver(b"not json");
        assert!(call.try_recv().is_err());
        assert_eq!(pending.lock().calls.len(), 1);
    }

    #[test]
    fn a_call_that_stopped_waiting_drops_its_late_answer() {
        let pending = Pending::default();
        let call = pending.expect("fd-ab-1").unwrap();
        pending.forget("fd-ab-1");
        pending.deliver(&line(&json!({"jsonrpc":"2.0","id":"fd-ab-1","result":{}})));
        assert!(matches!(
            call.try_recv(),
            Err(mpsc::TryRecvError::Disconnected)
        ));
    }

    #[test]
    fn the_end_of_the_link_ends_every_waiting_call_and_admits_no_new_one() {
        let pending = Pending::default();
        let call = pending.expect("fd-ab-1").unwrap();
        pending.end();
        assert!(matches!(
            call.recv_timeout(Duration::from_secs(1)),
            Err(mpsc::RecvTimeoutError::Disconnected)
        ));
        assert!(pending.expect("fd-ab-2").is_none());
    }

    #[test]
    fn an_answer_is_its_result_or_the_code_of_its_error() {
        assert_eq!(
            outcome(&json!({"id":"a","result":{"x":1}})),
            Ok(json!({"x":1}))
        );
        assert_eq!(outcome(&json!({"id":"a","result":null})), Ok(Value::Null));
        let refused = |error: Value| outcome(&json!({"id":"a","error":error}));
        assert_eq!(
            refused(
                json!({"code":-32601,"message":"method not found: x","data":{"error":"E_INTERNAL","reason":"method-not-found"}})
            ),
            Err(CallError::Refused("E_INTERNAL".into()))
        );
        // Only a harness error code is repeated (it goes into a log line): anything else is `no-result`.
        for odd in [
            json!({}),
            json!({"data":{"error":"secret text"}}),
            json!({"data":{"error":7}}),
            json!({"data":{"error": format!("E_{}", "X".repeat(40))}}),
        ] {
            assert_eq!(refused(odd), Err(CallError::Refused("no-result".into())));
        }
        assert_eq!(CallError::Gone.to_string(), "link-gone");
        assert_eq!(CallError::Timeout.to_string(), "timeout");
        assert_eq!(
            CallError::Refused("E_DENIED".into()).to_string(),
            "refused:E_DENIED"
        );
    }
}
