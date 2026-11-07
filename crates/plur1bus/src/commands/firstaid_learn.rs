//! Append-only learning checks. Native permission inspection plus the resident Core's SQLite probe.
use super::firstaid::Check;
use crate::paths::Layout;
use serde_json::Value;
const IDS: [&str; 3] = [
    "dreams.learn.store",
    "dreams.learn.breaker",
    "dreams.learn.backlog",
];

pub(crate) fn checks(layout: &Layout, health: Option<&Value>) -> Vec<Check> {
    let file = layout.home.join("state/dreams/learn.db");
    if !file.exists() {
        return IDS
            .iter()
            .map(|id| Check::skip(id, "learning store has not been created"))
            .collect();
    }
    let permissions = private(&file) && file.parent().is_some_and(private);
    let Some(h) = health else {
        let store = if permissions {
            Check::warn(
                IDS[0],
                "permissions are private; Core schema and integrity probe unavailable",
                None,
                None,
            )
        } else {
            Check::fail(
                IDS[0],
                "learning store permissions are not private",
                None,
                None,
            )
        };
        return vec![
            store,
            Check::skip(IDS[1], "Core learning probe unavailable"),
            Check::skip(IDS[2], "Core learning probe unavailable"),
        ];
    };
    let valid = h["schema"].as_u64() == Some(7) && h["integrity"].as_bool() == Some(true);
    let store = if valid && permissions {
        Check::ok(
            IDS[0],
            "schema 7, SQLite integrity and private permissions verified",
        )
    } else {
        Check::fail(
            IDS[0],
            "learning schema, integrity or private permissions failed",
            None,
            None,
        )
    };
    let breaker = match h["breakers"].as_u64() {
        Some(0) => Check::ok(IDS[1], "no open learning breakers"),
        Some(n) => Check::warn(IDS[1], format!("{n} open learning breaker(s)"), None, None),
        None => Check::skip(IDS[1], "learning breaker state unavailable"),
    };
    let backlog = match (h["pending"].as_u64(), h["waitingH3"].as_u64()) {
        (Some(0), Some(0)) => Check::ok(IDS[2], "no pending learning findings"),
        (Some(p), Some(w)) => Check::warn(
            IDS[2],
            format!("{p} pending, {w} waiting for H3"),
            None,
            None,
        ),
        _ => Check::skip(IDS[2], "learning backlog unavailable"),
    };
    vec![store, breaker, backlog]
}
fn private(path: &std::path::Path) -> bool {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return false;
    };
    if meta.file_type().is_symlink() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o077 == 0
    }
    #[cfg(windows)]
    {
        super::firstaid::windows_restricted_to_user_and_system(path).unwrap_or(false)
    }
    #[cfg(not(any(unix, windows)))]
    {
        false
    }
}
#[cfg(test)]
mod tests {
    use super::super::firstaid::Status;
    use super::*;
    use serde_json::json;
    #[test]
    fn learning_rows_cover_missing_healthy_breaker_backlog_and_invalid_schema() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path().to_path_buf());
        assert!(checks(&layout, None)
            .iter()
            .all(|c| c.status == Status::Skip));
        let file = dir.path().join("state/dreams/learn.db");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, b"fixture").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
            std::fs::set_permissions(
                file.parent().unwrap(),
                std::fs::Permissions::from_mode(0o700),
            )
            .unwrap();
        }
        let healthy = json!({"schema":7,"integrity":true,"pending":0,"waitingH3":0,"breakers":0});
        let rows = checks(&layout, Some(&healthy));
        assert_eq!(rows.iter().map(|c| c.id).collect::<Vec<_>>(), IDS);
        #[cfg(unix)]
        assert!(rows.iter().all(|c| c.status == Status::Ok));
        let rows = checks(
            &layout,
            Some(&json!({"schema":8,"integrity":false,"pending":2,"waitingH3":3,"breakers":1})),
        );
        assert_eq!(rows[0].status, Status::Fail);
        assert_eq!(rows[1].status, Status::Warn);
        assert_eq!(rows[2].status, Status::Warn);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
            assert_eq!(checks(&layout, Some(&healthy))[0].status, Status::Fail);
        }
    }
}
