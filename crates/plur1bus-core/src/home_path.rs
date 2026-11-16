//! The home as text, the way the TypeScript core spells it.
//!
//! Two processes derive names from the home's text: the keyring service of the secret store (`plur1bus:` and a hash of
//! the home) and, on Windows, the pipe names. The TypeScript core takes `--home` through Node's `path.resolve`
//! (`resolveHome` in `packages/core/src/paths.ts`): absolute against the working directory, `.` and `..` collapsed by
//! text alone, separators single, none at the end. `std::path::absolute` keeps a trailing separator and `..`, so a home
//! given as `/h/` would be `/h/` here and `/h` in the legacy core, and the two would look for different keyring
//! entries. This is `path.resolve` for one explicit home; the front door hands the result to the legacy core, for
//! which it is already in its own form.
//!
//! The same port as `crates/plur1bus/src/paths.rs` (`resolve_and_normalize`), which the CLI uses before it starts a
//! core, checked against the same vectors. A `~` is not expanded here: the shell or the CLI did that.

fn is_sep(windows: bool, c: char) -> bool {
    c == '/' || (windows && c == '\\')
}

fn is_absolute(windows: bool, s: &str) -> bool {
    let b = s.as_bytes();
    if windows {
        // A drive is an ASCII letter and a colon (Node: `1:\x` and `:\x` are relative paths).
        matches!(b.first(), Some(b'\\' | b'/'))
            || (b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':')
    } else {
        s.starts_with('/')
    }
}

/// The root of an absolute path (`/`; `C:\`, `\\host\share\` or `\` on Windows) and what follows it.
fn split_root(windows: bool, s: &str) -> (String, String) {
    if !windows {
        return match s.strip_prefix('/') {
            Some(rest) => ("/".to_owned(), rest.to_owned()),
            None => (String::new(), s.to_owned()),
        };
    }
    let chars: Vec<char> = s.chars().collect();
    let sep = |i: usize| chars.get(i).is_some_and(|c| is_sep(true, *c));
    // UNC and device paths: exactly two separators, a host, a share. With fewer parts, or three separators in a row, it
    // is a path from the root of the current drive, as for Node's `path.win32.resolve`.
    if chars.len() >= 3 && sep(0) && sep(1) && !sep(2) {
        let mut i = 2;
        while i < chars.len() && !sep(i) {
            i += 1;
        }
        let host: String = chars[2..i].iter().collect();
        while sep(i) {
            i += 1;
        }
        let share_start = i;
        while i < chars.len() && !sep(i) {
            i += 1;
        }
        let share: String = chars[share_start..i].iter().collect();
        if !host.is_empty() && !share.is_empty() {
            return (
                format!("\\\\{host}\\{share}\\"),
                chars[i..].iter().collect(),
            );
        }
    }
    if chars.len() >= 2 && chars[0].is_ascii_alphabetic() && chars[1] == ':' {
        let rest = if sep(2) { 3 } else { 2 };
        return (format!("{}:\\", chars[0]), chars[rest..].iter().collect());
    }
    if sep(0) {
        let mut i = 0;
        while sep(i) {
            i += 1;
        }
        return ("\\".to_owned(), chars[i..].iter().collect());
    }
    (String::new(), s.to_owned())
}

/// `path.resolve(input)` of Node for the platform `windows` names, with `cwd` as the working directory.
pub fn resolve(windows: bool, cwd: &str, input: &str) -> String {
    let sep = if windows { '\\' } else { '/' };
    let rooted_without_drive = windows
        && input.chars().next().is_some_and(|c| is_sep(true, c))
        && split_root(true, input).0 == "\\";
    let raw = if rooted_without_drive {
        // `\x` and `/x` name a place on the working directory's drive or share: its root, then the rest.
        let root = split_root(true, cwd).0;
        let root = if root.is_empty() {
            "\\".to_owned()
        } else {
            root
        };
        format!("{root}{}", split_root(true, input).1)
    } else if is_absolute(windows, input) {
        input.to_owned()
    } else {
        format!("{}{sep}{input}", cwd.trim_end_matches(sep))
    };
    let (root, rest) = split_root(windows, &raw);
    let root = if root.is_empty() {
        sep.to_string()
    } else {
        root
    };
    let mut stack: Vec<&str> = Vec::new();
    for segment in rest.split(|c| is_sep(windows, c)) {
        match segment {
            "" | "." => {}
            ".." => {
                stack.pop();
            }
            name => stack.push(name),
        }
    }
    format!("{root}{}", stack.join(&sep.to_string()))
}

/// [`resolve`] for this process: its platform and its working directory.
///
/// A home (or a working directory a relative home is resolved against) that is not Unicode text is refused: a name is
/// derived from the text, and the legacy core gets the home as an argument Node reads as text. Replacing what cannot
/// be read would run the two processes in another directory than the one that was named.
pub fn resolve_here(input: &std::path::Path) -> std::io::Result<std::path::PathBuf> {
    let not_text = |what: &str| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("{what} is not Unicode text"),
        )
    };
    let input = input.to_str().ok_or_else(|| not_text("the home"))?;
    // On POSIX an absolute home needs no working directory; on Windows a path from the root of the current drive does.
    let cwd = if cfg!(windows) || !is_absolute(false, input) {
        std::env::current_dir()?
            .to_str()
            .ok_or_else(|| not_text("the working directory"))?
            .to_owned()
    } else {
        String::new()
    };
    Ok(std::path::PathBuf::from(resolve(
        cfg!(windows),
        &cwd,
        input,
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn an_explicit_home_resolves_as_the_shared_vectors_say() {
        // The vectors of `resolveHome` (TypeScript, the CLI and the Python client share them). An explicit home takes
        // the same path whether it comes from `--home` or from the variable, so the variable's cases are this
        // function's.
        let vectors: Vec<Value> = serde_json::from_str(include_str!(
            "../../../clients/python/plur1bus-memory-client/tests/fixtures/home-vectors.json"
        ))
        .unwrap();
        let mut checked = 0;
        for v in &vectors {
            let Some(given) = v["env"]["PLUR1BUS_HOME"].as_str().filter(|s| !s.is_empty()) else {
                continue;
            };
            let windows = v["platform"] == "win32";
            assert_eq!(
                resolve(windows, v["cwd"].as_str().unwrap(), given),
                v["home"].as_str().unwrap(),
                "{v}"
            );
            checked += 1;
        }
        assert!(checked >= 6, "{checked} vectors with an explicit home");
    }

    #[test]
    fn what_std_would_keep_is_gone_as_in_node() {
        // Each expectation is what `path.posix.resolve` / `path.win32.resolve` of Node 24 returns.
        for (given, want) in [
            ("/x/y/", "/x/y"),
            ("/x/y///", "/x/y"),
            ("/x/../y/", "/y"),
            ("/x/./y", "/x/y"),
            ("//x//y", "/x/y"),
            ("/", "/"),
            ("/..", "/"),
            ("rel/", "/work/rel"),
            ("../up", "/up"),
            (".", "/work"),
        ] {
            assert_eq!(resolve(false, "/work", given), want, "{given}");
        }
        for (given, want) in [
            (r"C:\x\y\", r"C:\x\y"),
            ("C:/x/y/", r"C:\x\y"),
            (r"C:\x\..\y", r"C:\y"),
            (r"C:\", r"C:\"),
            (r"c:\Home", r"c:\Home"),
            (r"\\server\share\x\", r"\\server\share\x"),
            (r"\\server\share", r"\\server\share\"),
            (r"\x\y", r"D:\x\y"),
            ("rel", r"D:\work\rel"),
        ] {
            assert_eq!(resolve(true, r"D:\work", given), want, "{given}");
        }
    }

    #[test]
    fn the_plan_of_a_serve_has_the_home_in_that_form() {
        // What `serve` works with and passes on: no separator at the end, nothing relative, whatever was typed.
        let cwd = std::env::current_dir().unwrap();
        let args = |home: &str| crate::cli::ServeArgs {
            home: home.into(),
            lifeline: None,
            instance: None,
        };
        let typed = format!("some{0}.{0}home{0}", std::path::MAIN_SEPARATOR);
        let plan = crate::plan(&args(&typed)).unwrap();
        let home = plan.run_files.home.to_string_lossy().into_owned();
        assert_eq!(
            home,
            resolve(cfg!(windows), &cwd.to_string_lossy(), "some/home")
        );
        assert!(plan.run_files.home.is_absolute());
        assert!(!home.ends_with(['/', '\\']), "{home}");
        // The same home, typed in its own form, is the same plan: the names derived from it are the same.
        assert_eq!(
            crate::plan(&args(&home)).unwrap().run_files.home,
            plan.run_files.home
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_home_that_is_not_text_is_refused() {
        use std::os::unix::ffi::OsStrExt;
        let odd = std::ffi::OsStr::from_bytes(b"/tmp/h\xff");
        let refused = resolve_here(std::path::Path::new(odd)).unwrap_err();
        assert_eq!(refused.kind(), std::io::ErrorKind::InvalidInput);
        assert!(refused.to_string().contains("the home is not Unicode text"));
    }

    #[test]
    fn a_resolved_home_is_already_in_the_legacy_cores_form() {
        // The front door passes the result on as `--home`; the legacy core resolves it once more and must get the same
        // text, or the two derive different names from it.
        for (windows, cwd, given) in [
            (false, "/work", "/x/y/"),
            (false, "/work", "a/../b/"),
            (false, "/work", "//"),
            (true, r"D:\work", "C:/x/y/"),
            (true, r"D:\work", r"\\server\share\x\"),
            (true, r"D:\work", r"\x"),
        ] {
            let once = resolve(windows, cwd, given);
            assert_eq!(resolve(windows, "/elsewhere", &once), once, "{given}");
        }
    }
}
