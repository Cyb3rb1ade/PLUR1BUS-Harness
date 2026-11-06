//! Content-free upload storage diagnostics. Reads only bounded private accounting records, never media/manifests.
use super::firstaid::Check;
use crate::paths::Layout;
use serde::Deserialize;
use std::fs;
use std::io::{self, Read};
use std::path::Path;
use std::time::Instant;

const ID: &str = "media.uploads";
const MAX_RECORD_BYTES: u64 = 512;
const MAX_RECORDS: usize = 4096;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    schema: String,
    #[serde(rename = "createdAt")]
    created_at: u64,
    bytes: u64,
    unavailable: bool,
}

pub(crate) fn check_uploads(layout: &Layout, deadline: Instant) -> Check {
    match inspect(&layout.home.join("media/outputs/.upload-index"), deadline) {
        Ok(0) => Check::ok(ID, "no unavailable uploads recorded"),
        Ok(count) => Check::warn(
            ID,
            format!("{count} upload(s) have unavailable storage; saved quota and retention metadata remain active"),
            None,
            Some("Check media storage permissions and availability; retention retries owner cleanup before removal".into()),
        ),
        Err(_) => Check::warn(
            ID,
            "upload storage diagnostics unavailable or incomplete",
            None,
            Some("Check media storage permissions and availability".into()),
        ),
    }
}

fn inspect(root: &Path, deadline: Instant) -> io::Result<usize> {
    let info = match fs::symlink_metadata(root) {
        Ok(info) => info,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error),
    };
    if !info.is_dir() {
        return Err(io::Error::other("invalid index directory"));
    }
    let mut unavailable = 0;
    for (count, entry) in fs::read_dir(root)?.enumerate() {
        if count >= MAX_RECORDS || Instant::now() >= deadline {
            return Err(io::Error::other("index scan bound reached"));
        }
        let entry = entry?;
        let name = entry.file_name();
        let name = name
            .to_str()
            .ok_or_else(|| io::Error::other("invalid index name"))?;
        // Atomic temporary records are never a published health observation.
        if name.ends_with(".tmp") {
            continue;
        }
        let id = name.strip_suffix(".json").filter(|id| {
            !id.is_empty()
                && id.len() <= 100
                && id
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
        });
        if id.is_none() {
            return Err(io::Error::other("invalid index name"));
        }
        let info = fs::symlink_metadata(entry.path())?;
        if !info.is_file() || info.len() > MAX_RECORD_BYTES {
            return Err(io::Error::other("invalid index record"));
        }
        let mut bytes = Vec::new();
        fs::File::open(entry.path())?
            .take(MAX_RECORD_BYTES + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX_RECORD_BYTES {
            return Err(io::Error::other("oversized index record"));
        }
        let record: Record = serde_json::from_slice(&bytes).map_err(io::Error::other)?;
        if record.schema != "media.upload-index/1"
            || record.created_at > 9_007_199_254_740_991
            || record.bytes > 9_007_199_254_740_991
        {
            return Err(io::Error::other("invalid index record"));
        }
        unavailable += usize::from(record.unavailable);
    }
    Ok(unavailable)
}

#[cfg(test)]
mod tests {
    use super::super::firstaid::Status;
    use super::*;
    use std::time::Duration;

    fn deadline() -> Instant {
        Instant::now() + Duration::from_secs(3)
    }

    #[test]
    fn health_is_content_free_and_distinguishes_absent_bad_and_unavailable_records() {
        let temp = tempfile::tempdir().unwrap();
        let layout = Layout::new(temp.path().to_path_buf());
        let root = layout.home.join("media/outputs/.upload-index");
        assert_eq!(check_uploads(&layout, deadline()).status, Status::Ok);
        fs::create_dir_all(&root).unwrap();
        let path = root.join("PRIVATE-UPLOAD-ID.json");
        let record =
            r#"{"schema":"media.upload-index/1","createdAt":123,"bytes":456,"unavailable":true}"#;
        fs::write(&path, record).unwrap();
        let check = check_uploads(&layout, deadline());
        assert_eq!(check.status, Status::Warn);
        assert!(check.summary.starts_with("1 upload(s)"));
        assert!(!serde_json::to_string(&check).unwrap().contains("PRIVATE"));
        fs::write(&path, record.replace("true", "false")).unwrap();
        assert_eq!(check_uploads(&layout, deadline()).status, Status::Ok);
        for invalid in [
            "PRIVATE malformed contents",
            &"x".repeat(513),
            r#"{"schema":"media.upload-index/1"}"#,
        ] {
            fs::write(&path, invalid).unwrap();
            let check = check_uploads(&layout, deadline());
            assert_eq!(check.status, Status::Warn);
            assert_eq!(
                check.summary,
                "upload storage diagnostics unavailable or incomplete"
            );
            assert!(!serde_json::to_string(&check).unwrap().contains("PRIVATE"));
        }
        assert!(inspect(&root, Instant::now()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn index_directory_and_record_symlinks_are_refused() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let outside = temp.path().join("outside");
        fs::create_dir(&outside).unwrap();
        let root = temp.path().join("index");
        symlink(&outside, &root).unwrap();
        assert!(inspect(&root, deadline()).is_err());
        fs::remove_file(&root).unwrap();
        fs::create_dir(&root).unwrap();
        let private = outside.join("private");
        fs::write(&private, "PRIVATE").unwrap();
        symlink(private, root.join("upload.json")).unwrap();
        assert!(inspect(&root, deadline()).is_err());
    }
}
