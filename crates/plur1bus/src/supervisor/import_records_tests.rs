//! Actual private records prove ticket consumption, binding and filesystem refusal without source parsing.
use super::*;
use std::sync::{Arc, Barrier};

const NOW: u64 = 1_790_000_000_123;

fn family() -> String {
    let catalog: std::collections::BTreeMap<String, Value> = serde_json::from_str(include_str!(
        "../../../../packages/core/src/import/source-catalog.json"
    ))
    .unwrap();
    catalog.into_keys().next().unwrap()
}

fn fixture() -> (tempfile::TempDir, Layout, Plan, String, Ticket) {
    let home = tempfile::tempdir().unwrap();
    let layout = Layout::new(home.path().into());
    directory(&layout, &["imports", "plans"]).unwrap();
    directory(&layout, &["imports", "preflight"]).unwrap();
    let plan = Plan {
        id: uuid::Uuid::new_v4().to_string(),
        run_id: uuid::Uuid::new_v4().to_string(),
        owner_id: "owner".into(),
        source_type: family(),
        source_sha256: "a".repeat(64),
        config_revision: "rev-1".into(),
        created_at: super::super::iso8601(NOW - 1000),
        expires_at: super::super::iso8601(NOW + 60_000),
        options: serde_json::json!({"onConflict":"skip"}),
    };
    let mut value = serde_json::to_value(&plan).unwrap();
    value["schema"] = "import.plan/1".into();
    write(&layout, &plan_path(&layout, &plan), &value).unwrap();
    let digest = super::plan(&layout, &plan.id).unwrap().1;
    let ticket = Ticket {
        schema: "import.preflight/1".into(),
        id: uuid::Uuid::new_v4().to_string(),
        plan_id: plan.id.clone(),
        run_id: plan.run_id.clone(),
        owner_id: plan.owner_id.clone(),
        operation: "apply".into(),
        plan_sha256: digest.clone(),
        source_sha256: plan.source_sha256.clone(),
        target_sha256: "b".repeat(64),
        created_at: super::super::iso8601(NOW - 1000),
        expires_at: super::super::iso8601(NOW + 60_000),
    };
    write(&layout, &ticket_path(&layout, &ticket), &ticket).unwrap();
    (home, layout, plan, digest, ticket)
}

fn plan_path(layout: &Layout, plan: &Plan) -> PathBuf {
    layout
        .home
        .join("imports/plans")
        .join(format!("{}.json", plan.id))
}

fn ticket_path(layout: &Layout, ticket: &Ticket) -> PathBuf {
    layout
        .home
        .join("imports/preflight")
        .join(format!("{}.json", ticket.id))
}

#[test]
fn simultaneous_claims_consume_exactly_one_private_ticket() {
    let (_home, layout, plan, digest, ticket) = fixture();
    let barrier = Arc::new(Barrier::new(3));
    std::thread::scope(|scope| {
        let attempt = || {
            barrier.wait();
            claim(&layout, &ticket.id, &plan, &digest, "owner", "apply", NOW).is_ok()
        };
        let one = scope.spawn(attempt);
        let two = scope.spawn(attempt);
        barrier.wait();
        assert_eq!(
            usize::from(one.join().unwrap()) + usize::from(two.join().unwrap()),
            1
        );
    });
    assert!(!ticket_path(&layout, &ticket).exists());
    assert_eq!(
        fs::read_dir(layout.home.join("imports/preflight"))
            .unwrap()
            .count(),
        0
    );
    assert!(claim(&layout, &ticket.id, &plan, &digest, "owner", "apply", NOW).is_err());
}

#[test]
fn ticket_binding_refusals_do_not_consume_the_valid_original_ticket() {
    let (_home, layout, plan, digest, ticket) = fixture();
    for field in [
        "runId",
        "planId",
        "ownerId",
        "operation",
        "planSha256",
        "sourceSha256",
        "targetSha256",
        "expiresAt",
        "extra",
    ] {
        let mut changed = serde_json::to_value(&ticket).unwrap();
        changed[field] = match field {
            "runId" | "planId" => uuid::Uuid::new_v4().to_string().into(),
            "planSha256" | "sourceSha256" => "c".repeat(64).into(),
            "expiresAt" => super::super::iso8601(NOW).into(),
            _ => "invalid".into(),
        };
        write(&layout, &ticket_path(&layout, &ticket), &changed).unwrap();
        assert!(
            claim(&layout, &ticket.id, &plan, &digest, "owner", "apply", NOW).is_err(),
            "accepted changed {field}"
        );
        assert!(ticket_path(&layout, &ticket).exists());
    }
    write(&layout, &ticket_path(&layout, &ticket), &ticket).unwrap();
    assert!(claim(&layout, &ticket.id, &plan, &digest, "owner", "apply", NOW).is_ok());
}

#[test]
fn an_impossible_calendar_date_is_not_a_live_preflight() {
    let (_home, layout, plan, digest, mut ticket) = fixture();
    ticket.created_at = "2025-02-30T12:00:00.000Z".into();
    write(&layout, &ticket_path(&layout, &ticket), &ticket).unwrap();
    assert!(claim(&layout, &ticket.id, &plan, &digest, "owner", "apply", NOW).is_err());
}

#[test]
fn unregistered_source_families_are_refused_before_worker_dispatch() {
    let (_home, layout, mut plan, _digest, _ticket) = fixture();
    plan.source_type = "unregistered-source".into();
    let mut value = serde_json::to_value(&plan).unwrap();
    value["schema"] = "import.plan/1".into();
    write(&layout, &plan_path(&layout, &plan), &value).unwrap();
    assert!(super::plan(&layout, &plan.id).is_err());
}

#[test]
fn linked_public_and_oversized_control_records_are_refused_without_reading_foreign_content() {
    let (_home, layout, plan, _digest, _ticket) = fixture();
    let path = plan_path(&layout, &plan);
    assert!(read(&layout, &path, 1).is_err());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(read(&layout, &path, MAX_RECORD).is_err());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let linked = path.with_extension("hardlink");
        fs::hard_link(&path, &linked).unwrap();
        assert!(read(&layout, &path, MAX_RECORD).is_err());
        fs::remove_file(linked).unwrap();
        fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(layout.home.join("outside"), &path).unwrap();
        assert!(read(&layout, &path, MAX_RECORD).is_err());
    }
    #[cfg(windows)]
    {
        let sid = plur1bus_rpc::win::user_sid().unwrap();
        plur1bus_rpc::win::set_path_dacl(
            &path,
            &format!("D:P(A;;GA;;;{sid})(A;;GA;;;SY)(A;;GR;;;WD)"),
        )
        .unwrap();
        assert!(read(&layout, &path, MAX_RECORD).is_err());
    }
}
