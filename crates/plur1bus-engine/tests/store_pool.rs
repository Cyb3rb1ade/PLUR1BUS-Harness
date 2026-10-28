//! Per-agent handles reuse one store and only idle cached handles may be evicted.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::PathBuf;
use std::sync::Arc;

use plur1bus_engine::contract::{StoreError, VectorSpaceIdentity};
use plur1bus_engine::store::pool::StorePool;
use plur1bus_engine::store::OpenMode;

struct Scratch {
    _guard: tempfile::TempDir,
    path: PathBuf,
}
fn scratch() -> Scratch {
    let guard = tempfile::tempdir().unwrap();
    let path = guard.path().canonicalize().unwrap();
    Scratch {
        _guard: guard,
        path,
    }
}
fn identity() -> VectorSpaceIdentity {
    serde_json::from_str(include_str!("fixtures/store-v1/identity.json")).unwrap()
}

#[test]
fn two_leases_of_one_agent_reuse_the_same_store_and_other_agents_get_distinct_handles() {
    let root = scratch();
    let pool = StorePool::open(
        &root.path.join("base"),
        OpenMode::ReadWrite,
        Some(&identity()),
        4,
    )
    .unwrap();
    let first = pool.get("a1").unwrap();
    let again = pool.get("a1").unwrap();
    let second = pool.get("a2").unwrap();
    assert!(Arc::ptr_eq(&first, &again));
    assert!(!Arc::ptr_eq(&first, &second));
}

#[test]
fn a_missing_read_only_store_creates_no_directory_or_files() {
    let root = scratch();
    let base = root.path.join("absent");
    let pool = StorePool::open(&base, OpenMode::ReadOnly, Some(&identity()), 1).unwrap();
    assert!(matches!(pool.get("a1"), Err(StoreError::Unavailable)));
    assert!(!base.exists());
    let pool = StorePool::open(&base, OpenMode::ReadWrite, None, 1).unwrap();
    assert!(matches!(pool.get("a1"), Err(StoreError::Unavailable)));
    assert!(!base.exists());
}

#[test]
fn idle_handles_are_evicted_in_lru_order() {
    let root = scratch();
    let pool = StorePool::open(
        &root.path.join("base"),
        OpenMode::ReadWrite,
        Some(&identity()),
        2,
    )
    .unwrap();
    let a = pool.get("a").unwrap();
    let a_weak = Arc::downgrade(&a);
    drop(a);
    let b = pool.get("b").unwrap();
    let b_weak = Arc::downgrade(&b);
    drop(b);
    let a = pool.get("a").unwrap();
    drop(a);
    let c = pool.get("c").unwrap();
    assert!(a_weak.upgrade().is_some());
    assert!(b_weak.upgrade().is_none());
    drop(c);
}

#[test]
fn a_soft_capacity_never_discards_leased_handles_and_prunes_them_after_release() {
    let root = scratch();
    let pool = StorePool::open(
        &root.path.join("base"),
        OpenMode::ReadWrite,
        Some(&identity()),
        1,
    )
    .unwrap();
    let a = pool.get("a").unwrap();
    let a_weak = Arc::downgrade(&a);
    let b = pool.get("b").unwrap();
    let b_weak = Arc::downgrade(&b);
    assert!(Arc::ptr_eq(&a, &pool.get("a").unwrap()));
    assert!(Arc::ptr_eq(&b, &pool.get("b").unwrap()));
    drop(a);
    let c = pool.get("c").unwrap();
    assert!(a_weak.upgrade().is_none());
    assert!(b_weak.upgrade().is_some());
    drop(b);
    assert!(Arc::ptr_eq(&c, &pool.get("c").unwrap()));
    assert!(b_weak.upgrade().is_none());
}

#[test]
fn agent_identifiers_follow_the_node_agent_rule_without_escaping_the_base() {
    let root = scratch();
    let base = root.path.join("base");
    let pool = StorePool::open(&base, OpenMode::ReadWrite, Some(&identity()), 1).unwrap();
    for bad in ["", ".", "..", "a/b", "a\\b", "a.b", "ä", &"a".repeat(65)] {
        assert!(matches!(pool.get(bad), Err(StoreError::InvalidInput)));
    }
    assert!(!base.exists());
    for good in ["-agent", "_agent", "a-b_c", "0"] {
        assert!(pool.get(good).is_ok());
        assert!(base.join(good).join("memories.lance").is_dir());
    }
    assert!(matches!(
        StorePool::open(&base, OpenMode::ReadWrite, Some(&identity()), 0),
        Err(StoreError::InvalidInput)
    ));
}

#[test]
fn concurrent_first_leases_share_one_handle() {
    let root = scratch();
    let pool = Arc::new(
        StorePool::open(
            &root.path.join("base"),
            OpenMode::ReadWrite,
            Some(&identity()),
            1,
        )
        .unwrap(),
    );
    let barrier = Arc::new(std::sync::Barrier::new(4));
    let threads = (0..4)
        .map(|_| {
            let pool = Arc::clone(&pool);
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                pool.get("shared").unwrap()
            })
        })
        .collect::<Vec<_>>();
    let stores = threads
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .collect::<Vec<_>>();
    assert!(stores.iter().all(|store| Arc::ptr_eq(&stores[0], store)));
}
