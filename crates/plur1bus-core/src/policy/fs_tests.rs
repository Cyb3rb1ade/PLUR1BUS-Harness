//! The TypeScript tests of the file-system half (`packages/core/test/policy/paths.test.ts`, `paths-hardening.test.ts`,
//! the `canonicalisePath` part of `system-tree.test.ts`) where the vectors (`fs_vectors.rs`) do not already hold the case,
//! the Rust-only answers (K2-D5 to K2-D7), and the races inside one call, which only the scripted double can produce.
//! Every test works in its own temporary directory; nothing outside it is created or written.
#![cfg_attr(not(unix), allow(unused_imports, dead_code))]

use super::*;
use crate::policy::paths::IcuNfc;
use std::cell::RefCell;
use std::path::Path;

/// A temporary tree like the one of `paths.test.ts`: `root/file.txt`, `root/sub/deep.txt`, `outside/secret.txt`.
struct Tree {
    _dir: tempfile::TempDir,
    base: String,
    ws: Vec<PathRoot>,
    home: String,
}

impl Tree {
    fn new() -> Self {
        let dir = tempfile::Builder::new()
            .prefix("p4k-fs-")
            .tempdir()
            .unwrap();
        let real = std::fs::canonicalize(dir.path())
            .unwrap()
            .to_str()
            .unwrap()
            .to_owned();
        let base = normalise_native(real, cfg!(windows));
        std::fs::create_dir_all(Path::new(&base).join("root/sub")).unwrap();
        std::fs::create_dir_all(Path::new(&base).join("outside")).unwrap();
        std::fs::write(Path::new(&base).join("root/file.txt"), "inside").unwrap();
        std::fs::write(Path::new(&base).join("root/sub/deep.txt"), "deep").unwrap();
        std::fs::write(
            Path::new(&base).join("outside/secret.txt"),
            "outside-secret",
        )
        .unwrap();
        let ws = vec![PathRoot {
            id: "ws".into(),
            path: format!("{base}/root"),
            identity: None,
        }];
        let home = format!("{base}/no-home");
        Tree {
            _dir: dir,
            base,
            ws,
            home,
        }
    }
    fn p(&self, rel: &str) -> String {
        format!("{}/{rel}", self.base)
    }
    fn roots(&self) -> Vec<PathRoot> {
        vec![PathRoot {
            id: "ws".into(),
            path: self.p("root"),
            identity: None,
        }]
    }
    fn read(&self, rel: &str) -> String {
        std::fs::read_to_string(self.p(rel)).unwrap()
    }
}

fn opts<'a>(roots: &'a [PathRoot], home: &'a str) -> CanonicaliseOptions<'a> {
    let mut o = CanonicaliseOptions::new(roots);
    o.home = Some(home);
    o
}

fn canon<'a, F: PathFs>(
    fs: &F,
    t: &'a Tree,
    input: &str,
    f: impl FnOnce(&mut CanonicaliseOptions<'a>),
) -> Result<CanonicalPath, PathRefusal> {
    let mut o = opts(&t.ws, &t.home);
    f(&mut o);
    canonicalise_path(fs, input, &o, &IcuNfc)
}

fn reason<T: std::fmt::Debug>(r: Result<T, PathRefusal>) -> &'static str {
    r.expect_err("a refusal").reason
}

fn write_flags(create: bool) -> OpenFlags {
    OpenFlags {
        create,
        ..OpenFlags::with(AccessMode::WriteOnly)
    }
}

// --- the scripted double ------------------------------------------------------------------------------------------------------

/// What the double does instead of the real call.
enum Act {
    Fail(&'static str),
    Stat(FileStat),
    Entry(EntryMeta),
    FdPath(Option<String>),
    Entries(Vec<DirEntry>),
}

type Hook<'a> = Box<dyn FnMut(&str, &str) -> Option<Act> + 'a>;

/// [`PathFs`] over the real file system, with a hook that sees every call first (operation and path) and may change the
/// tree, fail the call or answer it. It records every call, with the flags of an open.
struct Script<'a> {
    platform: &'static str,
    hook: RefCell<Hook<'a>>,
    log: RefCell<Vec<String>>,
}

impl<'a> Script<'a> {
    fn new(platform: &'static str, hook: impl FnMut(&str, &str) -> Option<Act> + 'a) -> Self {
        Script {
            platform,
            hook: RefCell::new(Box::new(hook)),
            log: RefCell::new(Vec::new()),
        }
    }
    fn plain() -> Self {
        Script::new(RealFs.platform(), |_, _| None)
    }
    fn before(&self, op: &str, p: &str) -> Option<Act> {
        self.log.borrow_mut().push(format!("{op} {p}"));
        (self.hook.borrow_mut())(op, p)
    }
    fn calls(&self, op: &str) -> Vec<String> {
        let prefix = format!("{op} ");
        self.log
            .borrow()
            .iter()
            .filter_map(|l| l.strip_prefix(&prefix).map(str::to_owned))
            .collect()
    }
    fn stat_like(
        &self,
        op: &str,
        p: &str,
        real: impl FnOnce() -> Result<FileStat, FsError>,
    ) -> Result<FileStat, FsError> {
        match self.before(op, p) {
            Some(Act::Fail(c)) => Err(FsError::new(c)),
            Some(Act::Stat(s)) => Ok(s),
            _ => real(),
        }
    }
}

impl PathFs for Script<'_> {
    type Handle = std::fs::File;
    type Dir = RealDir;
    fn platform(&self) -> &'static str {
        self.platform
    }
    fn home_dir(&self) -> String {
        String::new()
    }
    fn realpath(&self, p: &str) -> Result<String, FsError> {
        match self.before("realpath", p) {
            Some(Act::Fail(c)) => Err(FsError::new(c)),
            _ => RealFs.realpath(p),
        }
    }
    fn stat(&self, p: &str) -> Result<FileStat, FsError> {
        self.stat_like("stat", p, || RealFs.stat(p))
    }
    fn lstat(&self, p: &str) -> Result<FileStat, FsError> {
        self.stat_like("lstat", p, || RealFs.lstat(p))
    }
    fn read_dir(&self, p: &str) -> Result<Vec<DirEntry>, FsError> {
        match self.before("read_dir", p) {
            Some(Act::Fail(c)) => Err(FsError::new(c)),
            Some(Act::Entries(e)) => Ok(e),
            _ => RealFs.read_dir(p),
        }
    }
    fn open_dir(&self, p: &str) -> Result<RealDir, FsError> {
        match self.before("open_dir", p) {
            Some(Act::Fail(c)) => Err(FsError::new(c)),
            _ => RealFs.open_dir(p),
        }
    }
    fn dir_stat(&self, d: &RealDir) -> Result<FileStat, FsError> {
        self.stat_like("dir_stat", d.path(), || RealFs.dir_stat(d))
    }
    // The hook sees the open of the leaf as `open <parent>/<leaf>`: the moment just before the leaf is opened, which is
    // where the tests change the tree.
    fn open_at(&self, d: &RealDir, leaf: &str, flags: OpenFlags) -> Result<std::fs::File, FsError> {
        self.log.borrow_mut().push(format!("flags {flags:?}"));
        match self.before("open", &format!("{}/{leaf}", d.path())) {
            Some(Act::Fail(c)) => Err(FsError::new(c)),
            _ => RealFs.open_at(d, leaf, flags),
        }
    }
    fn rename_at(&self, d: &RealDir, from: &str, to: &str) -> Result<(), FsError> {
        match self.before("rename_at", &format!("{}/{from}", d.path())) {
            Some(Act::Fail(c)) => Err(FsError::new(c)),
            _ => RealFs.rename_at(d, from, to),
        }
    }
    fn link_at(&self, d: &RealDir, from: &str, to: &str) -> Result<(), FsError> {
        match self.before("link_at", &format!("{}/{to}", d.path())) {
            Some(Act::Fail(c)) => Err(FsError::new(c)),
            _ => RealFs.link_at(d, from, to),
        }
    }
    fn unlink_at(&self, d: &RealDir, leaf: &str) -> Result<(), FsError> {
        match self.before("unlink_at", &format!("{}/{leaf}", d.path())) {
            Some(Act::Fail(c)) => Err(FsError::new(c)),
            _ => RealFs.unlink_at(d, leaf),
        }
    }
    fn read_dir_at(&self, d: &RealDir) -> Result<Vec<DirEntry>, FsError> {
        match self.before("read_dir_at", d.path()) {
            Some(Act::Fail(c)) => Err(FsError::new(c)),
            Some(Act::Entries(e)) => Ok(e),
            _ => RealFs.read_dir_at(d),
        }
    }
    fn entry_at(&self, d: &RealDir, leaf: &str) -> Result<EntryMeta, FsError> {
        match self.before("entry_at", &format!("{}/{leaf}", d.path())) {
            Some(Act::Fail(c)) => Err(FsError::new(c)),
            Some(Act::Entry(meta)) => Ok(meta),
            _ => RealFs.entry_at(d, leaf),
        }
    }
    fn fstat(&self, h: &std::fs::File) -> Result<FileStat, FsError> {
        self.stat_like("fstat", "", || RealFs.fstat(h))
    }
    fn fd_path(&self, h: &std::fs::File) -> Option<String> {
        match self.before("fd_path", "") {
            Some(Act::FdPath(p)) => p,
            _ => RealFs.fd_path(h),
        }
    }
    fn dir_path(&self, d: &RealDir) -> Option<String> {
        match self.before("dir_path", d.path()) {
            Some(Act::FdPath(p)) => p,
            _ => RealFs.dir_path(d),
        }
    }
    fn truncate(&self, h: &std::fs::File) -> Result<(), FsError> {
        match self.before("truncate", "") {
            Some(Act::Fail(c)) => Err(FsError::new(c)),
            _ => RealFs.truncate(h),
        }
    }
}

fn swap_dir_for_link(dir: &str, target: &str) {
    std::fs::rename(dir, format!("{dir}.old")).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, dir).unwrap();
    #[cfg(not(unix))]
    let _ = target;
}

fn swap_back(dir: &str) {
    std::fs::remove_file(dir).unwrap();
    std::fs::rename(format!("{dir}.old"), dir).unwrap();
}

// --- Node's path functions ------------------------------------------------------------------------------------------------------

#[test]
fn dirname_and_basename_follow_node() {
    for (p, want) in [
        ("/a/b", "/a"),
        ("/a", "/"),
        ("/", "/"),
        ("/a/b/", "/a"),
        ("a", "."),
        ("", "."),
        ("//a", "//"),
        ("/a//b", "/a/"),
    ] {
        assert_eq!(dirname(p, false), want, "{p}");
    }
    for (p, want) in [
        ("C:\\a\\b", "C:\\a"),
        ("C:\\a", "C:\\"),
        ("C:\\", "C:\\"),
        ("C:", "C:"),
        ("C:a", "C:"),
        ("\\\\srv\\share\\a", "\\\\srv\\share\\"),
        ("\\\\srv\\share", "\\\\srv\\share"),
        ("\\a", "\\"),
        ("a", "."),
        ("/x/y", "/x"),
    ] {
        assert_eq!(dirname(p, true), want, "{p}");
    }
    for (p, want) in [("/a/b", "b"), ("/a/b/", "b"), ("/", ""), ("a", "a")] {
        assert_eq!(basename(p, false), want, "{p}");
    }
    for (p, want) in [
        ("C:\\a\\b", "b"),
        ("C:\\", ""),
        ("C:a", "a"),
        ("\\\\srv\\share\\x", "x"),
    ] {
        assert_eq!(basename(p, true), want, "{p}");
    }
}

#[test]
fn native_prefixes_are_stripped_and_the_drive_upper_cased() {
    assert_eq!(normalise_native("\\\\?\\c:\\x".into(), true), "C:\\x");
    assert_eq!(
        normalise_native("\\\\?\\UNC\\srv\\s\\x".into(), true),
        "\\\\srv\\s\\x"
    );
    assert_eq!(
        normalise_native("\\\\?\\c:\\x".into(), false),
        "\\\\?\\c:\\x"
    );
}

#[test]
fn special_trees_by_platform() {
    for p in [
        "/proc/self/root/etc/passwd",
        "/proc",
        "/sys/kernel",
        "/dev/null",
        "/dev/shm/x",
        "/run/user/0/bus",
    ] {
        assert!(special_tree(p, "linux").is_some(), "{p}");
    }
    for p in ["/procx", "/run/user", "/devices", "/home/proc"] {
        assert!(special_tree(p, "linux").is_none(), "{p}");
    }
    assert_eq!(special_tree("/dev/null", "darwin"), Some("dev"));
    assert_eq!(special_tree("/proc/1", "darwin"), None);
    assert_eq!(special_tree("/dev/null", "win32"), None);
}

// --- conformance (real files) --------------------------------------------------------------------------------------------------

#[cfg(unix)]
#[test]
fn an_existing_file_resolves_with_its_identity() {
    use std::os::unix::fs::MetadataExt;
    let t = Tree::new();
    let c = canon(&RealFs, &t, &t.p("root/file.txt"), |_| {}).unwrap();
    assert_eq!(
        (
            c.canonical.as_str(),
            c.root_id.as_deref(),
            c.exists,
            c.hard_linked
        ),
        (t.p("root/file.txt").as_str(), Some("ws"), true, false)
    );
    let m = std::fs::metadata(t.p("root/file.txt")).unwrap();
    assert_eq!(
        (c.identity.dev.clone(), c.identity.ino.clone()),
        (m.dev().to_string(), m.ino().to_string())
    );
    let pm = std::fs::metadata(t.p("root")).unwrap();
    assert_eq!(c.parent_identity.ino, pm.ino().to_string());
    // A missing leaf carries the identity of its nearest existing ancestor.
    let n = canon(&RealFs, &t, &t.p("root/sub/a/b"), |o| {
        o.access = Access::Write
    })
    .unwrap();
    assert_eq!(
        n.identity.ino,
        std::fs::metadata(t.p("root/sub"))
            .unwrap()
            .ino()
            .to_string()
    );
    assert_eq!(n.parent_identity, n.identity);
    // The JSON shape is the TypeScript object.
    assert_eq!(c.json()["rootId"], "ws");
    assert!(c.json()["identity"]["ino"].is_string());
}

// The tree's roots are POSIX spellings; on Windows every root is refused first (`no-identity`).
#[cfg(unix)]
#[test]
fn relative_input_needs_a_cwd_inside_a_root() {
    let t = Tree::new();
    let (cwd, roots, home) = (t.p("root/sub"), t.roots(), t.p("no-home"));
    let mut o = opts(&roots, &home);
    o.cwd = Some(&cwd);
    assert_eq!(
        canonicalise_path(&RealFs, "deep.txt", &o, &IcuNfc)
            .unwrap()
            .canonical,
        t.p("root/sub/deep.txt")
    );
    assert_eq!(
        reason(canon(&RealFs, &t, "deep.txt", |_| {})),
        "relative-no-cwd"
    );
}

#[cfg(unix)]
#[test]
fn a_fifo_is_refused_at_the_open_without_blocking_k2_d6() {
    let t = Tree::new();
    let ok = std::process::Command::new("mkfifo")
        .arg(t.p("root/p"))
        .status()
        .unwrap()
        .success();
    assert!(ok);
    let r = canon(&RealFs, &t, &t.p("root/p"), |_| {}).unwrap();
    // TypeScript blocks here until a writer opens the FIFO; Rust opens it non-blocking and refuses the descriptor.
    assert_eq!(
        reason(open_verified(&RealFs, &r, OpenFlags::READ)),
        "unsupported-open"
    );
    let w = canon(&RealFs, &t, &t.p("root/p"), |o| o.access = Access::Write).unwrap();
    assert_eq!(
        open_verified(&RealFs, &w, write_flags(false)).unwrap_err(),
        refuse("unresolvable", "open failed (ENXIO)")
    );
}

#[cfg(unix)]
#[test]
fn a_leaf_swapped_for_a_hard_link_keeps_the_other_file_intact_k2_d5() {
    let t = Tree::new();
    std::fs::write(t.p("root/t.txt"), "original").unwrap();
    let c = canon(&RealFs, &t, &t.p("root/t.txt"), |o| {
        o.access = Access::Write
    })
    .unwrap();
    std::fs::remove_file(t.p("root/t.txt")).unwrap();
    std::fs::hard_link(t.p("outside/secret.txt"), t.p("root/t.txt")).unwrap();
    let f = OpenFlags {
        truncate: true,
        ..write_flags(false)
    };
    assert_eq!(reason(open_verified(&RealFs, &c, f)), "identity-changed");
    assert_eq!(t.read("outside/secret.txt"), "outside-secret");
}

#[cfg(unix)]
#[test]
fn a_truncating_open_truncates_after_the_checks() {
    let t = Tree::new();
    std::fs::write(t.p("root/w.txt"), "before").unwrap();
    let c = canon(&RealFs, &t, &t.p("root/w.txt"), |o| {
        o.access = Access::Write
    })
    .unwrap();
    let s = Script::plain();
    let f = OpenFlags {
        truncate: true,
        ..write_flags(false)
    };
    drop(open_verified(&s, &c, f).unwrap());
    assert_eq!(t.read("root/w.txt"), "");
    // The open itself never carried O_TRUNC; the truncation came last.
    assert!(s
        .calls("flags")
        .iter()
        .all(|l| l.contains("truncate: false")));
    assert_eq!(s.log.borrow().last().unwrap(), "truncate ");
    // A failing truncation is a refusal, not a handle on an untruncated file.
    let s = Script::new(RealFs.platform(), |op, _| {
        (op == "truncate").then_some(Act::Fail("EIO"))
    });
    assert_eq!(
        open_verified(&s, &c, f).unwrap_err(),
        refuse("unresolvable", "open failed (EIO)")
    );
}

#[test]
fn syntax_refusals_come_before_the_roots_on_every_platform() {
    for (input, platform, want) in [
        ("\\\\?\\C:\\x", "win32", "device-path"),
        ("\\\\.\\C:\\", "win32", "device-path"),
        ("\\\\localhost\\c$\\x", "win32", "unc-not-allowed"),
        ("C:\\r\\file.txt:stream", "win32", "alternate-stream"),
        ("C:\\r\\NUL", "win32", "reserved-device-name"),
        ("C:\\r\\file.txt.", "win32", "trailing-dot-space"),
        ("C:\\r\\PROGRA~1", "win32", "short-name"),
        ("/r/a\\b", "darwin", "backslash"),
        ("/r/../x", "linux", "dot-dot"),
    ] {
        let roots = [PathRoot {
            id: "x".into(),
            path: "/does/not/matter".into(),
            identity: None,
        }];
        let mut o = opts(&roots, "");
        o.platform = Some(platform);
        assert_eq!(
            reason(canonicalise_path(&RealFs, input, &o, &IcuNfc)),
            want,
            "{input}"
        );
    }
}

// The tree's roots are POSIX spellings; on Windows every root is refused first (`no-identity`).
#[cfg(unix)]
#[test]
fn linux_special_trees_are_refused_before_resolution() {
    let t = Tree::new();
    let s = Script::plain();
    for p in [
        "/proc/self/root/etc/passwd",
        "/proc/self/cwd/x",
        "/proc/self/fd/0",
        "/proc/1/root",
        "/sys/kernel",
        "/dev/null",
        "/dev/shm/x",
        "/run/user/0/bus",
    ] {
        let r = canon(&s, &t, p, |o| {
            o.platform = Some("linux");
            o.require_root = false;
        });
        assert_eq!(reason(r), "special-tree", "{p}");
    }
    // The spelled path is judged first: none of them was resolved.
    assert!(s
        .calls("realpath")
        .iter()
        .all(|p| !p.starts_with("/proc") && !p.starts_with("/sys") && !p.starts_with("/run")));
}

#[cfg(target_os = "linux")]
#[test]
fn a_link_into_proc_is_judged_on_its_real_target() {
    let t = Tree::new();
    std::os::unix::fs::symlink("/proc/self/root", t.p("root/to-proc")).unwrap();
    assert_eq!(
        reason(canon(&RealFs, &t, &t.p("root/to-proc/etc/passwd"), |_| {})),
        "outside-root"
    );
}

// --- the Windows adapter (R-K-12) ----------------------------------------------------------------------------------------------
// Only the CI runs these (windows-2025): nobody could build or run the adapter where it was written. They hold the
// claims the adapter makes: a file has an identity, a path resolves and opens, a create is exclusive, a hard link and a
// reparse point are seen for what they are, and an open parent directory cannot be renamed away.

#[cfg(windows)]
mod windows_adapter {
    use super::*;
    use std::io::Read;

    fn win(t: &Tree, rel: &str) -> String {
        t.p(rel).replace('/', "\\")
    }

    fn roots(t: &Tree) -> Vec<PathRoot> {
        vec![PathRoot {
            id: "ws".into(),
            path: win(t, "root"),
            identity: None,
        }]
    }

    fn canon_win(t: &Tree, rel: &str, access: Access) -> Result<CanonicalPath, PathRefusal> {
        let roots = roots(t);
        let mut o = opts(&roots, "");
        o.access = access;
        canonicalise_path(&RealFs, &win(t, rel), &o, &IcuNfc)
    }

    #[test]
    fn a_file_has_an_identity_and_resolves_inside_its_root() {
        let t = Tree::new();
        let st = RealFs.stat(&win(&t, "root/file.txt")).unwrap();
        assert_ne!(st.ino, 0, "NTFS has a file index");
        assert_eq!((st.kind, st.nlink), (FileKind::File, 1));
        assert_eq!(RealFs.stat(&win(&t, "root")).unwrap().kind, FileKind::Dir);
        let c = canon_win(&t, "root/file.txt", Access::Read).unwrap();
        assert_eq!(
            (c.root_id.as_deref(), c.exists, c.hard_linked),
            (Some("ws"), true, false)
        );
        assert_eq!(c.identity.ino, st.ino.to_string());
        assert_eq!(
            reason(canon_win(&t, "outside/secret.txt", Access::Read)),
            "outside-root"
        );
    }

    #[test]
    fn an_existing_file_opens_and_a_create_is_exclusive() {
        let t = Tree::new();
        let c = canon_win(&t, "root/file.txt", Access::Read).unwrap();
        let mut text = String::new();
        open_verified(&RealFs, &c, OpenFlags::READ)
            .unwrap()
            .read_to_string(&mut text)
            .unwrap();
        assert_eq!(text, "inside");
        let n = canon_win(&t, "root/new.txt", Access::Write).unwrap();
        assert!(!n.exists);
        open_verified(&RealFs, &n, write_flags(true)).unwrap();
        assert!(Path::new(&t.p("root/new.txt")).exists());
        // The same stale answer again: something is at the leaf now, so nothing is opened.
        assert_eq!(
            reason(open_verified(&RealFs, &n, write_flags(true))),
            "identity-changed"
        );
        // A read of a missing file creates nothing.
        let m = canon_win(&t, "root/missing.txt", Access::Read).unwrap();
        assert_eq!(
            reason(open_verified(&RealFs, &m, OpenFlags::READ)),
            "not-found"
        );
        assert!(!Path::new(&t.p("root/missing.txt")).exists());
    }

    #[test]
    fn a_hard_link_is_counted() {
        let t = Tree::new();
        std::fs::hard_link(t.p("outside/secret.txt"), t.p("root/alias.txt")).unwrap();
        assert_eq!(RealFs.stat(&win(&t, "root/alias.txt")).unwrap().nlink, 2);
        assert_eq!(
            reason(canon_win(&t, "root/alias.txt", Access::Write)),
            "hard-link"
        );
    }

    #[test]
    fn a_directory_link_is_never_opened_as_the_directory() {
        let t = Tree::new();
        // Creating a link needs a privilege the runner may not have; without it there is nothing to check here.
        if std::os::windows::fs::symlink_dir(t.p("outside"), t.p("root/to-outside")).is_err() {
            return;
        }
        assert_eq!(
            RealFs.lstat(&win(&t, "root/to-outside")).unwrap().kind,
            FileKind::Symlink
        );
        assert_eq!(
            RealFs.open_dir(&win(&t, "root/to-outside")).unwrap_err(),
            FsError::new("ELOOP")
        );
        // Through the link the real target decides.
        assert_eq!(
            reason(canon_win(&t, "root/to-outside/secret.txt", Access::Read)),
            "outside-root"
        );
        // The leaf itself a link: opened as the link and refused, never followed.
        if std::os::windows::fs::symlink_file(t.p("outside/secret.txt"), t.p("root/leaf-link"))
            .is_ok()
        {
            let dir = RealFs.open_dir(&win(&t, "root")).unwrap();
            let f = OpenFlags {
                nofollow: true,
                ..OpenFlags::READ
            };
            assert_eq!(
                RealFs.open_at(&dir, "leaf-link", f).unwrap_err(),
                FsError::new("ELOOP")
            );
        }
    }

    #[test]
    fn an_open_parent_directory_cannot_be_renamed_away() {
        let t = Tree::new();
        let dir = RealFs.open_dir(&win(&t, "root/sub")).unwrap();
        assert!(
            std::fs::rename(t.p("root/sub"), t.p("root/moved")).is_err(),
            "the handle holds the directory in place (no delete sharing)"
        );
        // Below the pinned directory: one component only, exclusive create, the publishing calls.
        let create = OpenFlags {
            create: true,
            exclusive: true,
            nofollow: true,
            ..OpenFlags::with(AccessMode::WriteOnly)
        };
        RealFs.open_at(&dir, "made.txt", create).unwrap();
        assert_eq!(
            RealFs.open_at(&dir, "made.txt", create).unwrap_err(),
            FsError::new("EEXIST")
        );
        assert_eq!(
            RealFs.open_at(&dir, "..\\file.txt", create).unwrap_err(),
            FsError::new("EINVAL")
        );
        RealFs.rename_at(&dir, "made.txt", "final.txt").unwrap();
        assert!(Path::new(&t.p("root/sub/final.txt")).exists());
        RealFs.unlink_at(&dir, "final.txt").unwrap();
        drop(dir);
        std::fs::rename(t.p("root/sub"), t.p("root/moved")).unwrap();
    }
}

#[test]
fn a_file_system_that_reports_no_file_id_refuses_the_root() {
    // What `RealFs` answered for every path on Windows before the adapter (R-K-12), and what any file system without
    // stable ids still answers: inode 0, refused (TypeScript's `no-identity`).
    let t = Tree::new();
    let s = Script::new(RealFs.platform(), |op, _| {
        (op == "lstat").then_some(Act::Stat(FileStat {
            dev: 0,
            ino: 0,
            birth_ns: None,
            kind: FileKind::Dir,
            nlink: 1,
        }))
    });
    let native = |p: String| {
        if cfg!(windows) {
            p.replace('/', "\\")
        } else {
            p
        }
    };
    let roots = [PathRoot {
        id: "ws".into(),
        path: native(t.p("root")),
        identity: None,
    }];
    let o = opts(&roots, "");
    assert_eq!(
        canonicalise_path(&s, &native(t.p("root/file.txt")), &o, &IcuNfc).unwrap_err(),
        refuse("bad-root", "root \"ws\": no-identity")
    );
}

// --- order and flags (the double records every call) ----------------------------------------------------------------------------

#[cfg(unix)]
#[test]
fn the_open_never_follows_the_leaf_and_creates_only_exclusively() {
    let t = Tree::new();
    let s = Script::plain();
    let new = canon(&RealFs, &t, &t.p("root/n.txt"), |o| {
        o.access = Access::Write
    })
    .unwrap();
    drop(open_verified(&s, &new, write_flags(true)).unwrap());
    let old = canon(&RealFs, &t, &t.p("root/file.txt"), |o| {
        o.access = Access::Write
    })
    .unwrap();
    drop(open_verified(&s, &old, write_flags(true)).unwrap());
    drop(open_verified(&s, &old, OpenFlags::READ).unwrap());
    let flags = s.calls("flags");
    assert_eq!(flags.len(), 3);
    assert!(
        flags
            .iter()
            .all(|f| f.contains("nofollow: true") && f.contains("nonblock: true")),
        "{flags:?}"
    );
    assert!(
        flags[0].contains("create: true, exclusive: true"),
        "a missing leaf is created exclusively"
    );
    assert!(
        flags[1].contains("create: false, exclusive: false"),
        "an existing leaf is never created"
    );
    // The parent is checked before the open and again after it, on the open descriptor's side.
    let log = s.log.borrow().clone();
    let open_at = log.iter().position(|l| l.starts_with("open ")).unwrap();
    let parent = format!("realpath {}", t.p("root"));
    assert!(
        log[..open_at].contains(&parent) && log[open_at..].contains(&parent),
        "{log:?}"
    );
    assert!(log[open_at..].iter().any(|l| l == "fstat "));
}

#[cfg(unix)]
#[test]
fn the_deny_list_is_applied_to_the_spelled_path_before_anything_is_resolved() {
    let t = Tree::new();
    let s = Script::plain();
    let deny = serde_json::json!([{ "name": ".ssh" }]);
    let r = canon(&s, &t, &t.p("root/.ssh/id"), |o| o.deny = Some(&deny));
    assert_eq!(
        r.unwrap_err(),
        refuse("deny-listed", "matches the credential deny-list")
    );
    assert!(!s.calls("realpath").iter().any(|p| p.contains(".ssh")));
}

#[cfg(unix)]
#[test]
fn only_a_hard_linked_target_makes_the_scans_read_directories() {
    let t = Tree::new();
    let deny = serde_json::json!([{ "path": t.p("outside") }]);
    let s = Script::plain();
    std::fs::write(t.p("root/single.txt"), "x").unwrap();
    canon(&s, &t, &t.p("root/single.txt"), |o| o.deny = Some(&deny)).unwrap();
    assert!(s.calls("read_dir").is_empty());
    std::fs::hard_link(t.p("outside/secret.txt"), t.p("root/alias.txt")).unwrap();
    assert_eq!(
        reason(canon(&s, &t, &t.p("root/alias.txt"), |o| o.deny = Some(&deny))),
        "deny-listed"
    );
    assert!(s.calls("read_dir").contains(&t.p("outside")));
}

#[cfg(unix)]
#[test]
fn a_directory_the_scans_cannot_read_refuses_a_hard_linked_target() {
    let t = Tree::new();
    std::fs::hard_link(t.p("outside/secret.txt"), t.p("root/alias.txt")).unwrap();
    let s = Script::new(RealFs.platform(), |op, _| {
        (op == "read_dir").then_some(Act::Fail("EACCES"))
    });
    let deny = serde_json::json!([{ "path": t.p("outside") }]);
    assert_eq!(
        canon(&s, &t, &t.p("root/alias.txt"), |o| o.deny = Some(&deny)).unwrap_err(),
        refuse(
            "deny-listed",
            "hard-linked target while the deny-list scan was incomplete (fail closed)"
        )
    );
    let names = serde_json::json!([{ "name": ".env" }]);
    assert_eq!(
        canon(&s, &t, &t.p("root/alias.txt"), |o| o.deny = Some(&names)).unwrap_err(),
        refuse(
            "deny-listed",
            "hard-linked target while the name-entry scan was incomplete (fail closed)"
        )
    );
    // A directory that vanished during the name scan is skipped, not counted against the target.
    let s = Script::new(RealFs.platform(), |op, _| {
        (op == "read_dir").then_some(Act::Fail("ENOENT"))
    });
    assert!(
        canon(&s, &t, &t.p("root/alias.txt"), |o| o.deny = Some(&names))
            .unwrap()
            .hard_linked
    );
}

#[cfg(unix)]
#[test]
fn a_scan_cap_at_or_below_zero_makes_the_scans_incomplete_ra_12() {
    // As in TypeScript (`budget-- <= 0`): a cap of zero or less, the smallest one included, ends either scan at its
    // first entry as incomplete; the count never wraps.
    let t = Tree::new();
    std::fs::write(t.p("outside/plain.txt"), "plain").unwrap();
    std::fs::hard_link(t.p("outside/plain.txt"), t.p("root/alias.txt")).unwrap();
    let deny = serde_json::json!([{ "path": t.p("outside") }]);
    let names = serde_json::json!([{ "name": ".env" }]);
    for cap in [0, -1, i64::MIN] {
        assert_eq!(
            canon(&RealFs, &t, &t.p("root/alias.txt"), |o| {
                o.deny = Some(&deny);
                o.scan_cap = Some(cap);
            })
            .unwrap_err(),
            refuse(
                "deny-listed",
                "hard-linked target while the deny-list scan was incomplete (fail closed)"
            ),
            "{cap}"
        );
        assert_eq!(
            canon(&RealFs, &t, &t.p("root/alias.txt"), |o| {
                o.deny = Some(&names);
                o.scan_cap = Some(cap);
            })
            .unwrap_err(),
            refuse(
                "deny-listed",
                "hard-linked target while the name-entry scan was incomplete (fail closed)"
            ),
            "{cap}"
        );
    }
    // A cap that is large enough lets the same target through both scans.
    assert!(canon(&RealFs, &t, &t.p("root/alias.txt"), |o| {
        o.deny = Some(&names);
        o.scan_cap = Some(i64::MAX);
    })
    .is_ok());
}

// The tree's roots are POSIX spellings; on Windows every root is refused first (`no-identity`).
#[cfg(unix)]
#[test]
fn a_file_system_without_file_ids_is_refused() {
    let t = Tree::new();
    let s = Script::new(RealFs.platform(), |op, p| {
        (op == "lstat" && p.ends_with("file.txt")).then_some(Act::Stat(FileStat {
            dev: 1,
            ino: 0,
            birth_ns: None,
            kind: FileKind::File,
            nlink: 1,
        }))
    });
    assert_eq!(
        canon(&s, &t, &t.p("root/file.txt"), |_| {}).unwrap_err(),
        refuse(
            "no-identity",
            "the file system reports no stable file id (fail closed)"
        )
    );
}

// The tree's roots are POSIX spellings; on Windows every root is refused first (`no-identity`).
#[cfg(unix)]
#[test]
fn errors_while_resolving_map_to_their_refusals() {
    let t = Tree::new();
    for (code, want) in [
        ("ELOOP", "link-loop"),
        ("ENOTDIR", "not-directory"),
        ("EACCES", "unresolvable"),
        ("ENAMETOOLONG", "unresolvable"),
    ] {
        let target = t.p("root/file.txt");
        let s = Script::new(RealFs.platform(), move |op, p| {
            (op == "realpath" && p == target).then_some(Act::Fail(code))
        });
        let r = canon(&s, &t, &t.p("root/file.txt"), |_| {});
        assert_eq!(reason(r.clone()), want, "{code}");
        if want == "unresolvable" {
            assert_eq!(
                r.unwrap_err().detail,
                format!("cannot resolve the path ({code})")
            );
        }
    }
}

// --- races inside one call (the double changes the tree at the exact point) ---------------------------------------------------

#[cfg(unix)]
#[test]
fn a_parent_swapped_between_the_pre_check_and_the_open_never_truncates_the_other_file() {
    let t = Tree::new();
    std::fs::create_dir(t.p("root/d")).unwrap();
    std::fs::write(t.p("root/d/f.txt"), "in").unwrap();
    std::fs::write(t.p("outside/f.txt"), "out").unwrap();
    let c = canon(&RealFs, &t, &t.p("root/d/f.txt"), |o| {
        o.access = Access::Write
    })
    .unwrap();
    let (dir, outside) = (t.p("root/d"), t.p("outside"));
    let s = Script::new(RealFs.platform(), move |op, _| {
        if op == "open" {
            swap_dir_for_link(&dir, &outside);
        }
        None
    });
    let f = OpenFlags {
        truncate: true,
        ..write_flags(false)
    };
    // TypeScript passes O_TRUNC to this open, which goes through the link and empties outside/f.txt before it refuses.
    // Here the leaf is opened in the directory that was checked (R-K-11), and the swapped parent is refused afterwards.
    assert_eq!(reason(open_verified(&s, &c, f)), "identity-changed");
    assert_eq!(t.read("outside/f.txt"), "out");
    assert_eq!(
        t.read("root/d.old/f.txt"),
        "in",
        "refused before the truncate"
    );
}

#[cfg(unix)]
#[test]
fn a_create_through_a_parent_swapped_and_swapped_back_lands_in_the_checked_directory_r_k_11() {
    let t = Tree::new();
    std::fs::create_dir(t.p("root/d")).unwrap();
    let c = canon(&RealFs, &t, &t.p("root/d/n.txt"), |o| {
        o.access = Access::Write
    })
    .unwrap();
    let (dir, outside) = (t.p("root/d"), t.p("outside"));
    let s = Script::new(RealFs.platform(), move |op, _| {
        match op {
            "open" => swap_dir_for_link(&dir, &outside),
            "fstat" => swap_back(&dir),
            _ => {}
        }
        None
    });
    // K2-D7: TypeScript creates the file outside the root here and, on macOS, hands it out. The leaf is now created
    // relative to the descriptor of the checked parent, so the swap redirects nothing and the call succeeds where it should.
    open_verified(&s, &c, write_flags(true)).unwrap();
    assert!(!Path::new(&t.p("outside/n.txt")).exists());
    assert!(Path::new(&t.p("root/d/n.txt")).exists());
}

#[cfg(unix)]
#[test]
fn a_create_through_a_swapped_parent_never_leaves_the_checked_directory_r_k_11() {
    let t = Tree::new();
    std::fs::create_dir(t.p("root/d")).unwrap();
    let c = canon(&RealFs, &t, &t.p("root/d/n.txt"), |o| {
        o.access = Access::Write
    })
    .unwrap();
    // After the parent was opened and before the leaf is: the name now leads outside, the descriptor does not.
    let (dir, outside) = (t.p("root/d"), t.p("outside"));
    let s = Script::new(RealFs.platform(), move |op, _| {
        if op == "open" {
            swap_dir_for_link(&dir, &outside);
        }
        None
    });
    assert_eq!(
        open_verified(&s, &c, write_flags(true)).unwrap_err(),
        refuse(
            "identity-changed",
            "the parent directory path now resolves elsewhere"
        )
    );
    assert!(
        !Path::new(&t.p("outside/n.txt")).exists(),
        "nothing outside"
    );
    assert!(Path::new(&t.p("root/d.old/n.txt")).exists());
}

#[cfg(unix)]
#[test]
fn a_parent_swapped_before_it_is_opened_is_refused_before_the_leaf_is_touched_r_k_11() {
    let t = Tree::new();
    std::fs::create_dir(t.p("root/d")).unwrap();
    std::fs::create_dir(t.p("outside/d2")).unwrap();
    let c = canon(&RealFs, &t, &t.p("root/d/n.txt"), |o| {
        o.access = Access::Write
    })
    .unwrap();
    // For a link: the parent is opened with O_NOFOLLOW, so the link is an error and nothing is opened through it.
    let (dir, outside) = (t.p("root/d"), t.p("outside"));
    let s = Script::new(RealFs.platform(), move |op, _| {
        if op == "open_dir" {
            swap_dir_for_link(&dir, &outside);
        }
        None
    });
    assert_eq!(
        open_verified(&s, &c, write_flags(true)).unwrap_err(),
        refuse(
            "identity-changed",
            "the parent directory path now resolves elsewhere"
        )
    );
    assert!(s.calls("open").is_empty(), "the leaf was never opened");
    assert!(!Path::new(&t.p("outside/n.txt")).exists());
    swap_back(&t.p("root/d"));
    // For another directory: the descriptor is not the directory that was checked.
    let (dir, other) = (t.p("root/d"), t.p("outside/d2"));
    let s = Script::new(RealFs.platform(), move |op, _| {
        if op == "open_dir" {
            std::fs::rename(&dir, format!("{dir}.old")).unwrap();
            std::fs::rename(&other, &dir).unwrap();
        }
        None
    });
    assert_eq!(
        open_verified(&s, &c, write_flags(true)).unwrap_err(),
        refuse("identity-changed", "the parent directory was replaced")
    );
    assert!(s.calls("open").is_empty(), "the leaf was never opened");
    assert!(!Path::new(&t.p("root/d/n.txt")).exists());
}

#[cfg(unix)]
#[test]
fn the_identity_of_the_parent_is_checked_on_its_descriptor_r_k_11() {
    let t = Tree::new();
    let c = canon(&RealFs, &t, &t.p("root/file.txt"), |_| {}).unwrap();
    let real = RealFs.stat(&t.p("root")).unwrap();
    for (st, want) in [
        (
            FileStat {
                ino: real.ino + 1,
                ..real
            },
            "the parent directory was replaced",
        ),
        (
            FileStat {
                dev: real.dev + 1,
                ..real
            },
            "the parent directory was replaced",
        ),
        (
            FileStat {
                kind: FileKind::File,
                ..real
            },
            "the parent directory was replaced",
        ),
    ] {
        let s = Script::new(RealFs.platform(), move |op, _| {
            (op == "dir_stat").then_some(Act::Stat(st))
        });
        assert_eq!(
            open_verified(&s, &c, OpenFlags::READ).unwrap_err(),
            refuse("identity-changed", want),
            "{st:?}"
        );
        assert!(s.calls("open").is_empty(), "the leaf was never opened");
    }
    // An error on the descriptor or at the open of the parent is a refusal too (gone, or not there for a create).
    for op_name in ["dir_stat", "open_dir"] {
        let s = Script::new(RealFs.platform(), move |op, _| {
            (op == op_name).then_some(Act::Fail("EIO"))
        });
        assert_eq!(
            open_verified(&s, &c, OpenFlags::READ).unwrap_err(),
            refuse("identity-changed", "the parent directory is gone")
        );
        assert!(s.calls("open").is_empty());
    }
    let missing = canon(&RealFs, &t, &t.p("root/none.txt"), |o| {
        o.access = Access::Write
    })
    .unwrap();
    let s = Script::new(RealFs.platform(), |op, _| {
        (op == "open_dir").then_some(Act::Fail("ENOENT"))
    });
    assert_eq!(
        open_verified(&s, &missing, write_flags(true)).unwrap_err(),
        refuse("not-found", "the target's parent does not exist")
    );
    for code in ["ELOOP", "EMLINK", "ENOTDIR"] {
        let s = Script::new(RealFs.platform(), move |op, _| {
            (op == "open_dir").then_some(Act::Fail(code))
        });
        assert_eq!(
            reason(open_verified(&s, &c, OpenFlags::READ)),
            "identity-changed",
            "{code}"
        );
    }
}

#[cfg(unix)]
#[test]
fn the_created_file_must_be_the_leaf_at_the_checked_path_k2_d7() {
    // The second line behind R-K-11: should a create ever land somewhere else, the leaf at the checked path is not the
    // created file, and the call is refused.
    let t = Tree::new();
    let c = canon(&RealFs, &t, &t.p("root/n.txt"), |o| {
        o.access = Access::Write
    })
    .unwrap();
    let other = RealFs.stat(&t.p("root/file.txt")).unwrap();
    let s = Script::new(RealFs.platform(), move |op, _| {
        (op == "lstat").then_some(Act::Stat(other))
    });
    assert_eq!(
        open_verified(&s, &c, write_flags(true)).unwrap_err(),
        refuse(
            "identity-changed",
            "the created file is not the file at the checked path"
        )
    );
}

#[cfg(unix)]
#[test]
fn a_target_missing_at_the_check_is_not_opened_unless_the_open_creates_it() {
    // Nothing was at the path when it was checked, so there is no identity to compare an opened file with: an open
    // that does not create is refused before anything is opened, whatever appeared there since.
    let t = Tree::new();
    for (flags, access) in [
        (OpenFlags::READ, Access::Read),
        (
            OpenFlags {
                truncate: true,
                ..OpenFlags::with(AccessMode::WriteOnly)
            },
            Access::Write,
        ),
        (
            OpenFlags {
                append: true,
                ..OpenFlags::with(AccessMode::WriteOnly)
            },
            Access::Write,
        ),
    ] {
        let c = canon(&RealFs, &t, &t.p("root/late.txt"), |o| o.access = access).unwrap();
        assert!(!c.exists);
        std::fs::hard_link(t.p("outside/secret.txt"), t.p("root/late.txt")).unwrap();
        let s = Script::plain();
        assert_eq!(
            open_verified(&s, &c, flags).unwrap_err(),
            refuse("not-found", "the target does not exist"),
            "{flags:?}"
        );
        assert!(s.calls("open").is_empty(), "refused before the open");
        std::fs::remove_file(t.p("root/late.txt")).unwrap();
        assert_eq!(t.read("outside/secret.txt"), "outside-secret");
    }
}

#[cfg(unix)]
#[test]
fn a_created_file_must_be_at_the_checked_path_where_the_system_can_say() {
    // Where the system names the path of an open file, a file the open created must be at the checked path, on every
    // platform and not only on Linux (the comparison is the one of the open parent directory).
    let t = Tree::new();
    let canon_new =
        |name: &str| canon(&RealFs, &t, &t.p(name), |o| o.access = Access::Write).unwrap();
    let elsewhere = t.p("outside/made.txt");
    let s = Script::new("darwin", move |op, _| {
        (op == "fd_path").then(|| Act::FdPath(Some(elsewhere.clone())))
    });
    assert_eq!(
        open_verified(&s, &canon_new("root/a.txt"), write_flags(true)).unwrap_err(),
        refuse(
            "identity-changed",
            "the opened file lives at a different path than the one checked"
        )
    );
    assert!(
        std::fs::metadata(t.p("outside/made.txt")).is_err(),
        "nothing is made where the double points"
    );
    let c = canon_new("root/b.txt");
    let here = c.canonical.clone();
    let s = Script::new("darwin", move |op, _| {
        (op == "fd_path").then(|| Act::FdPath(Some(here.clone())))
    });
    assert!(open_verified(&s, &c, write_flags(true)).is_ok());
    // A path the system cannot name is not a refusal (the checks by path stay the guard).
    let s = Script::new("darwin", |op, _| {
        (op == "fd_path").then_some(Act::FdPath(None))
    });
    assert!(open_verified(&s, &canon_new("root/c.txt"), write_flags(true)).is_ok());
    // An existing file is compared by its identity; its path is not asked for outside Linux.
    let s = Script::new("darwin", |op, _| {
        (op == "fd_path").then_some(Act::FdPath(Some("/elsewhere".into())))
    });
    let existing = canon(&RealFs, &t, &t.p("root/file.txt"), |_| {}).unwrap();
    assert!(open_verified(&s, &existing, OpenFlags::READ).is_ok());
}

#[cfg(unix)]
#[test]
fn an_open_directory_is_the_directory_whatever_its_name_points_to_r_k_11() {
    // Real files, no double: the port itself. Everything done through an open directory happens in that directory.
    let t = Tree::new();
    std::fs::create_dir(t.p("root/d")).unwrap();
    std::fs::write(t.p("root/d/a.txt"), "a").unwrap();
    std::fs::write(t.p("outside/a.txt"), "outside-a").unwrap();
    let dir = RealFs.open_dir(&t.p("root/d")).unwrap();
    assert_eq!(dir.path(), t.p("root/d"));
    swap_dir_for_link(&t.p("root/d"), &t.p("outside"));
    let create = OpenFlags {
        create: true,
        exclusive: true,
        nofollow: true,
        ..OpenFlags::with(AccessMode::WriteOnly)
    };
    RealFs.open_at(&dir, "n.txt", create).unwrap();
    assert!(Path::new(&t.p("root/d.old/n.txt")).exists());
    assert!(!Path::new(&t.p("outside/n.txt")).exists());
    // O_EXCL: a second create of the same leaf is an error, not an open.
    assert_eq!(
        RealFs.open_at(&dir, "n.txt", create).unwrap_err(),
        FsError::new("EEXIST")
    );
    RealFs.rename_at(&dir, "n.txt", "a.txt").unwrap();
    assert_eq!(t.read("root/d.old/a.txt"), "");
    assert_eq!(t.read("outside/a.txt"), "outside-a");
    RealFs.link_at(&dir, "a.txt", "b.txt").unwrap();
    assert_eq!(
        RealFs.link_at(&dir, "a.txt", "b.txt").unwrap_err(),
        FsError::new("EEXIST")
    );
    RealFs.unlink_at(&dir, "a.txt").unwrap();
    assert!(!Path::new(&t.p("root/d.old/a.txt")).exists());
    assert!(Path::new(&t.p("root/d.old/b.txt")).exists());
    assert!(Path::new(&t.p("outside/a.txt")).exists());
    // The directory at a name that is a link is not opened at all.
    let e = RealFs.open_dir(&t.p("root/d")).unwrap_err();
    assert!(
        ["ELOOP", "ENOTDIR", "EMLINK"].contains(&e.code.as_str()),
        "{e:?}"
    );
    assert_eq!(
        RealFs.open_dir(&t.p("root/file.txt")).unwrap_err(),
        FsError::new("ENOTDIR")
    );
    // O_NOFOLLOW on the leaf: a link is an error; a leaf is one component and nothing else.
    std::os::unix::fs::symlink(t.p("outside/secret.txt"), t.p("root/d.old/link")).unwrap();
    let read = OpenFlags {
        nofollow: true,
        ..OpenFlags::READ
    };
    let e = RealFs.open_at(&dir, "link", read).unwrap_err();
    assert!(["ELOOP", "EMLINK"].contains(&e.code.as_str()), "{e:?}");
    for bad in ["", "..", "x/y", "../outside/secret.txt", "a\0b"] {
        assert_eq!(
            RealFs.open_at(&dir, bad, read).unwrap_err(),
            FsError::new("EINVAL"),
            "{bad:?}"
        );
        assert_eq!(
            RealFs.unlink_at(&dir, bad).unwrap_err(),
            FsError::new("EINVAL")
        );
        assert_eq!(
            RealFs.rename_at(&dir, "b.txt", bad).unwrap_err(),
            FsError::new("EINVAL")
        );
        assert_eq!(
            RealFs.link_at(&dir, bad, "c.txt").unwrap_err(),
            FsError::new("EINVAL")
        );
    }
    // `.` is the directory itself (how a file-system root is opened).
    let me = RealFs.open_at(&dir, ".", read).unwrap();
    assert_eq!(
        RealFs.fstat(&me).unwrap().ino,
        RealFs.dir_stat(&dir).unwrap().ino
    );
}

#[cfg(unix)]
#[test]
fn a_created_file_takes_the_mode_the_caller_asked_for() {
    use std::os::unix::fs::PermissionsExt;
    let t = Tree::new();
    let c = canon(&RealFs, &t, &t.p("root/private.txt"), |o| {
        o.access = Access::Write
    })
    .unwrap();
    let f = OpenFlags {
        mode: 0o600,
        ..write_flags(true)
    };
    let h = open_verified(&RealFs, &c, f).unwrap();
    assert_eq!(h.metadata().unwrap().permissions().mode() & 0o777, 0o600);
    // The directory comes back with the handle, for the caller that publishes the file in it.
    let c = canon(&RealFs, &t, &t.p("root/sub/deep.txt"), |_| {}).unwrap();
    let (dir, _h) = open_verified_in(&RealFs, &c, OpenFlags::READ).unwrap();
    assert_eq!(dir.path(), t.p("root/sub"));
}

#[cfg(unix)]
#[test]
fn a_link_planted_between_the_lstat_and_the_open_is_not_followed() {
    let t = Tree::new();
    let c = canon(&RealFs, &t, &t.p("root/race.txt"), |o| {
        o.access = Access::Write
    })
    .unwrap();
    let (leaf, secret) = (t.p("root/race.txt"), t.p("outside/planted.txt"));
    let s = Script::new(RealFs.platform(), move |op, _| {
        if op == "open" {
            std::os::unix::fs::symlink(&secret, &leaf).unwrap();
        }
        None
    });
    assert_eq!(
        reason(open_verified(&s, &c, write_flags(true))),
        "identity-changed"
    );
    assert!(!Path::new(&t.p("outside/planted.txt")).exists());
    // An existing leaf swapped for a link at the same moment: O_NOFOLLOW refuses it.
    let c = canon(&RealFs, &t, &t.p("root/file.txt"), |_| {}).unwrap();
    let (leaf, secret) = (t.p("root/file.txt"), t.p("outside/secret.txt"));
    let s = Script::new(RealFs.platform(), move |op, _| {
        if op == "open" {
            std::fs::remove_file(&leaf).unwrap();
            std::os::unix::fs::symlink(&secret, &leaf).unwrap();
        }
        None
    });
    assert_eq!(
        open_verified(&s, &c, OpenFlags::READ).unwrap_err(),
        refuse("link-swap", "the leaf is now a symbolic link")
    );
}

#[cfg(unix)]
#[test]
fn the_identity_is_checked_on_the_open_descriptor() {
    let t = Tree::new();
    let c = canon(&RealFs, &t, &t.p("root/file.txt"), |_| {}).unwrap();
    let real = RealFs.stat(&t.p("root/file.txt")).unwrap();
    let mut cases = vec![
        (
            FileStat {
                ino: real.ino + 1,
                ..real
            },
            "identity-changed",
        ),
        (
            FileStat {
                dev: real.dev + 1,
                ..real
            },
            "identity-changed",
        ),
        (FileStat { nlink: 2, ..real }, "ok-read"),
        (
            FileStat {
                kind: FileKind::Other,
                ..real
            },
            "unsupported-open",
        ),
        // Without a birth time on one side, device and inode decide (a file system without one).
        (
            FileStat {
                birth_ns: None,
                ..real
            },
            "ok-read",
        ),
    ];
    if let Some(b) = real.birth_ns {
        // Same device and inode, born later: the inode was recycled for a file swapped in.
        cases.push((
            FileStat {
                birth_ns: Some(b + 1),
                ..real
            },
            "identity-changed",
        ));
    }
    for (st, want) in cases {
        let s = Script::new(RealFs.platform(), move |op, _| {
            (op == "fstat").then_some(Act::Stat(st))
        });
        match open_verified(&s, &c, OpenFlags::READ) {
            Ok(_) => assert_eq!(want, "ok-read", "{st:?}"),
            Err(e) => assert_eq!(e.reason, want, "{st:?}"),
        }
    }
    // A link gained since the check refuses a write, and a read when a deny list was in force.
    let w = canon(&RealFs, &t, &t.p("root/file.txt"), |o| {
        o.access = Access::Write
    })
    .unwrap();
    let s = Script::new(RealFs.platform(), move |op, _| {
        (op == "fstat").then_some(Act::Stat(FileStat { nlink: 2, ..real }))
    });
    assert_eq!(
        open_verified(&s, &w, write_flags(false)).unwrap_err(),
        refuse(
            "hard-link",
            "the file gained a hard link since it was checked"
        )
    );
    let guarded = CanonicalPath {
        deny_guarded: true,
        ..c.clone()
    };
    assert_eq!(
        reason(open_verified(&s, &guarded, OpenFlags::READ)),
        "hard-link"
    );
    // An error on the descriptor is a refusal too.
    let s = Script::new(RealFs.platform(), |op, _| {
        (op == "fstat").then_some(Act::Fail("EIO"))
    });
    assert_eq!(
        open_verified(&s, &c, OpenFlags::READ).unwrap_err(),
        refuse("identity-changed", "post-open verification failed")
    );
}

#[cfg(unix)]
#[test]
fn linux_checks_the_path_of_the_open_descriptor() {
    let t = Tree::new();
    let c = canon(&RealFs, &t, &t.p("root/file.txt"), |_| {}).unwrap();
    let elsewhere = t.p("outside/secret.txt");
    let s = Script::new("linux", move |op, _| {
        (op == "fd_path").then(|| Act::FdPath(Some(elsewhere.clone())))
    });
    assert_eq!(
        open_verified(&s, &c, OpenFlags::READ).unwrap_err(),
        refuse(
            "identity-changed",
            "the opened file lives at a different path than the one checked"
        )
    );
    let deleted = format!("{} (deleted)", t.p("root/file.txt"));
    let s = Script::new("linux", move |op, _| {
        (op == "fd_path").then(|| Act::FdPath(Some(deleted.clone())))
    });
    assert!(open_verified(&s, &c, OpenFlags::READ).is_ok());
    let s = Script::new("linux", |op, _| {
        (op == "fd_path").then_some(Act::FdPath(None))
    });
    assert!(
        open_verified(&s, &c, OpenFlags::READ).is_ok(),
        "an unreadable /proc is not a refusal (as in TypeScript)"
    );
    // Not on another platform: the descriptor's path is never asked for.
    let s = Script::new("darwin", |op, _| {
        (op == "fd_path").then_some(Act::FdPath(Some("/elsewhere".into())))
    });
    assert!(open_verified(&s, &c, OpenFlags::READ).is_ok());
}

#[cfg(unix)]
#[test]
fn windows_refuses_a_create_where_anything_exists_at_the_leaf() {
    let t = Tree::new();
    let c = canon(&RealFs, &t, &t.p("root/w.txt"), |o| {
        o.access = Access::Write
    })
    .unwrap();
    std::os::unix::fs::symlink(t.p("outside/nothing"), t.p("root/w.txt")).unwrap();
    let s = Script::new("win32", |_, _| None);
    assert_eq!(
        open_verified(&s, &c, write_flags(true)).unwrap_err(),
        refuse(
            "identity-changed",
            "the target appeared since it was checked"
        )
    );
    assert!(s.calls("open").is_empty(), "refused before the open");
    // An lstat that fails with anything but ENOENT counts as something being there.
    std::fs::remove_file(t.p("root/w.txt")).unwrap();
    let s = Script::new("win32", |op, _| {
        (op == "lstat").then_some(Act::Fail("EACCES"))
    });
    assert_eq!(
        reason(open_verified(&s, &c, write_flags(true))),
        "identity-changed"
    );
    // After the create the leaf must still resolve to itself.
    let leaf = t.p("root/w.txt");
    let s = Script::new("win32", move |op, p| {
        (op == "realpath" && p == leaf).then_some(Act::Fail("EIO"))
    });
    assert_eq!(
        open_verified(&s, &c, write_flags(true)).unwrap_err(),
        refuse("identity-changed", "post-open verification failed")
    );
}

// The tree's roots are POSIX spellings; on Windows every root is refused first (`no-identity`).
#[cfg(unix)]
#[test]
fn open_errors_map_to_their_refusals() {
    let t = Tree::new();
    let c = canon(&RealFs, &t, &t.p("root/file.txt"), |o| {
        o.access = Access::Write
    })
    .unwrap();
    let missing = canon(&RealFs, &t, &t.p("root/none.txt"), |o| {
        o.access = Access::Write
    })
    .unwrap();
    for (code, path, want) in [
        ("ELOOP", &c, "link-swap"),
        ("EMLINK", &c, "link-swap"),
        ("EEXIST", &missing, "identity-changed"),
        ("ENOENT", &c, "identity-changed"),
        ("ENOENT", &missing, "not-found"),
        ("EACCES", &c, "unresolvable"),
    ] {
        let s = Script::new(RealFs.platform(), move |op, _| {
            (op == "open").then_some(Act::Fail(code))
        });
        assert_eq!(
            reason(open_verified(&s, path, write_flags(true))),
            want,
            "{code}"
        );
    }
    assert_eq!(
        reason(open_verified(
            &RealFs,
            &CanonicalPath {
                access: Access::Read,
                ..c.clone()
            },
            OpenFlags {
                append: true,
                ..OpenFlags::READ
            }
        )),
        "unsupported-open"
    );
    // The parent check fails closed: gone (an existing target) or not there (a new one).
    let s = Script::new(RealFs.platform(), |op, _| {
        (op == "realpath").then_some(Act::Fail("EIO"))
    });
    assert_eq!(
        open_verified(&s, &c, OpenFlags::READ).unwrap_err(),
        refuse("identity-changed", "the parent directory is gone")
    );
    assert_eq!(
        open_verified(&s, &missing, write_flags(true)).unwrap_err(),
        refuse("not-found", "the target's parent does not exist")
    );
}

#[cfg(unix)]
#[test]
fn a_parent_replaced_by_a_directory_holding_the_same_file_is_refused_after_the_open() {
    // The parent is swapped, during the open, for a new directory that holds a hard link to the checked file: the opened
    // file is the checked one (same identity), so only the parent check after the open sees the swap.
    let t = Tree::new();
    std::fs::create_dir(t.p("root/d")).unwrap();
    std::fs::write(t.p("root/d/f.txt"), "in").unwrap();
    let c = canon(&RealFs, &t, &t.p("root/d/f.txt"), |_| {}).unwrap();
    let dir = t.p("root/d");
    let s = Script::new(RealFs.platform(), move |op, _| {
        if op == "open" {
            std::fs::rename(&dir, format!("{dir}.old")).unwrap();
            std::fs::create_dir(&dir).unwrap();
            std::fs::hard_link(format!("{dir}.old/f.txt"), format!("{dir}/f.txt")).unwrap();
        }
        None
    });
    assert_eq!(
        open_verified(&s, &c, OpenFlags::READ).unwrap_err(),
        refuse("identity-changed", "the parent directory was replaced")
    );
}

#[cfg(unix)]
#[test]
fn a_file_met_while_walking_up_is_not_a_directory() {
    // POSIX answers ENOTDIR for `file/x` at once; a file system that answers ENOENT (Windows does for `file\x`) makes the
    // walk up meet the file with a tail left, which must not be taken for an existing ancestor.
    let t = Tree::new();
    let below = t.p("root/file.txt/x");
    let s = Script::new(RealFs.platform(), move |op, p| {
        (op == "realpath" && p == below).then_some(Act::Fail("ENOENT"))
    });
    let want = format!(
        "{} is not a directory",
        js::json_stringify(&t.p("root/file.txt"))
    );
    assert_eq!(
        canon(&s, &t, &t.p("root/file.txt/x"), |o| o.access =
            Access::Write)
        .unwrap_err(),
        refuse("not-directory", want)
    );
}

// --- the identity is taken at the real path itself (review of K2, V-1 and V-2) -------------------------------------------------

#[cfg(unix)]
#[test]
fn a_link_planted_between_the_realpath_and_the_stat_is_not_followed_v_1() {
    // The path resolves to itself; before its identity is read, the entry is swapped for a link to a file outside the
    // root. Following it would hand back the path inside the root with the identity of the file outside.
    let t = Tree::new();
    let (leaf, secret) = (t.p("root/file.txt"), t.p("outside/secret.txt"));
    let swapped = std::cell::Cell::new(false);
    let s = Script::new(RealFs.platform(), |op, p| {
        if op == "lstat" && p == leaf && !swapped.replace(true) {
            std::fs::remove_file(&leaf).unwrap();
            std::os::unix::fs::symlink(&secret, &leaf).unwrap();
        }
        None
    });
    assert_eq!(
        canon(&s, &t, &t.p("root/file.txt"), |_| {}).unwrap_err(),
        refuse("link-swap", "the path changed while it was resolved")
    );
    assert!(s.calls("stat").iter().all(|p| *p != t.p("root/file.txt")));
    // The same for a directory (what a listing would then have read), and for the parent of the target.
    let t = Tree::new();
    let (dir, outside) = (t.p("root/sub"), t.p("outside"));
    let swapped = std::cell::Cell::new(false);
    let s = Script::new(RealFs.platform(), |op, p| {
        if op == "lstat" && p == dir && !swapped.replace(true) {
            swap_dir_for_link(&dir, &outside);
        }
        None
    });
    assert_eq!(reason(canon(&s, &t, &t.p("root/sub"), |_| {})), "link-swap");
    let t = Tree::new();
    let (dir, outside, leaf) = (t.p("root/sub"), t.p("outside"), t.p("root/sub/deep.txt"));
    std::fs::write(t.p("outside/deep.txt"), "x").unwrap();
    let seen = std::cell::Cell::new(false);
    let s = Script::new(RealFs.platform(), |op, p| {
        // After the leaf's identity was read and before the parent's is.
        if op == "lstat" && p == leaf {
            seen.set(true);
        } else if op == "lstat" && p == dir && seen.replace(false) {
            swap_dir_for_link(&dir, &outside);
        }
        None
    });
    assert_eq!(
        reason(canon(&s, &t, &t.p("root/sub/deep.txt"), |_| {})),
        "link-swap"
    );
}

#[cfg(unix)]
#[test]
fn an_identity_bound_through_a_swapped_component_does_not_open_outside_the_root_v_1() {
    // Review of K2, V-1: a component above the parent is a link to a directory outside the root at some of the calls
    // and not at others, as scripted below. The open directory's own path is what refuses it.
    let t = Tree::new();
    std::fs::create_dir_all(t.p("root/a/sub")).unwrap();
    std::fs::create_dir_all(t.p("outside/sub")).unwrap();
    let (a, outside, parent) = (t.p("root/a"), t.p("outside"), t.p("root/a/sub"));
    let linked = std::cell::Cell::new(false);
    let started = std::cell::Cell::new(false);
    let set = |link: bool| {
        if linked.get() != link {
            if link {
                swap_dir_for_link(&a, &outside);
            } else {
                swap_back(&a);
            }
            linked.set(link);
        }
    };
    let s = Script::new(RealFs.platform(), |op, p| {
        if p == parent {
            match op {
                "lstat" if !started.replace(true) => set(true),
                "realpath" if started.get() => set(false),
                "stat" | "open_dir" if started.get() => set(true),
                _ => {}
            }
        }
        None
    });
    let c = canon(&s, &t, &t.p("root/a/sub/new.txt"), |o| {
        o.access = Access::Write
    });
    let r = c.and_then(|c| open_verified(&s, &c, write_flags(true)));
    set(false);
    assert!(
        !Path::new(&t.p("outside/sub/new.txt")).exists(),
        "a file was created outside the root"
    );
    assert_eq!(
        r.unwrap_err(),
        refuse(
            "identity-changed",
            "the parent directory path now resolves elsewhere"
        )
    );
    assert_eq!(s.calls("dir_path"), vec![parent.clone()]);
    assert!(!Path::new(&t.p("root/a/sub/new.txt")).exists());
}

#[test]
fn the_path_of_an_open_directory_is_compared_in_its_native_form() {
    assert!(same_dir_path("/a/b", "/a/b", "linux"));
    assert!(!same_dir_path("/a/c", "/a/b", "linux"));
    assert!(!same_dir_path("/a/b (deleted)", "/a/b", "linux"));
    // `realpath(3)` keeps the data volume's form; `F_GETPATH` answers with the firmlinked one.
    assert!(same_dir_path(
        "/Users/x",
        "/System/Volumes/Data/Users/x",
        "darwin"
    ));
    assert!(!same_dir_path(
        "/Users/x",
        "/System/Volumes/Data/Users/x",
        "linux"
    ));
    assert!(!same_dir_path(
        "/System/Volumes/Data/Users/x",
        "/Users/x",
        "darwin"
    ));
    assert!(!same_dir_path(
        "/Users/x",
        "/System/Volumes/DataX/Users/x",
        "darwin"
    ));
}

#[cfg(unix)]
#[test]
fn a_name_that_is_not_unicode_makes_a_deny_scan_incomplete_v_2() {
    // macOS does not store such a name, so the listing is scripted: a protected directory holds an entry whose name was
    // decoded with replacement characters. The scan cannot look at it and must not call itself clean.
    let t = Tree::new();
    std::fs::create_dir(t.p("root/.ssh")).unwrap();
    std::fs::hard_link(t.p("root/file.txt"), t.p("root/alias.txt")).unwrap();
    let deny = json!([{ "name": ".ssh" }]);
    for kind in [FileKind::File, FileKind::Dir] {
        let ssh = t.p("root/.ssh");
        let s = Script::new(RealFs.platform(), move |op, p| {
            (op == "read_dir" && p == ssh).then(|| {
                Act::Entries(vec![DirEntry {
                    name: "id_\u{fffd}".into(),
                    kind,
                    lossy: true,
                }])
            })
        });
        let r = canon(&s, &t, &t.p("root/alias.txt"), |o| o.deny = Some(&deny));
        assert_eq!(
            r.unwrap_err(),
            refuse(
                "deny-listed",
                "hard-linked target while the name-entry scan was incomplete (fail closed)"
            ),
            "{kind:?}"
        );
    }
    // The same entry outside every protected name is not looked at, and a link there cannot be the alias of a file.
    let root = t.p("root");
    let s = Script::new(RealFs.platform(), move |op, p| {
        (op == "read_dir" && p == root).then(|| {
            let mut all = RealFs.read_dir(p).unwrap();
            all.push(DirEntry {
                name: "odd_\u{fffd}".into(),
                kind: FileKind::File,
                lossy: true,
            });
            Act::Entries(all)
        })
    });
    assert!(canon(&s, &t, &t.p("root/alias.txt"), |o| o.deny = Some(&deny)).is_ok());
    // A deny-listed path: any entry below it that cannot be looked at ends the walk as incomplete.
    let deny = json!([{ "path": t.p("root/.ssh") }]);
    let ssh = t.p("root/.ssh");
    let s = Script::new(RealFs.platform(), move |op, p| {
        (op == "read_dir" && p == ssh).then(|| {
            Act::Entries(vec![DirEntry {
                name: "\u{fffd}".into(),
                kind: FileKind::File,
                lossy: true,
            }])
        })
    });
    assert_eq!(
        canon(&s, &t, &t.p("root/alias.txt"), |o| o.deny = Some(&deny))
            .unwrap_err()
            .detail,
        "hard-linked target while the deny-list scan was incomplete (fail closed)"
    );
}

#[cfg(unix)]
#[test]
fn an_entry_is_read_through_the_checked_parent_without_following_it() {
    let t = Tree::new();
    let c = canon(&RealFs, &t, &t.p("root/file.txt"), |_| {}).unwrap();
    let m = stat_verified(&RealFs, &c).unwrap();
    assert_eq!((m.kind, m.size), (FileKind::File, 6));
    assert_eq!(m.ino.to_string(), c.identity.ino);
    // The device and inode can be reused. A symlink still cannot be the checked real entry.
    let reported = Script::new(RealFs.platform(), |op, _| {
        (op == "entry_at").then_some(Act::Entry(EntryMeta {
            kind: FileKind::Symlink,
            ..m
        }))
    });
    assert_eq!(reason(stat_verified(&reported, &c)), "identity-changed");
    // The listing of an open directory and its entries, links as links.
    std::os::unix::fs::symlink(t.p("outside/secret.txt"), t.p("root/link")).unwrap();
    let dir = RealFs.open_dir(&t.p("root")).unwrap();
    let mut names: Vec<(String, FileKind)> = RealFs
        .read_dir_at(&dir)
        .unwrap()
        .into_iter()
        .map(|e| (e.name, e.kind))
        .collect();
    names.sort_by(|a, b| a.0.cmp(&b.0));
    assert_eq!(
        names,
        [
            ("file.txt".to_owned(), FileKind::File),
            ("link".to_owned(), FileKind::Symlink),
            ("sub".to_owned(), FileKind::Dir)
        ]
    );
    assert_eq!(
        RealFs.entry_at(&dir, "link").unwrap().kind,
        FileKind::Symlink
    );
    assert_eq!(
        RealFs.entry_at(&dir, "none").unwrap_err(),
        FsError::new("ENOENT")
    );
    assert_eq!(
        RealFs.entry_at(&dir, "sub/deep.txt").unwrap_err(),
        FsError::new("EINVAL")
    );
    // Swapped for a link after the check: the entry is the link, not the file that was checked.
    std::fs::remove_file(t.p("root/file.txt")).unwrap();
    std::os::unix::fs::symlink(t.p("outside/secret.txt"), t.p("root/file.txt")).unwrap();
    assert_eq!(reason(stat_verified(&RealFs, &c)), "identity-changed");
    let missing = canon(&RealFs, &t, &t.p("root/none"), |_| {}).unwrap();
    assert_eq!(reason(stat_verified(&RealFs, &missing)), "not-found");
}
