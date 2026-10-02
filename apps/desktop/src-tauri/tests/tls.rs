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
        ClientError::ProofMismatch
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
async fn company_ca_pin_is_scoped_to_the_connection_origin() {
    let ca = CompanyCa::new();
    let one = MockHarness::start_tls(MockOptions::default(), ca.issue())
        .await
        .unwrap();
    let two = MockHarness::start_tls(MockOptions::default(), ca.issue())
        .await
        .unwrap();
    let code = one.control.create_pair_code();
    let mut c = client(&one.origin, None);
    c.establish_pairing_trust(&code).await.unwrap();
    c.meta().await.unwrap();
    assert_eq!(
        client(&two.origin, None).meta().await.unwrap_err(),
        ClientError::CaNotKnown
    );
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
            ClientError::CertChanged
        );
        assert!(m.control.recorded_requests().is_empty());
    }
}
