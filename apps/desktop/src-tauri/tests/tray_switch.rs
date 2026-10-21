//! The tray's connection switch (package T4b, desktop spec §6.3): a `connection:<uuid>` menu event takes the open
//! path of *Open* in the connection list (`Transports::open_gated`, T4's gate before the harness contact), a
//! connection that needs a confirmation leads to the confirm route with no harness contact, an unknown or removed
//! connection is ignored, and no handler takes ids from a webview. The resolver, Tailscale and the probe are injected;
//! the harness contact is a recording `connect`.
use futures_util::future::BoxFuture;
use plur1bus_desktop::{
    connections::{Connection, Kind, Origin, Store},
    secrets::MemoryStore,
    transport::{
        CheckDeps, CheckedTarget, ProbeOutcome, Prober, PublicAck, ResolveError, Resolver,
        TailscaleSource, TailscaleStatus, Transport, TransportEntry, TransportStore, Transports,
    },
    tray::{switch, PathLabel, SwitchOutcome, SwitchRow, TrayAction},
};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use uuid::Uuid;

/// Answers what the test set last; counts lookups.
struct Scripted {
    answer: Mutex<Vec<SocketAddr>>,
    calls: AtomicUsize,
}
impl Resolver for Scripted {
    fn lookup<'a>(
        &'a self,
        _host: &'a str,
        _port: u16,
    ) -> BoxFuture<'a, Result<Vec<SocketAddr>, ResolveError>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let answer = self.answer.lock().unwrap().clone();
        Box::pin(async move { Ok(answer) })
    }
}
struct NoTailscale;
impl TailscaleSource for NoTailscale {
    fn status(&self) -> BoxFuture<'_, TailscaleStatus> {
        Box::pin(async { TailscaleStatus::NotInstalled })
    }
}
/// Counts every probe (a TCP connection in the app).
#[derive(Default)]
struct Probes(AtomicUsize);
impl Prober for Probes {
    fn probe<'a>(&'a self, addrs: &'a [SocketAddr]) -> BoxFuture<'a, ProbeOutcome> {
        self.0.fetch_add(1, Ordering::SeqCst);
        let remote = addrs[0];
        Box::pin(async move {
            ProbeOutcome::Connected {
                local: "192.168.1.10:50000".parse().unwrap(),
                remote,
            }
        })
    }
}

/// One harness contact: the row and the addresses it would connect to.
type Contact = (Uuid, Option<Vec<SocketAddr>>);

const LAN: &str = "192.168.1.20:8443";
const PUBLIC: &str = "9.9.9.9:8443";

struct Fixture {
    dir: tempfile::TempDir,
    store: Store,
    resolver: Arc<Scripted>,
    probes: Arc<Probes>,
    transports: Transports,
    contacts: Arc<Mutex<Vec<Contact>>>,
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let resolver = Arc::new(Scripted {
            answer: Mutex::new(vec![LAN.parse().unwrap()]),
            calls: AtomicUsize::new(0),
        });
        let probes = Arc::new(Probes::default());
        let transports = Transports::new(
            CheckDeps {
                resolver: resolver.clone(),
                tailscale: Arc::new(NoTailscale),
                prober: probes.clone(),
            },
            Arc::new(|_: &str| {}),
        );
        Self {
            store: Store::open(dir.path()),
            dir,
            resolver,
            probes,
            transports,
            contacts: Arc::default(),
        }
    }
    fn tstore(&self) -> TransportStore {
        TransportStore::open(self.dir.path())
    }
    fn add(&self, name: &str, kind: Kind, origin: &str) -> Connection {
        let row = Connection::new(
            name.into(),
            kind,
            Origin::parse(origin).unwrap(),
            "synthetic".into(),
            "device".into(),
            "hint".into(),
        );
        self.store.upsert(row.clone()).unwrap();
        row
    }
    fn answer(&self, addrs: &[&str]) {
        *self.resolver.answer.lock().unwrap() = addrs.iter().map(|a| a.parse().unwrap()).collect();
    }
    /// The tray switch as `native::switch_from_tray` runs it, with a recording harness contact in place of
    /// `commands::connect_checked`.
    async fn switch(&self, id: Uuid) -> SwitchOutcome {
        let contacts = self.contacts.clone();
        switch(
            &self.transports,
            &self.store,
            &self.tstore(),
            id,
            |row: Connection, checked: Option<(CheckedTarget, Transport)>| async move {
                contacts
                    .lock()
                    .unwrap()
                    .push((row.id, checked.map(|(c, _)| c.pin.addrs)));
                Ok::<_, String>(())
            },
        )
        .await
    }
    fn contacts(&self) -> Vec<Contact> {
        self.contacts.lock().unwrap().clone()
    }
}

#[tokio::test]
async fn a_switch_opens_through_the_open_path_with_the_checked_addresses() {
    let f = Fixture::new();
    let lan = f.add("Büro", Kind::Remote, "https://buero.lan:8443");
    let bundled = f.add("Dieser Mac", Kind::Bundled, "http://127.0.0.1:18700");
    assert_eq!(f.switch(lan.id).await, SwitchOutcome::Opened);
    assert_eq!(f.switch(bundled.id).await, SwitchOutcome::Opened);
    // The remote row connects over exactly the addresses its gate checked; the bundled row has no transport check.
    assert_eq!(
        f.contacts(),
        [
            (lan.id, Some(vec![LAN.parse().unwrap()])),
            (bundled.id, None)
        ]
    );
    assert_eq!(f.resolver.calls.load(Ordering::SeqCst), 1);
    assert_eq!(SwitchOutcome::Opened.route(), None);
}

#[tokio::test]
async fn a_connection_that_needs_a_confirmation_leads_to_the_confirm_route_without_harness_contact()
{
    let f = Fixture::new();
    let public = f.add("VPS", Kind::Remote, "https://vps.example.com:8443");
    for answer in [&[PUBLIC][..], &[LAN, PUBLIC][..]] {
        f.answer(answer);
        let outcome = f.switch(public.id).await;
        assert_eq!(outcome, SwitchOutcome::ConfirmNeeded(public.id));
        assert_eq!(outcome.route(), Some("#/connections"));
    }
    assert!(f.contacts().is_empty(), "the harness was contacted");
    assert_eq!(
        f.probes.0.load(Ordering::SeqCst),
        0,
        "a public target was probed"
    );

    // After *Bestätigen und verbinden* (the confirm dialog stores the confirmation), the same switch opens.
    f.transports
        .set_transport(&f.tstore(), &public, Transport::Direct, true)
        .await
        .unwrap();
    assert_eq!(f.switch(public.id).await, SwitchOutcome::Opened);
    assert_eq!(
        f.contacts(),
        [(
            public.id,
            Some(vec![LAN.parse().unwrap(), PUBLIC.parse().unwrap()])
        )]
    );
}

#[tokio::test]
async fn an_unknown_or_removed_connection_is_ignored() {
    let f = Fixture::new();
    let lan = f.add("Büro", Kind::Remote, "https://buero.lan:8443");
    let gone = f.add("Alt", Kind::Remote, "https://alt.lan:8443");
    let offered = SwitchRow::load(&f.store, &f.transports, &f.tstore())
        .unwrap()
        .iter()
        .map(|r| r.id)
        .collect::<Vec<_>>();
    // Not offered by the menu: no action at all.
    let stranger = Uuid::now_v7();
    assert_eq!(
        TrayAction::parse(&format!("connection:{stranger}"), &offered),
        None
    );
    // Offered by a menu built before the removal: the open path finds no row and nothing happens.
    assert_eq!(
        TrayAction::parse(&format!("connection:{}", gone.id), &offered),
        Some(TrayAction::Switch(gone.id))
    );
    f.store.remove(gone.id, &MemoryStore::default()).unwrap();
    let outcome = f.switch(gone.id).await;
    assert_eq!(outcome, SwitchOutcome::Ignored);
    assert_eq!(outcome.route(), None);
    assert_eq!(f.switch(stranger).await, SwitchOutcome::Ignored);
    assert!(f.contacts().is_empty());
    assert_eq!(f.resolver.calls.load(Ordering::SeqCst), 0);
    // The rebuilt menu no longer offers it.
    let rebuilt = SwitchRow::load(&f.store, &f.transports, &f.tstore()).unwrap();
    assert_eq!(rebuilt.iter().map(|r| r.id).collect::<Vec<_>>(), [lan.id]);
}

#[tokio::test]
async fn a_failed_open_is_shown_on_the_connection() {
    let f = Fixture::new();
    let lan = f.add("Büro", Kind::Remote, "https://buero.lan:8443");
    let outcome = switch(
        &f.transports,
        &f.store,
        &f.tstore(),
        lan.id,
        |_row: Connection, _checked: Option<(CheckedTarget, Transport)>| async {
            Err::<(), _>("pairing-needed".to_owned())
        },
    )
    .await;
    assert_eq!(
        outcome,
        SwitchOutcome::Failed(lan.id, "pairing-needed".into())
    );
    assert_eq!(outcome.route(), Some("#/connections"));
    // A row that is still there but changed between the gate and the contact (`invalid` from `connect_checked`), or a
    // bundled repair without a shell window: a failure the list shows, not a silent drop.
    let changed = switch(
        &f.transports,
        &f.store,
        &f.tstore(),
        lan.id,
        |_row: Connection, _checked: Option<(CheckedTarget, Transport)>| async {
            Err::<(), _>("invalid".to_owned())
        },
    )
    .await;
    assert_eq!(changed, SwitchOutcome::Failed(lan.id, "invalid".into()));
    assert_eq!(changed.route(), Some("#/connections"));
    // An invalid origin from the gate is a failure too, not a silent switch.
    assert_eq!(
        SwitchOutcome::of::<()>(lan.id, Err("host-invalid".into())),
        SwitchOutcome::Failed(lan.id, "host-invalid".into())
    );
}

/// The switch rows come from `connections.json` (its order) and the transport store: a remote row's stored path, a
/// confirmed public target as „direkt, öffentlich“, bundled and local rows without a path.
#[test]
fn switch_rows_load_the_stored_paths() {
    let f = Fixture::new();
    let bundled = f.add("Dieser Mac", Kind::Bundled, "http://127.0.0.1:18700");
    let local = f.add("CLI", Kind::Local, "http://127.0.0.1:18799");
    let tailnet = f.add("NAS", Kind::Remote, "https://nas.tailnet.ts.net");
    let lan = f.add("Büro", Kind::Remote, "https://buero.lan:8443");
    let public = f.add("VPS", Kind::Remote, "https://vps.example.com");
    let legacy = f.add("Alt", Kind::Remote, "https://alt.lan");
    let tstore = f.tstore();
    tstore
        .set(tailnet.id, TransportEntry::new(Transport::Tailscale))
        .unwrap();
    tstore
        .set(lan.id, TransportEntry::new(Transport::Direct))
        .unwrap();
    let mut confirmed = TransportEntry::new(Transport::Direct);
    confirmed.public_ack = Some(PublicAck::now());
    tstore.set(public.id, confirmed).unwrap();
    let loaded = SwitchRow::load(&f.store, &f.transports, &tstore).unwrap();
    assert_eq!(
        loaded
            .iter()
            .map(|r| (r.id, r.name.as_str(), r.path))
            .collect::<Vec<_>>(),
        [
            (bundled.id, "Dieser Mac", None),
            (local.id, "CLI", None),
            (tailnet.id, "NAS", Some(PathLabel::Tailscale)),
            (lan.id, "Büro", Some(PathLabel::Direct)),
            (public.id, "VPS", Some(PathLabel::DirectPublic)),
            // A connection made before the transport choice: the derived default „Direkt“ (spec §3.2).
            (legacy.id, "Alt", Some(PathLabel::Direct)),
        ]
    );
    // Loading the rows is no check: nothing resolved, nothing probed.
    assert_eq!(f.resolver.calls.load(Ordering::SeqCst), 0);
    assert_eq!(f.probes.0.load(Ordering::SeqCst), 0);
}

/// No handler accepts ids from webviews: the switch and *Start/Stop harness* are native menu events, never IPC
/// commands. The app's command manifest (`APP_COMMANDS`, the generated ACL) and the shell's allow-list name no tray
/// operation, so no window can invoke one; menu ids are honoured only when the last menu offered them
/// (`tray_state.rs`).
#[test]
fn no_window_can_invoke_a_tray_action() {
    use plur1bus_desktop::commands::{allowed_command, APP_COMMANDS, SHELL_COMMANDS};
    let tray_like = |c: &str| ["tray", "switch", "menu"].iter().any(|w| c.contains(w));
    assert!(
        !APP_COMMANDS.iter().any(|c| tray_like(c)),
        "{APP_COMMANDS:?}"
    );
    assert!(!SHELL_COMMANDS.iter().any(|c| tray_like(c)));
    for window in ["shell", "approvals", "spa"] {
        for command in [
            "tray_switch",
            "switch_connection",
            "tray_menu_event",
            "harness_from_tray",
            "connect_checked",
        ] {
            assert!(!allowed_command(window, command), "{window}: {command}");
        }
    }
    // The tray's harness controls are the controller path of these two shell commands, not commands of their own.
    assert!(SHELL_COMMANDS.contains(&"harness_start") && SHELL_COMMANDS.contains(&"harness_stop"));
}
