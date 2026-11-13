//! `metrics/token.ts`: the metrics token. Random, persistent (a monitoring system keeps it as a secret macro, so it must
//! survive a core restart), never logged. Rotate it by deleting the file and restarting the core.
use std::fs;
use std::io;
use std::path::Path;

/// The hook that restricts the file further (Windows: the user-SID ACL, `platform.securePath`).
pub type Secure<'a> = Option<&'a dyn Fn(&Path) -> io::Result<()>>;

/// JavaScript's `String.prototype.trim` white space (`WhiteSpace` and `LineTerminator`).
fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

fn valid(token: &str) -> bool {
    token.len() == 64
        && token
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Reads a valid token and tightens its mode; `None` when the file is missing, unreadable or holds something else.
fn existing(file: &Path, secure: Secure<'_>) -> Option<String> {
    let bytes = fs::read(file).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    let token = text.trim_matches(is_js_space);
    if !valid(token) {
        return None;
    }
    // A token copied or restored with a wider mode must not stay readable by other users; not ours to change: the token
    // is still usable.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(file, fs::Permissions::from_mode(0o600));
    }
    if let Some(secure) = secure {
        // TypeScript replaces the file when this throws (the whole probe sits in one `try`).
        secure(file).ok()?;
    }
    Some(token.to_owned())
}

fn create_parent(parent: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(parent)
    }
    #[cfg(not(unix))]
    {
        fs::create_dir_all(parent)
    }
}

fn write_private(file: &Path, text: &str) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(file)?;
        f.write_all(text.as_bytes())?;
        // The mode of `open` does not apply to an existing file.
        fs::set_permissions(file, fs::Permissions::from_mode(0o600))
    }
    #[cfg(not(unix))]
    {
        fs::write(file, text)
    }
}

/// `loadOrCreateMetricsToken(file, secure)`: the token in `file` when it holds a valid one (64 lower-case hex digits),
/// else a fresh one written with mode 0600 (Unix) into a parent created with 0700. `secure` is the Windows hook.
pub fn load_or_create_metrics_token(file: &Path, secure: Secure<'_>) -> io::Result<String> {
    if let Some(token) = existing(file, secure) {
        return Ok(token);
    }
    if let Some(parent) = file.parent().filter(|p| !p.as_os_str().is_empty()) {
        create_parent(parent)?;
    }
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|_| io::Error::other("no entropy for the metrics token"))?;
    let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    write_private(file, &format!("{token}\n"))?;
    if let Some(secure) = secure {
        secure(file)?; // Windows: the user-SID ACL
    }
    Ok(token)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn is_token(t: &str) -> bool {
        valid(t)
    }

    #[test]
    fn is_created_once_random_private_and_reused() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("state").join("metrics.token");
        let t1 = load_or_create_metrics_token(&f, None).unwrap();
        assert!(is_token(&t1), "{t1}");
        assert_eq!(load_or_create_metrics_token(&f, None).unwrap(), t1);
        assert!(f.exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&f).unwrap().permissions().mode() & 0o777,
                0o600
            );
            assert_eq!(
                fs::metadata(f.parent().unwrap())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
        }
        assert_eq!(fs::read_to_string(&f).unwrap().trim(), t1);
        assert_eq!(fs::read_to_string(&f).unwrap(), format!("{t1}\n"));
        let other = dir.path().join("other.token");
        assert_ne!(load_or_create_metrics_token(&other, None).unwrap(), t1);
    }

    #[test]
    fn replaces_a_file_whose_token_is_too_short_or_not_lower_case_hex() {
        let dir = tempfile::tempdir().unwrap();
        for (i, bad) in [
            "short\n",
            &"AB".repeat(32),
            &"zz".repeat(32),
            "",
            &"ab".repeat(33),
        ]
        .iter()
        .enumerate()
        {
            let f = dir.path().join(format!("metrics{i}.token"));
            fs::write(&f, bad).unwrap();
            let t = load_or_create_metrics_token(&f, None).unwrap();
            assert!(is_token(&t), "{t}");
            assert_eq!(fs::read_to_string(&f).unwrap().trim(), t);
        }
    }

    #[test]
    fn trims_javascript_white_space_around_a_valid_token() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("metrics.token");
        let t = "ab".repeat(32);
        fs::write(&f, format!("\u{feff} {t}\r\n\t")).unwrap();
        assert_eq!(load_or_create_metrics_token(&f, None).unwrap(), t);
    }

    #[cfg(unix)]
    #[test]
    fn tightens_a_too_open_mode_on_an_existing_valid_token() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("metrics.token");
        let t = "ab".repeat(32);
        fs::write(&f, format!("{t}\n")).unwrap();
        fs::set_permissions(&f, fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(load_or_create_metrics_token(&f, None).unwrap(), t);
        assert_eq!(
            fs::metadata(&f).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_replaced_file_with_a_wide_mode_is_private_afterwards() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("metrics.token");
        fs::write(&f, "short").unwrap();
        fs::set_permissions(&f, fs::Permissions::from_mode(0o666)).unwrap();
        load_or_create_metrics_token(&f, None).unwrap();
        assert_eq!(
            fs::metadata(&f).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn the_secure_hook_runs_for_a_reused_and_for_a_created_token() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("metrics.token");
        let calls = Cell::new(0);
        let hook = |p: &Path| -> io::Result<()> {
            assert!(p.ends_with("metrics.token"));
            calls.set(calls.get() + 1);
            Ok(())
        };
        let t = load_or_create_metrics_token(&f, Some(&hook)).unwrap();
        assert_eq!(calls.get(), 1);
        assert_eq!(load_or_create_metrics_token(&f, Some(&hook)).unwrap(), t);
        assert_eq!(calls.get(), 2);
    }

    #[test]
    fn a_failing_hook_replaces_a_reused_token_and_fails_a_created_one() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("metrics.token");
        let t = "ab".repeat(32);
        fs::write(&f, format!("{t}\n")).unwrap();
        let failing = |_: &Path| -> io::Result<()> { Err(io::Error::other("acl")) };
        // The reused token's hook fails: TypeScript replaces the file, whose own hook then fails and throws.
        assert!(load_or_create_metrics_token(&f, Some(&failing)).is_err());
        assert_ne!(fs::read_to_string(&f).unwrap().trim(), t);
    }

    #[test]
    fn a_directory_in_place_of_the_file_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        assert!(load_or_create_metrics_token(dir.path(), None).is_err());
    }
}
