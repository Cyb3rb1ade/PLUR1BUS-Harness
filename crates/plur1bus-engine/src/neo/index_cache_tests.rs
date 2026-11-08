//! Cache reuse must be content-proven, never inferred from size or modification time.
#![allow(clippy::unwrap_used, reason = "fixture assertions")]
use super::*;

#[test]
fn incremental_parse_reuses_complete_prefix_and_waits_for_utf8_lf_tail() {
    let cancel = Cancel::never();
    let mut cache = Cache::default();
    let initial = b"{\"id\":\"a\",\"updatedAt\":1}\n";
    assert_eq!(cache.update(initial, &cancel).unwrap(), 1);
    assert_eq!(cache.update(initial, &cancel).unwrap(), 0);
    let mut partial = initial.to_vec();
    partial.extend_from_slice(b"{\"id\":\"b\",\"statement\":\"");
    partial.push(0xc3);
    assert_eq!(cache.update(&partial, &cancel).unwrap(), 0);
    partial.extend_from_slice(b"\xa4\"}\n");
    assert_eq!(cache.update(&partial, &cancel).unwrap(), 1);
    assert_eq!(cache.rows.len(), 2);
    assert_eq!(
        field(&cache.rows[1].metadata, "statement"),
        Some(&Json::String(JsString::from("ä")))
    );
    partial.extend_from_slice(
        b"{\"id\":\"a\",\"updatedAt\":2,\"status\":\"archived\"}\n{\"id\":\"a\",\"updatedAt\":1}\n",
    );
    assert_eq!(cache.update(&partial, &cancel).unwrap(), 2);
    assert_eq!(cache.rows.len(), 2);
    assert_eq!(
        field(&cache.rows[0].metadata, "status"),
        Some(&Json::String(JsString::from("archived")))
    );
}

#[test]
fn rewrite_plus_growth_same_length_rewrite_and_truncate_reset_old_ids() {
    let cancel = Cancel::never();
    let mut cache = Cache::default();
    cache.update(b"{\"id\":\"a\"}\n", &cancel).unwrap();
    assert_eq!(
        cache
            .update(b"{\"id\":\"b\"}\n{\"id\":\"c\"}\n", &cancel)
            .unwrap(),
        2
    );
    assert_eq!(cache.rows.len(), 2);
    assert_eq!(
        record_id(&cache.rows[0].metadata),
        Some(JsString::from("b"))
    );
    assert_eq!(
        cache
            .update(b"{\"id\":\"d\"}\n{\"id\":\"e\"}\n", &cancel)
            .unwrap(),
        2
    );
    assert_eq!(
        record_id(&cache.rows[0].metadata),
        Some(JsString::from("d"))
    );
    assert_eq!(cache.update(b"{\"id\":\"f\"}\n", &cancel).unwrap(), 1);
    assert_eq!(cache.rows.len(), 1);
    assert_eq!(cache.update(b"", &cancel).unwrap(), 0);
    assert!(cache.rows.is_empty());
}

#[test]
fn cancelled_update_never_publishes_partial_cache() {
    let mut cache = Cache::default();
    cache.update(b"{\"id\":\"a\"}\n", &Cancel::never()).unwrap();
    let cancel = Cancel::never();
    cancel.cancel();
    assert!(cache.update(b"{\"id\":\"b\"}\n", &cancel).is_err());
    // update clears on every failure so a retry cannot reuse partially applied revisions.
    assert!(cache.rows.is_empty());
    assert_eq!(
        cache.update(b"{\"id\":\"b\"}\n", &Cancel::never()).unwrap(),
        1
    );
}
