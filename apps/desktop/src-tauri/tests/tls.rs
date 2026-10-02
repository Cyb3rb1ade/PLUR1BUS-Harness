use plur1bus_desktop::{
    client::{ClientError, HarnessClient},
    connections::{CertPin, Connection, Kind, Origin},
};
use plur1bus_mock_harness::{
    tls::{CompanyCa, Identity},
    MockHarness, MockOptions,
};
fn client(origin: &str, pin: Option<CertPin>) -> HarnessClient {
    HarnessClient::new(Origin::parse(origin).unwrap(), pin)
        .with_trusted_roots(vec![Identity::self_signed().leaf])
}
#[tokio::test]
async fn pinned_origin_accepts_exactly_the_pinned_leaf_and_change_is_detected_before_http() {
    let identity = Identity::self_signed();
    let pin = CertPin::parse(&identity.pin()).unwrap();
    let m = MockHarness::start_tls(MockOptions::default(), identity)
        .await
        .unwrap();
    let c = client(&m.origin, Some(pin));
    c.meta().await.unwrap();
    m.control.clear_requests();
    m.control.renew_leaf(Identity::self_signed());
    assert_eq!(c.meta().await.unwrap_err(), ClientError::CertChanged);
    assert!(m.control.recorded_requests().is_empty());
}
#[tokio::test]
async fn unpinned_self_signed_is_untrusted_before_any_request() {
    let m = MockHarness::start_tls(MockOptions::default(), Identity::self_signed())
        .await
        .unwrap();
    assert_eq!(
        client(&m.origin, None).meta().await.unwrap_err(),
        ClientError::Untrusted
    );
    assert!(m.control.recorded_requests().is_empty());
}
#[tokio::test]
async fn pair_proof_pins_on_match_and_never_sends_the_code_on_relay_mismatch() {
    let m = MockHarness::start_tls(MockOptions::default(), Identity::self_signed())
        .await
        .unwrap();
    let code = m.control.create_pair_code();
    let mut c = client(&m.origin, None);
    c.establish_pairing_trust(&code).await.unwrap();
    c.redeem(&code, "Desk").await.unwrap();
    let code = m.control.create_pair_code();
    m.control
        .proof_for_wrong_leaf(Identity::self_signed().pin());
    m.control.clear_requests();
    assert_eq!(
        client(&m.origin, None)
            .establish_pairing_trust(&code)
            .await
            .unwrap_err(),
        ClientError::ProofMismatch
    );
    assert!(m
        .control
        .recorded_requests()
        .iter()
        .all(|(path, auth)| path == plur1bus_desktop_contract::trust::PAIR_PROOF && !auth));
}
#[tokio::test]
async fn company_ca_verifies_normal_chain_and_renewal_and_refuses_substitution() {
    let ca = CompanyCa::new();
    let m = MockHarness::start_tls(MockOptions::default(), ca.issue())
        .await
        .unwrap();
    assert_eq!(
        client(&m.origin, None).meta().await.unwrap_err(),
        ClientError::CaNotKnown
    );
    let code = m.control.create_pair_code();
    let mut c = client(&m.origin, None);
    c.establish_pairing_trust(&code).await.unwrap();
    m.control.renew_leaf(ca.issue());
    c.meta().await.unwrap();
    m.control
        .renew_leaf(ca.issue_for(vec!["different.harness.test".into()]));
    assert_eq!(c.meta().await.unwrap_err(), ClientError::CaNotKnown);
    m.control.renew_leaf(ca.issue());
    m.control.wrong_ca_response();
    assert_eq!(
        client(&m.origin, None)
            .establish_pairing_trust(&code)
            .await
            .unwrap_err(),
        ClientError::TrustUnavailable
    );
}
#[tokio::test]
async fn rollover_cert_to_ca_and_ca_to_cert_is_authenticated_and_promoted() {
    for company_first in [false, true] {
        let ca = CompanyCa::new();
        let initial = if company_first {
            ca.issue()
        } else {
            Identity::self_signed()
        };
        let m = MockHarness::start_tls(MockOptions::default(), initial)
            .await
            .unwrap();
        let code = m.control.create_pair_code();
        let mut c = client(&m.origin, None);
        c.establish_pairing_trust(&code).await.unwrap();
        let token = c.redeem(&code, "Desk").await.unwrap();
        let mut row = Connection::new(
            "Desk".into(),
            Kind::Remote,
            Origin::parse(&m.origin).unwrap(),
            m.installation_id.clone(),
            token.device_id,
            "hint".into(),
        );
        c.apply_pairing_trust(&mut row);
        let missed = row.clone();
        let next = if company_first {
            Identity::self_signed()
        } else {
            ca.issue()
        };
        m.control.stage_trust(next);
        c.refresh_trust(&mut row, &token.token).await.unwrap();
        c.ack_trust(&row, &token.token).await.unwrap();
        assert_eq!(m.control.trust_ack_count(), 1);
        assert!(m
            .control
            .recorded_requests()
            .iter()
            .filter(|(p, _)| p.contains("/trust"))
            .all(|(_, auth)| *auth));
        let c = HarnessClient::from_connection_with_roots(&row, vec![Identity::self_signed().leaf])
            .await
            .unwrap();
        c.whoami(&m.installation_id, &token.token).await.unwrap();
        m.control.switch_trust();
        c.whoami(&m.installation_id, &token.token).await.unwrap();
        c.refresh_trust(&mut row, &token.token).await.unwrap();
        assert!(row.next_ca_pin.is_none() && row.next_cert_pin.is_none());
        assert_eq!(row.cert_pin.is_some(), company_first);
        let old =
            HarnessClient::from_connection_with_roots(&missed, vec![Identity::self_signed().leaf])
                .await
                .unwrap();
        assert!(matches!(
            old.meta().await,
            Err(ClientError::CertChanged | ClientError::CaNotKnown)
        ));
    }
}
#[tokio::test]
async fn os_trusted_origin_skips_pair_proof_with_injected_roots_only() {
    let ca = CompanyCa::new();
    let identity = ca.issue();
    let root = identity.ca.clone().unwrap();
    let m = MockHarness::start_tls(MockOptions::default(), identity)
        .await
        .unwrap();
    let code = m.control.create_pair_code();
    let mut c =
        HarnessClient::new(Origin::parse(&m.origin).unwrap(), None).with_trusted_roots(vec![root]);
    c.establish_pairing_trust(&code).await.unwrap();
    assert!(!m
        .control
        .recorded_requests()
        .iter()
        .any(|(p, _)| p.contains("pair-proof")));
}
#[tokio::test]
async fn substituted_ca_and_replaced_or_expired_offer_never_disclose_code() {
    let ca = CompanyCa::new();
    let m = MockHarness::start_tls(MockOptions::default(), ca.issue())
        .await
        .unwrap();
    let old = m.control.create_pair_code();
    let current = m.control.create_pair_code();
    assert_eq!(
        client(&m.origin, None)
            .establish_pairing_trust(&old)
            .await
            .unwrap_err(),
        ClientError::ProofMismatch
    );
    m.control
        .proof_with_substituted_ca(Identity::self_signed().pin());
    assert_eq!(
        client(&m.origin, None)
            .establish_pairing_trust(&current)
            .await
            .unwrap_err(),
        ClientError::ProofMismatch
    );
    assert!(!m
        .control
        .recorded_requests()
        .iter()
        .any(|(p, _)| p.ends_with("/redeem")));
}
#[tokio::test]
async fn authenticated_sse_trust_event_triggers_same_secure_sync() {
    let m = MockHarness::start_tls(MockOptions::default(), Identity::self_signed())
        .await
        .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let store = plur1bus_desktop::connections::Store::open(dir.path());
    let tokens = plur1bus_desktop::secrets::MemoryStore::default();
    let code = m.control.create_pair_code();
    let mut row = plur1bus_desktop::pair::pair_using_client(
        client(&m.origin, None),
        &code,
        "Desk",
        Kind::Remote,
        None,
        None,
        &tokens,
        &store,
    )
    .await
    .unwrap();
    let control = m.control.clone();
    let announcement = async move {
        for _ in 0..100 {
            if control
                .recorded_requests()
                .iter()
                .any(|(p, a)| p == "/events" && *a)
            {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                control.stage_trust(CompanyCa::new().issue());
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("event subscription missing")
    };
    let event_client =
        HarnessClient::from_connection_with_roots(&row, vec![Identity::self_signed().leaf])
            .await
            .unwrap();
    let (result, ()) = tokio::join!(
        plur1bus_desktop::pair::sync_next_trust_event_with_client(
            &mut row,
            event_client,
            &tokens,
            &store
        ),
        announcement
    );
    result.unwrap();
    assert!(store.load().unwrap()[0].next_ca_pin.is_some());
    assert_eq!(m.control.trust_ack_count(), 1);
}
#[tokio::test]
async fn expired_proof_offer_never_sends_code() {
    use std::sync::{
        atomic::{AtomicI64, Ordering},
        Arc,
    };
    let clock = Arc::new(AtomicI64::new(1000));
    let m = MockHarness::start_tls(
        MockOptions {
            clock: clock.clone(),
            ..Default::default()
        },
        Identity::self_signed(),
    )
    .await
    .unwrap();
    let code = m.control.create_pair_code();
    clock.store(5000, Ordering::SeqCst);
    assert!(client(&m.origin, None)
        .establish_pairing_trust(&code)
        .await
        .is_err());
    assert!(!m
        .control
        .recorded_requests()
        .iter()
        .any(|(p, _)| p.ends_with("/redeem")));
}
#[tokio::test]
async fn sse_event_cannot_inject_a_pin_detached_from_authenticated_trust_document() {
    let m = MockHarness::start_tls(MockOptions::default(), Identity::self_signed())
        .await
        .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let store = plur1bus_desktop::connections::Store::open(dir.path());
    let tokens = plur1bus_desktop::secrets::MemoryStore::default();
    let code = m.control.create_pair_code();
    let mut row = plur1bus_desktop::pair::pair_using_client(
        client(&m.origin, None),
        &code,
        "Desk",
        Kind::Remote,
        None,
        None,
        &tokens,
        &store,
    )
    .await
    .unwrap();
    let control = m.control.clone();
    let event = async move {
        for _ in 0..100 {
            if control
                .recorded_requests()
                .iter()
                .any(|(p, a)| p == "/events" && *a)
            {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                control.announce_unapplied_trust(plur1bus_desktop_contract::trust::Trust {
                    next_cert_pin: Some(Identity::self_signed().pin()),
                    ..Default::default()
                });
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("subscription missing")
    };
    let event_client =
        HarnessClient::from_connection_with_roots(&row, vec![Identity::self_signed().leaf])
            .await
            .unwrap();
    let (result, ()) = tokio::join!(
        plur1bus_desktop::pair::sync_next_trust_event_with_client(
            &mut row,
            event_client,
            &tokens,
            &store
        ),
        event
    );
    result.unwrap();
    assert!(row.next_cert_pin.is_none());
    assert_eq!(m.control.trust_ack_count(), 0);
    let requests = m.control.recorded_requests();
    for index in 0..requests.len() {
        if requests[index].1 {
            assert!(index > 0 && requests[index - 1].0.ends_with("/meta"));
        }
    }
}
#[tokio::test]
async fn new_pairing_during_staged_rollover_stores_both_trusts_before_ack() {
    let m = MockHarness::start_tls(MockOptions::default(), Identity::self_signed())
        .await
        .unwrap();
    m.control.stage_trust(CompanyCa::new().issue());
    let code = m.control.create_pair_code();
    let dir = tempfile::tempdir().unwrap();
    let store = plur1bus_desktop::connections::Store::open(dir.path());
    let tokens = plur1bus_desktop::secrets::MemoryStore::default();
    let row = plur1bus_desktop::pair::pair_using_client(
        client(&m.origin, None),
        &code,
        "Desk",
        Kind::Remote,
        None,
        None,
        &tokens,
        &store,
    )
    .await
    .unwrap();
    assert!(row.cert_pin.is_some() && row.next_ca_pin.is_some());
    assert_eq!(m.control.trust_ack_count(), 1);
    assert_eq!(store.load().unwrap()[0], row);
}
#[tokio::test]
async fn company_ca_pin_is_anchor_for_this_origin_only() {
    let ca = CompanyCa::new();
    let one = MockHarness::start_tls(MockOptions::default(), ca.issue())
        .await
        .unwrap();
    let two = MockHarness::start_tls(MockOptions::default(), ca.issue())
        .await
        .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let store = plur1bus_desktop::connections::Store::open(dir.path());
    let tokens = plur1bus_desktop::secrets::MemoryStore::default();
    let mut row = plur1bus_desktop::pair::pair_using_client(
        client(&one.origin, None),
        &one.control.create_pair_code(),
        "Desk",
        Kind::Remote,
        None,
        None,
        &tokens,
        &store,
    )
    .await
    .unwrap();
    assert!(row.ca_pin.is_some());
    // A connection carrying company trust cannot be passed to another origin's
    // client for authenticated refresh/ack; no second-origin request is made.
    use plur1bus_desktop::secrets::TokenStore;
    let token = tokens
        .get(&plur1bus_desktop::secrets::token_account(row.id))
        .unwrap()
        .unwrap();
    let other = client(&two.origin, None);
    assert_eq!(
        other.refresh_trust(&mut row, &token).await.unwrap_err(),
        ClientError::Protocol
    );
    assert_eq!(
        other.ack_trust(&row, &token).await.unwrap_err(),
        ClientError::Protocol
    );
    assert_eq!(other.meta().await.unwrap_err(), ClientError::CaNotKnown);
    assert!(two.control.recorded_requests().is_empty());
}

#[tokio::test]
async fn revoked_on_trust_ack_removes_credential_and_marks_pairing_needed() {
    use plur1bus_desktop::secrets::TokenStore;
    let m = MockHarness::start_tls(MockOptions::default(), Identity::self_signed())
        .await
        .unwrap();
    m.control.stage_trust(CompanyCa::new().issue());
    m.control
        .revoke_after_route(plur1bus_desktop_contract::trust::TRUST);
    let code = m.control.create_pair_code();
    let dir = tempfile::tempdir().unwrap();
    let store = plur1bus_desktop::connections::Store::open(dir.path());
    let tokens = plur1bus_desktop::secrets::MemoryStore::default();
    let error = plur1bus_desktop::pair::pair_using_client(
        client(&m.origin, None),
        &code,
        "Desk",
        Kind::Remote,
        None,
        None,
        &tokens,
        &store,
    )
    .await
    .unwrap_err();
    assert_eq!(error.code(), "revoked");
    let rows = store.load().unwrap();
    assert!(rows[0].pairing_needed);
    assert!(tokens
        .get(&plur1bus_desktop::secrets::token_account(rows[0].id))
        .unwrap()
        .is_none());
    assert_eq!(m.control.trust_ack_count(), 0);
}

#[tokio::test]
async fn rollover_candidates_survive_unavailable_other_ca() {
    for company_first in [true, false] {
        let ca = CompanyCa::new();
        let initial = if company_first {
            ca.issue()
        } else {
            Identity::self_signed()
        };
        let m = MockHarness::start_tls(MockOptions::default(), initial)
            .await
            .unwrap();
        let code = m.control.create_pair_code();
        let mut c = client(&m.origin, None);
        c.establish_pairing_trust(&code).await.unwrap();
        let redeemed = c.redeem(&code, "Desk").await.unwrap();
        let mut row = Connection::new(
            "Desk".into(),
            Kind::Remote,
            Origin::parse(&m.origin).unwrap(),
            m.installation_id.clone(),
            redeemed.device_id,
            "hint".into(),
        );
        c.apply_pairing_trust(&mut row);
        m.control.stage_trust(if company_first {
            Identity::self_signed()
        } else {
            ca.issue()
        });
        c.refresh_trust(&mut row, &redeemed.token).await.unwrap();
        if company_first {
            m.control.switch_trust();
        }
        // The CA candidate is unavailable; the independently pinned leaf remains valid.
        m.control.wrong_ca_response();
        let c = HarnessClient::from_connection_with_roots(&row, vec![Identity::self_signed().leaf])
            .await
            .unwrap();
        c.whoami(&m.installation_id, &redeemed.token).await.unwrap();
        c.refresh_trust(&mut row, &redeemed.token).await.unwrap();
        m.control.renew_leaf(Identity::self_signed());
        m.control.clear_requests();
        assert_eq!(
            c.whoami(&m.installation_id, &redeemed.token)
                .await
                .unwrap_err(),
            ClientError::TrustUnavailable
        );
        assert!(m.control.recorded_requests().is_empty());
    }
}

#[tokio::test]
async fn current_or_next_accepted_until_switch_with_os_trusted_current() {
    let identity = CompanyCa::new().issue();
    let roots = vec![identity.ca.clone().unwrap()];
    let m = MockHarness::start_tls(MockOptions::default(), identity)
        .await
        .unwrap();
    m.control.advertise_os_trust();
    let dir = tempfile::tempdir().unwrap();
    let store = plur1bus_desktop::connections::Store::open(dir.path());
    let tokens = plur1bus_desktop::secrets::MemoryStore::default();
    use plur1bus_desktop::secrets::TokenStore;
    let mut row = plur1bus_desktop::pair::pair_using_client(
        HarnessClient::new(Origin::parse(&m.origin).unwrap(), None)
            .with_trusted_roots(roots.clone()),
        &m.control.create_pair_code(),
        "Desk",
        Kind::Remote,
        None,
        None,
        &tokens,
        &store,
    )
    .await
    .unwrap();
    assert!(row.cert_pin.is_none() && row.ca_pin.is_none());
    let token = tokens
        .get(&plur1bus_desktop::secrets::token_account(row.id))
        .unwrap()
        .unwrap();
    let next = Identity::self_signed();
    let pin = CertPin::parse(&next.pin()).unwrap();
    m.control.stage_trust(next);
    let c = HarnessClient::from_connection_with_roots(&row, roots.clone())
        .await
        .unwrap();
    c.refresh_trust(&mut row, &token).await.unwrap();
    c.ack_trust(&row, &token).await.unwrap();
    let c = HarnessClient::from_connection_with_roots(&row, roots)
        .await
        .unwrap();
    c.whoami(&m.installation_id, &token).await.unwrap();
    m.control.switch_trust();
    c.whoami(&m.installation_id, &token).await.unwrap();
    c.refresh_trust(&mut row, &token).await.unwrap();
    assert_eq!(row.cert_pin, Some(pin));
    assert!(row.next_cert_pin.is_none());
}
#[tokio::test]
async fn changed_certificate_is_cert_changed_and_marks_pairing_needed() {
    let identity = Identity::self_signed();
    let original = CertPin::parse(&identity.pin()).unwrap();
    let m = MockHarness::start_tls(MockOptions::default(), identity)
        .await
        .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let store = plur1bus_desktop::connections::Store::open(dir.path());
    let tokens = plur1bus_desktop::secrets::MemoryStore::default();
    let mut row = plur1bus_desktop::pair::pair_using_client(
        client(&m.origin, None),
        &m.control.create_pair_code(),
        "Desk",
        Kind::Remote,
        None,
        None,
        &tokens,
        &store,
    )
    .await
    .unwrap();
    assert_eq!(row.cert_pin, Some(original));
    let next = Identity::self_signed();
    let observed = CertPin::parse(&next.pin()).unwrap();
    m.control.renew_leaf(next);
    m.control.clear_requests();
    assert_eq!(
        plur1bus_desktop::pair::validate_connection(&mut row, &tokens, &store)
            .await
            .unwrap_err()
            .code(),
        "cert-changed"
    );
    let stored = store.load().unwrap().remove(0);
    assert!(stored.pairing_needed);
    assert_eq!(stored.observed_cert_pin, Some(observed));
    assert!(m.control.recorded_requests().is_empty());
}
async fn ca_failure(status: u16, body: Vec<u8>, delay: u64, repair: bool) {
    let m = MockHarness::start_tls(MockOptions::default(), CompanyCa::new().issue())
        .await
        .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let store = plur1bus_desktop::connections::Store::open(dir.path());
    let tokens = plur1bus_desktop::secrets::MemoryStore::default();
    let mut row = plur1bus_desktop::pair::pair_using_client(
        client(&m.origin, None),
        &m.control.create_pair_code(),
        "Desk",
        Kind::Remote,
        None,
        None,
        &tokens,
        &store,
    )
    .await
    .unwrap();
    let pin = row.ca_pin.clone();
    m.control.ca_response(status, body, delay);
    m.control.clear_requests();
    let error = plur1bus_desktop::pair::validate_connection(&mut row, &tokens, &store)
        .await
        .unwrap_err();
    assert_eq!(
        error.code(),
        if repair {
            "ca-untrusted"
        } else {
            "trust-unavailable"
        }
    );
    let row = store.load().unwrap().remove(0);
    assert_eq!(row.pairing_needed, repair);
    assert_eq!(row.ca_pin, pin);
    assert!(m
        .control
        .recorded_requests()
        .iter()
        .all(|(p, auth)| p == plur1bus_desktop_contract::trust::CA && !auth));
}
#[tokio::test]
async fn ca_endpoint_404_is_retryable_without_repair() {
    ca_failure(404, vec![], 0, false).await;
}
#[tokio::test]
async fn ca_endpoint_5xx_is_retryable_without_repair() {
    ca_failure(503, vec![], 0, false).await;
}
#[tokio::test]
async fn ca_endpoint_timeout_is_retryable_without_repair() {
    ca_failure(200, vec![], 11000, false).await;
}
#[tokio::test]
async fn ca_endpoint_malformed_is_retryable_without_repair() {
    ca_failure(200, vec![0; 32], 0, false).await;
}
#[tokio::test]
async fn ca_endpoint_oversized_is_retryable_without_repair() {
    ca_failure(
        200,
        vec![0; plur1bus_desktop_contract::trust::MAX_CA + 1],
        0,
        false,
    )
    .await;
}
#[tokio::test]
async fn successful_wrong_ca_response_marks_repair() {
    ca_failure(200, CompanyCa::new().issue().ca.unwrap(), 0, true).await;
}

#[tokio::test]
async fn unavailable_next_ca_does_not_remove_current_os_trust() {
    let identity = CompanyCa::new().issue();
    let roots = vec![identity.ca.clone().unwrap()];
    let m = MockHarness::start_tls(MockOptions::default(), identity)
        .await
        .unwrap();
    m.control.advertise_os_trust();
    let mut row = Connection::new(
        "Desk".into(),
        Kind::Remote,
        Origin::parse(&m.origin).unwrap(),
        m.installation_id.clone(),
        "device".into(),
        "hint".into(),
    );
    let next = CompanyCa::new().issue();
    row.next_ca_pin = Some(CertPin::parse(&next.ca_pin().unwrap()).unwrap());
    m.control.stage_trust(next);
    m.control.ca_response(503, vec![], 0);
    let c = HarnessClient::from_connection_with_roots(&row, roots)
        .await
        .unwrap();
    c.meta().await.unwrap();
}
#[tokio::test]
async fn explicit_current_leaf_pin_never_falls_back_to_os_trust() {
    let identity = CompanyCa::new().issue();
    let roots = vec![identity.ca.clone().unwrap()];
    let m = MockHarness::start_tls(MockOptions::default(), identity)
        .await
        .unwrap();
    let c = HarnessClient::new(
        Origin::parse(&m.origin).unwrap(),
        Some(CertPin::parse(&Identity::self_signed().pin()).unwrap()),
    )
    .with_trusted_roots(roots);
    assert_eq!(c.meta().await.unwrap_err(), ClientError::CertChanged);
    assert!(m.control.recorded_requests().is_empty());
}

async fn staged_rollover_requiring_ca(
    company_first: bool,
) -> (
    tempfile::TempDir,
    plur1bus_mock_harness::MockHandle,
    plur1bus_desktop::secrets::MemoryStore,
    plur1bus_desktop::connections::Store,
    Connection,
) {
    let ca = CompanyCa::new();
    let initial = if company_first {
        ca.issue()
    } else {
        Identity::self_signed()
    };
    let m = MockHarness::start_tls(MockOptions::default(), initial)
        .await
        .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let store = plur1bus_desktop::connections::Store::open(dir.path());
    let tokens = plur1bus_desktop::secrets::MemoryStore::default();
    let mut row = plur1bus_desktop::pair::pair_using_client(
        client(&m.origin, None),
        &m.control.create_pair_code(),
        "Desk",
        Kind::Remote,
        None,
        None,
        &tokens,
        &store,
    )
    .await
    .unwrap();
    m.control.stage_trust(if company_first {
        Identity::self_signed()
    } else {
        ca.issue()
    });
    plur1bus_desktop::pair::validate_connection(&mut row, &tokens, &store)
        .await
        .unwrap();
    if !company_first {
        m.control.switch_trust();
    }
    (dir, m, tokens, store, row)
}
async fn rollover_ca_outage_recovers(company_first: bool, status: u16, delay: u64) {
    let (_dir, m, tokens, store, mut row) = staged_rollover_requiring_ca(company_first).await;
    let before = store.load().unwrap().remove(0);
    assert!(!before.pairing_needed);
    m.control.ca_response(status, vec![], delay);
    m.control.clear_requests();
    let error = plur1bus_desktop::pair::validate_connection(&mut row, &tokens, &store)
        .await
        .unwrap_err();
    assert_eq!(error.code(), "trust-unavailable");
    assert_eq!(
        row, before,
        "a retryable outage must not introduce a certificate-change fingerprint"
    );
    assert_eq!(
        store.load().unwrap()[0],
        before,
        "outage cannot rewrite stored trust or require pairing"
    );
    assert!(m
        .control
        .recorded_requests()
        .iter()
        .all(|(p, auth)| p == plur1bus_desktop_contract::trust::CA && !auth));
    m.control.clear_ca_response();
    plur1bus_desktop::pair::validate_connection(&mut row, &tokens, &store)
        .await
        .unwrap();
    let recovered = store.load().unwrap().remove(0);
    assert!(!recovered.pairing_needed);
    assert_eq!(
        recovered.device_id, before.device_id,
        "recovery must reuse the existing pairing"
    );
    if company_first {
        assert_eq!(recovered, before);
    } else {
        assert_eq!(recovered.ca_pin, before.next_ca_pin);
        assert!(recovered.cert_pin.is_none() && recovered.next_ca_pin.is_none());
    }
}
#[tokio::test]
async fn current_ca_before_switch_404_is_retryable_and_recovers_without_pairing() {
    rollover_ca_outage_recovers(true, 404, 0).await;
}
#[tokio::test]
async fn current_ca_before_switch_503_is_retryable_and_recovers_without_pairing() {
    rollover_ca_outage_recovers(true, 503, 0).await;
}
#[tokio::test]
async fn current_ca_before_switch_timeout_is_retryable_and_recovers_without_pairing() {
    rollover_ca_outage_recovers(true, 200, 11000).await;
}
#[tokio::test]
async fn next_ca_after_switch_404_is_retryable_and_recovers_without_pairing() {
    rollover_ca_outage_recovers(false, 404, 0).await;
}
#[tokio::test]
async fn next_ca_after_switch_503_is_retryable_and_recovers_without_pairing() {
    rollover_ca_outage_recovers(false, 503, 0).await;
}
#[tokio::test]
async fn next_ca_after_switch_timeout_is_retryable_and_recovers_without_pairing() {
    rollover_ca_outage_recovers(false, 200, 11000).await;
}
#[tokio::test]
async fn valid_wrong_ca_during_rollover_still_requires_repair() {
    for company_first in [true, false] {
        let (_dir, m, tokens, store, mut row) = staged_rollover_requiring_ca(company_first).await;
        m.control
            .ca_response(200, CompanyCa::new().issue().ca.unwrap(), 0);
        m.control.clear_requests();
        let error = plur1bus_desktop::pair::validate_connection(&mut row, &tokens, &store)
            .await
            .unwrap_err();
        assert!(matches!(error.code(), "cert-changed" | "ca-untrusted"));
        assert!(store.load().unwrap()[0].pairing_needed);
        assert!(m.control.recorded_requests().iter().all(|(_, auth)| !auth));
    }
}
#[tokio::test]
async fn fully_available_rollover_trust_rejects_unknown_leaf_and_requires_repair() {
    for company_first in [true, false] {
        let (_dir, m, tokens, store, mut row) = staged_rollover_requiring_ca(company_first).await;
        m.control.renew_leaf(Identity::self_signed());
        m.control.clear_requests();
        let error = plur1bus_desktop::pair::validate_connection(&mut row, &tokens, &store)
            .await
            .unwrap_err();
        assert!(matches!(error.code(), "cert-changed" | "ca-untrusted"));
        assert!(store.load().unwrap()[0].pairing_needed);
        assert!(m.control.recorded_requests().iter().all(|(_, auth)| !auth));
    }
}
