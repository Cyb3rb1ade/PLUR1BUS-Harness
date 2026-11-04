//! The event connection owns replay, live notifications and approval/cancel replies; the call connection stays independent.
use super::{
    pump::{self, Bus, Cursor, Event, Sequence},
    CodeError,
};
use crate::{identity::CallerIdentity, paths::Layout};
use plur1bus_rpc::Client;
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender},
        Arc,
    },
    thread::{self, JoinHandle},
    time::Duration,
};

/// Immutable session identity and the durable cursor shared across reconnects.
pub(super) struct SessionStream {
    session: String,
    agent: String,
    caller: CallerIdentity,
    cursor: Cursor,
}
impl SessionStream {
    pub fn new(session: &str, agent: &str, caller: &CallerIdentity, after_seq: u64) -> Self {
        Self {
            session: session.into(),
            agent: agent.into(),
            caller: caller.clone(),
            cursor: Cursor(after_seq),
        }
    }
}

pub(super) struct ReaderCommand {
    pub operation: String,
    pub method: String,
    pub params: Value,
}
pub(super) struct Reader {
    sender: SyncSender<ReaderCommand>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}
impl Reader {
    pub fn spawn(
        layout: &Layout,
        client: Client,
        mut state: SessionStream,
        bus: Bus,
        stop: Arc<AtomicBool>,
    ) -> Result<Self, CodeError> {
        let (sender, receiver) = mpsc::sync_channel(32);
        let home = layout.home.clone();
        let stopping = stop.clone();
        let handle = thread::Builder::new()
            .name("code-events".into())
            .spawn(move || {
                let layout = Layout::new(home);
                let mut client = Some(client);
                let mut attempts = 0;
                while !stopping.load(Ordering::Acquire) {
                    let connected = client
                        .take()
                        .map(Ok)
                        .unwrap_or_else(|| super::connect(&layout));
                    let outcome = connected
                        .and_then(|mut c| run(&mut c, &mut state, &receiver, &bus, &stopping));
                    if stopping.load(Ordering::Acquire) {
                        break;
                    }
                    if let Err(error) = outcome {
                        attempts += 1;
                        if attempts > 10 {
                            bus.send(Event::Failed(error));
                            break;
                        }
                        if !bus.send(Event::Notice("event-reconnect".into())) {
                            break;
                        }
                        thread::park_timeout(Duration::from_millis(100 * attempts));
                    } else {
                        break;
                    }
                }
            })?;
        Ok(Self {
            sender,
            stop,
            thread: Some(handle),
        })
    }
    pub fn command(&self, operation: &str, method: &str, params: Value) -> Result<(), CodeError> {
        self.sender
            .try_send(ReaderCommand {
                operation: operation.into(),
                method: method.into(),
                params,
            })
            .map_err(|_| CodeError::new("E_BUSY", "event connection is busy or closed"))
    }
}
impl Drop for Reader {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn run(
    client: &mut Client,
    state: &mut SessionStream,
    commands: &Receiver<ReaderCommand>,
    bus: &Bus,
    stop: &AtomicBool,
) -> Result<(), CodeError> {
    client.enable_notifications();
    // Approvals have a person audience, not params.agentId; an agent filter would hide them (including helpers).
    // The server enforces the person audience; this reader filters every record by session before forwarding it.
    pump::request(
        client,
        "events.subscribe",
        json!({"names":["session.event","approval.requested","approval.resolved"]}),
        stop,
        Duration::from_secs(30),
    )?;
    replay(client, state, commands, bus, stop)?;
    // Approval notifications are transient. Recover pending records after a disconnect, including pagination.
    if client.supports("approval.list") {
        let mut page = Value::Null;
        loop {
            if stop.load(Ordering::Acquire) || !process_command(client, commands, bus, stop)? {
                return Ok(());
            }
            let mut params = json!({"agent":state.agent,"status":"pending","limit":50});
            if !page.is_null() {
                params["cursor"] = page.clone();
            }
            let pending = pump::request(
                client,
                "approval.list",
                params,
                stop,
                Duration::from_secs(30),
            )?;
            for approval in pending["approvals"].as_array().into_iter().flatten() {
                if approval["sessionId"].as_str() == Some(state.session.as_str()) {
                    bus.send(Event::Frame(json!({"jsonrpc":"2.0","method":"approval.requested","params":{"approval":approval}})));
                }
            }
            let next = pending.get("nextCursor").cloned().unwrap_or(Value::Null);
            if next.is_null() || next == page {
                break;
            }
            page = next;
        }
    }
    while !stop.load(Ordering::Acquire) {
        if !process_command(client, commands, bus, stop)? {
            return Ok(());
        }
        if let Some(frame) = client.next_notification()? {
            if frame["method"].as_str() == Some("session.event") {
                let event = &frame["params"]["event"];
                if event["sessionId"].as_str() != Some(state.session.as_str()) {
                    continue;
                }
                let seq = event["seq"].as_u64().ok_or_else(|| {
                    CodeError::new("E_RPC_PROTOCOL", "session event has no sequence")
                })?;
                if state.cursor.inspect(seq) == Sequence::Gap {
                    replay(client, state, commands, bus, stop)?;
                }
                match state.cursor.inspect(seq) {
                    Sequence::Duplicate => continue,
                    Sequence::Gap => {
                        return Err(CodeError::new(
                            "E_RPC_PROTOCOL",
                            "session event gap was not recoverable",
                        ))
                    }
                    Sequence::Next => {
                        if !bus.send(Event::Frame(frame)) {
                            return Ok(());
                        }
                        state.cursor.0 = seq;
                    }
                }
            } else {
                if frame["method"]
                    .as_str()
                    .is_some_and(|s| s.starts_with("approval."))
                    && frame["params"]["approval"]["sessionId"].as_str()
                        != Some(state.session.as_str())
                {
                    continue;
                }
                if !bus.send(Event::Frame(frame)) {
                    return Ok(());
                }
            }
        }
    }
    Ok(())
}

fn process_command(
    client: &mut Client,
    commands: &Receiver<ReaderCommand>,
    bus: &Bus,
    stop: &AtomicBool,
) -> Result<bool, CodeError> {
    if let Ok(command) = commands.try_recv() {
        let result = pump::request(
            client,
            &command.method,
            command.params,
            stop,
            Duration::from_secs(90),
        );
        let broken = client.is_poisoned();
        if !bus.send(Event::Reply {
            operation: command.operation,
            result,
        }) {
            return Ok(false);
        }
        if broken {
            return Err(CodeError::new(
                "E_CORE_UNAVAILABLE",
                "event connection interrupted",
            ));
        }
    }
    Ok(true)
}

fn replay(
    client: &mut Client,
    state: &mut SessionStream,
    commands: &Receiver<ReaderCommand>,
    bus: &Bus,
    stop: &AtomicBool,
) -> Result<(), CodeError> {
    loop {
        // A long catch-up must not postpone a person's cancel or approval until the stream goes idle.
        if stop.load(Ordering::Acquire) || !process_command(client, commands, bus, stop)? {
            return Ok(());
        }
        // One durable event per response keeps a replay bounded even for a maximum-size legacy tool result.
        let result = pump::request(
            client,
            "session.events",
            json!({"caller":state.caller,"sessionId":state.session,"afterSeq":state.cursor.0,"limit":1}),
            stop,
            Duration::from_secs(30),
        )?;
        let events = result["events"].as_array().ok_or_else(|| {
            CodeError::new("E_RPC_PROTOCOL", "session.events has no events array")
        })?;
        if events.is_empty() {
            break;
        }
        for event in events {
            let seq = event["seq"].as_u64().ok_or_else(|| {
                CodeError::new("E_RPC_PROTOCOL", "replayed event has no sequence")
            })?;
            if state.cursor.inspect(seq) != Sequence::Next {
                return Err(CodeError::new(
                    "E_RPC_PROTOCOL",
                    "durable session stream is not consecutive",
                ));
            }
            if !bus.send(Event::Frame(json!({"jsonrpc":"2.0","method":"session.event","params":{"agentId":state.agent,"event":event}}))) { return Ok(()); }
            state.cursor.0 = seq;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use plur1bus_rpc::{transport::Stream, ConnectOptions};
    use std::io::{self, Cursor as Bytes, Read, Write};
    use std::sync::Mutex;

    struct Script {
        replies: Bytes<Vec<u8>>,
        writes: Arc<Mutex<Vec<u8>>>,
    }
    impl Read for Script {
        fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
            self.replies.read(bytes)
        }
    }
    impl Write for Script {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.writes.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    impl Stream for Script {
        fn set_read_timeout(&self, _: Option<Duration>) -> io::Result<()> {
            Ok(())
        }
        fn peer_pid(&self) -> Option<u32> {
            None
        }
        fn peer_uid(&self) -> Option<u32> {
            #[cfg(unix)]
            {
                // SAFETY: geteuid has no preconditions; this in-memory test peer represents the current process.
                Some(unsafe { libc::geteuid() })
            }
            #[cfg(not(unix))]
            {
                None
            }
        }
    }

    #[test]
    fn a_waiting_cancel_is_answered_before_the_next_durable_replay_page() {
        let fixture: Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../packages/rpc-schema/fixtures/methods/core.auth.json"
        )))
        .unwrap();
        let replies = [
            json!({"jsonrpc":"2.0","id":1,"result":fixture["result"]}),
            json!({"jsonrpc":"2.0","id":2,"result":{"cancelled":true}}),
            json!({"jsonrpc":"2.0","id":3,"result":{"events":[]}}),
        ]
        .into_iter()
        .map(|frame| format!("{frame}\n"))
        .collect::<String>()
        .into_bytes();
        let writes = Arc::new(Mutex::new(Vec::new()));
        let mut client = Client::handshake(
            Box::new(Script {
                replies: Bytes::new(replies),
                writes: writes.clone(),
            }),
            "fixture-token",
            ConnectOptions::default(),
        )
        .unwrap();
        client.enable_notifications();
        let caller = CallerIdentity {
            channel: "cli",
            account_id: "host".into(),
            user_id: "person".into(),
        };
        let mut state = SessionStream::new("s", "a", &caller, 99);
        let stop = Arc::new(AtomicBool::new(false));
        let (bus, events) = Bus::channel(stop.clone());
        let (sender, commands) = mpsc::sync_channel(1);
        sender
            .send(ReaderCommand {
                operation: "cancel".into(),
                method: "session.cancel".into(),
                params: json!({"caller":caller,"sessionId":"s"}),
            })
            .unwrap();
        replay(&mut client, &mut state, &commands, &bus, &stop).unwrap();
        let Event::Reply { operation, result } = events.try_recv().unwrap().into_event() else {
            panic!("the queued control must receive a reply during catch-up");
        };
        assert_eq!(operation, "cancel");
        assert_eq!(result.unwrap()["cancelled"], true);
        assert_eq!(state.cursor.0, 99);
        let written = writes.lock().unwrap();
        let methods: Vec<String> = written
            .split(|byte| *byte == b'\n')
            .filter(|line| !line.is_empty())
            .map(|line| {
                serde_json::from_slice::<Value>(line).unwrap()["method"]
                    .as_str()
                    .unwrap()
                    .into()
            })
            .collect();
        assert_eq!(methods, ["core.auth", "session.cancel", "session.events"]);
    }
}
