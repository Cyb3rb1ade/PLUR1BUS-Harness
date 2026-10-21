//! The shell side of the transport choice (spec §3.2, §5.4, §7.1, §9.2, §9.4): the confirmation held for the app
//! session while the store cannot persist it, one check in flight per window, the gate of every pairing, open and
//! reconnect, and the one log line a check writes (purpose, category and codes; never an address, a name or peer
//! data).
//!
//! Acknowledgement invariants (package T4): a [`PublicAck`] is stored only when a fresh check says the target is
//! public; a host/origin or transport change clears it; every open and every reconnect is gated with a fresh report.
//! So a stored entry without a confirmation was written while the target was not public, and a public target meeting
//! such an entry has *become* public (`target-changed-public`).

use super::report::wire_name;
use super::{
    check_target, check_target_acked, gate, CheckDeps, CheckedTarget, CliTailscale, Hint,
    HostInput, OsResolver, PublicAck, Purpose, Severity, StoreMode, TargetInput, TcpProber,
    Transport, TransportEntry, TransportError, TransportReport, TransportStore,
    TransportStoreError,
};
use crate::connections::{Connection, Origin};
use plur1bus_desktop_net::CLASSIFIER_ID;
use serde::Serialize;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use tokio::sync::watch;
use uuid::Uuid;

/// What the connection list shows of one remote connection's path.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransportView {
    pub transport: Transport,
    /// A confirmation valid under the current classifier snapshot exists (stored or for this session).
    pub public_ack: bool,
    /// The store cannot persist a confirmation now: a new one lasts for this app session only
    /// (`transport.public.session`).
    pub store_read_only: bool,
}

/// Where the check's log line goes: stderr in the app (`commands::transports`), a capture in tests.
pub type LogSink = Arc<dyn Fn(&str) + Send + Sync>;

/// What a reconnect may do after its fresh check (spec §9.2).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Recheck {
    /// Reconnect over these checked addresses.
    Pinned(CheckedTarget),
    /// Stop reconnecting and raise this code (`target-changed-public` or `transport-confirm-needed`); no automatic
    /// confirmation, ever.
    Attention(&'static str),
    /// Nothing to connect to this round (unresolved, DNS timeout, nothing connectable): try again after the backoff.
    Retry,
}

/// A confirmation that lives in memory for this app session only (spec §3.2), valid while origin and transport are
/// the ones it was given for.
struct SessionAck {
    origin: Origin,
    transport: Transport,
    ack: PublicAck,
}

/// The shell's transport state (Tauri managed state; the IPC commands are thin wrappers around it).
pub struct Transports {
    deps: CheckDeps,
    session: Mutex<BTreeMap<Uuid, SessionAck>>,
    windows: Mutex<BTreeMap<String, watch::Sender<u64>>>,
    /// The re-check of each connection now in flight (spec §5.4).
    inflight: Mutex<BTreeMap<Uuid, Arc<tokio::sync::OnceCell<Recheck>>>>,
    generation: AtomicU64,
    write_failed: AtomicBool,
    log: LogSink,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

impl Transports {
    /// The state around injected seams; `log` receives the check lines (this module prints nothing itself).
    pub fn new(deps: CheckDeps, log: LogSink) -> Self {
        Self {
            deps,
            session: Mutex::default(),
            windows: Mutex::default(),
            inflight: Mutex::default(),
            generation: AtomicU64::new(0),
            write_failed: AtomicBool::new(false),
            log,
        }
    }

    /// The real seams: the OS resolver, the Tailscale CLI from its fixed places, the TCP probe.
    pub fn production(log: LogSink) -> Self {
        Self::new(
            CheckDeps {
                resolver: Arc::new(OsResolver::default()),
                tailscale: Arc::new(CliTailscale::new()),
                prober: Arc::new(TcpProber::default()),
            },
            log,
        )
    }

    /// A remote row's target under `transport`, or its effective transport.
    fn target(
        store: &TransportStore,
        row: &Connection,
        transport: Option<Transport>,
    ) -> Result<TargetInput, TransportError> {
        let (host, port) = HostInput::from_origin(&row.origin)?;
        Ok(TargetInput {
            host,
            port,
            transport: transport.unwrap_or_else(|| store.effective(row).transport),
            purpose: Purpose::Remote,
        })
    }

    /// The confirmation that counts for a remote row: the stored one if it is valid under the current snapshot, else
    /// this session's for the same origin and transport, else a stored one from an older snapshot (which [`gate`]
    /// treats as none).
    pub fn ack(&self, store: &TransportStore, row: &Connection) -> Option<PublicAck> {
        let entry = store.effective(row);
        if entry
            .public_ack
            .as_ref()
            .is_some_and(|a| a.classifier == CLASSIFIER_ID)
        {
            return entry.public_ack;
        }
        let mut session = lock(&self.session);
        match session.get(&row.id) {
            Some(s) if s.origin == row.origin && s.transport == entry.transport => {
                return Some(s.ack.clone())
            }
            Some(_) => {
                session.remove(&row.id);
            }
            None => {}
        }
        entry.public_ack
    }

    /// Whether a confirmation given now can only last for this session (store from a newer version, unreadable, or
    /// its last write failed).
    pub fn cannot_persist(&self, store: &TransportStore) -> bool {
        store.mode() != StoreMode::ReadWrite || self.write_failed.load(Ordering::SeqCst)
    }

    pub fn view(&self, store: &TransportStore, row: &Connection) -> TransportView {
        TransportView {
            transport: store.effective(row).transport,
            public_ack: self
                .ack(store, row)
                .is_some_and(|a| a.classifier == CLASSIFIER_ID),
            store_read_only: self.cannot_persist(store),
        }
    }

    /// A stored entry without a confirmation was written while the target was not public.
    fn stored_private(store: &TransportStore, row: &Connection) -> bool {
        store.get(row.id).is_some_and(|e| e.public_ack.is_none())
    }

    /// Renames the public warning of a target that has become public (spec §7.2 `transport.public.changed`).
    fn mark_changed(report: &mut TransportReport) {
        for hint in &mut report.hints {
            if matches!(hint.code, "target-public" | "target-mixed") {
                hint.code = "target-changed-public";
            }
        }
    }

    /// The gate of an open or a reconnect (spec §7.1, §9.2): a fresh check of the row's effective path (probing a
    /// tailnet path only once the gate passes, spec §9.2), then [`gate`] with the confirmation that counts.
    /// `earlier_private` says that the previous check of this open found the target not public.
    pub async fn check_open(
        &self,
        store: &TransportStore,
        row: &Connection,
        purpose: &str,
        earlier_private: bool,
    ) -> Result<CheckedTarget, TransportError> {
        let input = match Self::target(store, row, None) {
            Ok(input) => input,
            Err(e) => {
                self.log(purpose, None, Some(e));
                return Err(e);
            }
        };
        let ack = self.ack(store, row);
        let mut checked = match check_target_acked(&input, &self.deps, true, ack.as_ref()).await {
            Ok(checked) => checked,
            Err(e) => {
                self.log(purpose, None, Some(e));
                return Err(e);
            }
        };
        if let Err(e) = gate(&checked.report, ack.as_ref()) {
            if earlier_private || Self::stored_private(store, row) {
                Self::mark_changed(&mut checked.report);
            }
            self.log(purpose, Some(&checked.report), Some(e));
            return Err(e);
        }
        self.log(purpose, Some(&checked.report), None);
        Ok(checked)
    }

    /// The check before a reconnect of the status or trust stream, shared (spec §5.4): while one re-check of a
    /// connection runs, a second caller waits for it and takes its result instead of starting another lookup or
    /// probe. The next reconnect after it starts a fresh check.
    pub async fn recheck_shared(
        &self,
        store: &TransportStore,
        row: &Connection,
        earlier_private: bool,
    ) -> Recheck {
        let cell = lock(&self.inflight)
            .entry(row.id)
            .or_insert_with(|| Arc::new(tokio::sync::OnceCell::new()))
            .clone();
        let result = cell
            .get_or_init(|| self.recheck(store, row, earlier_private))
            .await
            .clone();
        let mut inflight = lock(&self.inflight);
        if inflight.get(&row.id).is_some_and(|c| Arc::ptr_eq(c, &cell)) {
            inflight.remove(&row.id);
        }
        result
    }

    /// The gate of `open_connection` (spec §7.1, §9.2): the row from `connections.json` and, for a remote row, its
    /// fresh check and effective path, before any harness contact. A public target without a valid confirmation is
    /// `transport-confirm-needed`; bundled and local rows have no transport.
    pub async fn open_check(
        &self,
        connections: &crate::connections::Store,
        store: &TransportStore,
        id: Uuid,
    ) -> Result<(Connection, Option<(CheckedTarget, Transport)>), String> {
        let row = connections
            .load()
            .map_err(|_| "storage")?
            .into_iter()
            .find(|c| c.id == id)
            .ok_or("invalid")?;
        if row.kind != crate::connections::Kind::Remote {
            return Ok((row, None));
        }
        let checked = self
            .check_open(store, &row, "open", false)
            .await
            .map_err(|e| e.code().to_owned())?;
        let transport = store.effective(&row).transport;
        Ok((row, Some((checked, transport))))
    }

    /// The check before an events reconnect (spec §9.2).
    pub async fn recheck(
        &self,
        store: &TransportStore,
        row: &Connection,
        earlier_private: bool,
    ) -> Recheck {
        match self
            .check_open(store, row, "reconnect", earlier_private)
            .await
        {
            Ok(checked) => Recheck::Pinned(checked),
            Err(TransportError::ConfirmNeeded) => {
                Recheck::Attention(if earlier_private || Self::stored_private(store, row) {
                    "target-changed-public"
                } else {
                    "transport-confirm-needed"
                })
            }
            Err(_) => Recheck::Retry,
        }
    }

    /// Runs one shell check for `window` (spec §5.4): a newer check of the same window supersedes this one, which then
    /// ends at once with [`TransportError::Busy`] (dropping its lookup or probe).
    pub async fn check_for_window<T>(
        &self,
        window: &str,
        check: impl std::future::Future<Output = Result<T, TransportError>>,
    ) -> Result<T, TransportError> {
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let mut receiver = {
            let mut windows = lock(&self.windows);
            let sender = windows
                .entry(window.to_owned())
                .or_insert_with(|| watch::channel(0).0);
            sender.send_replace(generation);
            sender.subscribe()
        };
        let superseded = async move {
            loop {
                if receiver.changed().await.is_err() {
                    std::future::pending::<()>().await;
                }
                if *receiver.borrow() != generation {
                    return;
                }
            }
        };
        let result = tokio::select! {
            biased;
            () = superseded => return Err(TransportError::Busy),
            result = check => result,
        };
        let current = lock(&self.windows)
            .get(window)
            .map(|sender| *sender.borrow());
        if current != Some(generation) {
            return Err(TransportError::Busy);
        }
        result
    }

    /// The advisory check of the shell's check panel (spec §7.1): it probes a tailnet path to verify it, but only
    /// when the target passes the gate (a public target is probed only under a valid confirmation of this row's
    /// unchanged path, and never at a public address). A name that does not resolve is a notice here (the person may
    /// be offline or outside the VPN, spec §6.2); invalid input stays an error. With `row`, the confirmation that
    /// counts for it decides whether a public target is reported as having become public.
    pub async fn check_input(
        &self,
        input: &TargetInput,
        row: Option<(&TransportStore, &Connection)>,
    ) -> Result<TransportReport, TransportError> {
        let ack = row.and_then(|(store, row)| {
            (store.effective(row).transport == input.transport)
                .then(|| self.ack(store, row))
                .flatten()
        });
        let report = match check_target_acked(input, &self.deps, true, ack.as_ref()).await {
            Ok(checked) => {
                let mut report = checked.report;
                if let Some((store, row)) = row {
                    let unchanged = store.effective(row).transport == input.transport;
                    if unchanged
                        && gate(&report, ack.as_ref()).is_err()
                        && Self::stored_private(store, row)
                    {
                        Self::mark_changed(&mut report);
                    }
                }
                report
            }
            Err(e @ (TransportError::Unresolved | TransportError::DnsTimeout)) => {
                unresolved(e, &input.host)
            }
            Err(e) => {
                self.log("check", None, Some(e));
                return Err(e);
            }
        };
        self.log("check", Some(&report), None);
        Ok(report)
    }

    /// The check of `pair_code` (spec §7.1): Rust re-runs the check before any TCP connection to the harness. The
    /// person's confirmation is honoured only when this fresh report needs it.
    pub async fn check_pair(
        &self,
        origin: &Origin,
        transport: Transport,
        public_ack: bool,
    ) -> Result<CheckedTarget, TransportError> {
        let checked = async {
            let (host, port) = HostInput::from_origin(origin)?;
            let input = TargetInput {
                host,
                port,
                transport,
                purpose: Purpose::Remote,
            };
            check_target(&input, &self.deps, false).await
        }
        .await;
        let checked = match checked {
            Ok(checked) => checked,
            Err(e) => {
                self.log("pair", None, Some(e));
                return Err(e);
            }
        };
        let ack = public_ack.then(PublicAck::now);
        let gated = gate(&checked.report, ack.as_ref());
        self.log("pair", Some(&checked.report), gated.err());
        gated.map(|()| checked)
    }

    /// After a pairing: stores the chosen path and, for a public target, the confirmation the pairing was gated with.
    pub fn record_pairing(
        &self,
        store: &TransportStore,
        row: &Connection,
        transport: Transport,
        report: &TransportReport,
    ) -> Result<(), TransportStoreError> {
        let ack = report.needs_public_ack.then(PublicAck::now);
        self.persist(store, row, transport, ack)
    }

    /// *Weg ändern…* and *Bestätigen und verbinden* (spec §7.1): a fresh check of `transport`; a confirmation is
    /// stored only when that check says the target is public. A transport change clears an earlier confirmation; an
    /// unchanged transport keeps a valid one. A public target without a confirmation is refused with
    /// `transport-confirm-needed` and nothing is written. While the store cannot persist, a confirmation is held for
    /// this session, and a transport change is refused (`transport-store-readonly`).
    pub async fn set_transport(
        &self,
        store: &TransportStore,
        row: &Connection,
        transport: Transport,
        public_ack: bool,
    ) -> Result<TransportReport, &'static str> {
        let changed = transport != store.effective(row).transport;
        if changed && self.cannot_persist(store) {
            return Err(TransportStoreError::ReadOnly.code());
        }
        let input = Self::target(store, row, Some(transport)).map_err(|e| e.code())?;
        let report = match check_target(&input, &self.deps, false).await {
            Ok(checked) => checked.report,
            Err(e @ (TransportError::Unresolved | TransportError::DnsTimeout)) => {
                // Nothing was seen of the target: an unchanged path keeps its entry (and a valid confirmation) as
                // it is; a changed path is stored without a confirmation.
                let report = unresolved(e, &input.host);
                self.log("set", Some(&report), None);
                if !changed {
                    return Ok(report);
                }
                return match self.persist(store, row, transport, None) {
                    Ok(())
                    | Err(
                        TransportStoreError::ReadOnly
                        | TransportStoreError::Io
                        | TransportStoreError::TooLarge,
                    ) => Ok(report),
                    Err(e) => Err(e.code()),
                };
            }
            Err(e) => {
                self.log("set", None, Some(e));
                return Err(e.code());
            }
        };
        let kept = if changed {
            None
        } else {
            self.ack(store, row)
                .filter(|a| a.classifier == CLASSIFIER_ID)
        };
        let ack = match (report.needs_public_ack, public_ack, kept) {
            (false, _, _) => None,
            (true, true, _) => Some(PublicAck::now()),
            (true, false, Some(kept)) => Some(kept),
            (true, false, None) => {
                self.log("set", Some(&report), Some(TransportError::ConfirmNeeded));
                return Err(TransportError::ConfirmNeeded.code());
            }
        };
        self.log("set", Some(&report), None);
        match self.persist(store, row, transport, ack) {
            Ok(())
            | Err(
                TransportStoreError::ReadOnly
                | TransportStoreError::Io
                | TransportStoreError::TooLarge,
            ) => Ok(report),
            Err(e) => Err(e.code()),
        }
    }

    /// Writes the entry; when that fails, a confirmation is held for this session instead (spec §3.2).
    fn persist(
        &self,
        store: &TransportStore,
        row: &Connection,
        transport: Transport,
        ack: Option<PublicAck>,
    ) -> Result<(), TransportStoreError> {
        let mut entry = store
            .get(row.id)
            .unwrap_or_else(|| TransportEntry::new(transport));
        entry.transport = transport;
        entry.public_ack = ack.clone();
        match store.set(row.id, entry) {
            Ok(()) => {
                self.write_failed.store(false, Ordering::SeqCst);
                lock(&self.session).remove(&row.id);
                Ok(())
            }
            Err(e) => {
                if matches!(e, TransportStoreError::Io | TransportStoreError::TooLarge) {
                    self.write_failed.store(true, Ordering::SeqCst);
                }
                let mut session = lock(&self.session);
                match ack {
                    Some(ack) => {
                        session.insert(
                            row.id,
                            SessionAck {
                                origin: row.origin.clone(),
                                transport,
                                ack,
                            },
                        );
                    }
                    None => {
                        session.remove(&row.id);
                    }
                }
                Err(e)
            }
        }
    }

    /// After a connection was removed (keychain, then metadata): its entry and session confirmation go too.
    pub fn forget(&self, store: &TransportStore, id: Uuid) {
        if let Err(e) = store.remove(id) {
            (self.log)(&format!("TRANSPORT_STORE_REMOVE_FAILED code={}", e.code()));
        }
        lock(&self.session).remove(&id);
    }

    /// One line per check (spec §9.4): purpose, category, hint codes and the refusal code. Never an address, a host,
    /// a peer, a parameter value or anything else of the Tailscale status.
    fn log(&self, purpose: &str, report: Option<&TransportReport>, error: Option<TransportError>) {
        let mut line = format!("TRANSPORT_CHECK purpose={purpose}");
        if let Some(report) = report {
            let category = report.category.map_or("none", wire_name);
            let codes: Vec<&str> = report.hints.iter().map(|h| h.code).collect();
            line.push_str(&format!(" category={category} codes={}", codes.join(",")));
            if let Some(tailscale) = &report.tailscale {
                line.push_str(&format!(" tailscale={}", tailscale.state));
            }
        }
        if let Some(error) = error {
            line.push_str(&format!(" result={}", error.code()));
        }
        (self.log)(&line);
    }
}

/// The report of a name that did not resolve: no category, one notice (spec §6.2).
fn unresolved(error: TransportError, host: &HostInput) -> TransportReport {
    TransportReport {
        category: None,
        addresses: Vec::new(),
        hints: vec![Hint::new(
            error.code(),
            Severity::Notice,
            [("host", host.to_string())].into_iter().collect(),
        )],
        tailscale: None,
        needs_public_ack: false,
        classifier: CLASSIFIER_ID,
    }
}
