use super::*;
use serde_json::Value;
use std::cell::{Cell, RefCell};

struct Fixture<'a> {
    path: &'a Path,
    expected: &'a str,
    released: Cell<bool>,
    calls: RefCell<Vec<Vec<String>>>,
}

impl GitProcess for Fixture<'_> {
    fn git(&self, call: &GitCall) -> R<String> {
        assert_eq!(call.timeout_ms, 5000);
        assert_eq!(call.max_bytes, 4 * 1024 * 1024);
        assert!(!call.env.contains_key("GIT_CONFIG_COUNT"));
        assert!(!call.env.contains_key("PRIVATE_FIXTURE_ENV"));
        let mut steps = self.calls.borrow_mut();
        steps.push(call.args.clone());
        let tail = &call.args[11..];
        if tail[0] == "add" || tail[0] == "diff" {
            assert_eq!(
                call.env["GIT_INDEX_FILE"],
                self.path.join("scratch/index").to_str().unwrap()
            );
            assert_eq!(
                call.env["GIT_DIR"],
                self.path.join("scratch/git").to_str().unwrap()
            );
        }
        let value = match tail
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>()
            .as_slice()
        {
            ["rev-parse", "--show-object-format"] => "sha1\n",
            ["rev-parse", "--git-path", "objects"] => ".git/objects\n",
            ["rev-parse", "--git-path", "index"] => ".git/index\n",
            ["rev-parse", "--shared-index-path"] => "",
            ["rev-parse", "--verify", "--quiet", "HEAD"] => {
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n"
            }
            ["init", "--bare", ..]
            | ["add", "--update", "--"]
            | ["add", "--renormalize", "--update", "--"] => "",
            ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-color", "--binary", _, "--"] => {
                self.expected
            }
            other => panic!("unexpected call: {other:?}"),
        };
        assert_eq!(call.cwd, self.path.join("repo"));
        Ok(value.to_owned())
    }
}

impl DiffFiles for Fixture<'_> {
    fn scratch(&self) -> R<PathBuf> {
        Ok(self.path.join("scratch"))
    }
    fn repository_metadata(&self, root: &Path, value: &str) -> R<PathBuf> {
        Ok(root.join(value))
    }
    fn copy_index(&self, source: &Path, dest: &Path, max: u64) -> R<bool> {
        assert_eq!(source, self.path.join("repo/.git/index"));
        assert_eq!(dest, self.path.join("scratch/index"));
        assert_eq!(max, 64 * 1024 * 1024);
        Ok(true)
    }
    fn mkdir(&self, path: &Path) -> R<()> {
        assert!(path.starts_with(self.path.join("scratch")));
        Ok(())
    }
    fn write(&self, path: &Path, _: &[u8]) -> R<()> {
        assert!(path.starts_with(self.path.join("scratch")));
        Ok(())
    }
    fn release(&self, path: &Path) {
        assert_eq!(path, self.path.join("scratch"));
        self.released.set(true);
    }
}

#[test]
fn private_index_matches_typescript_diff_and_keeps_writes_in_scratch() {
    let encoded: Value = serde_json::from_str(include_str!(
        "../../../../fixtures/parity/coding/git-view.json"
    ))
    .unwrap();
    assert_eq!(encoded["headUnchanged"], true);
    assert_eq!(encoded["indexUnchanged"], true);
    let dir = tempfile::tempdir().unwrap();
    let fixture = Fixture {
        path: dir.path(),
        expected: encoded["diff"].as_str().unwrap(),
        released: Cell::new(false),
        calls: RefCell::default(),
    };
    let env = BTreeMap::from([
        ("GIT_CONFIG_COUNT".to_owned(), "unsafe".to_owned()),
        ("PRIVATE_FIXTURE_ENV".to_owned(), "private".to_owned()),
    ]);
    let view = GitView {
        process: &fixture,
        files: &fixture,
        environment: &env,
        windows: cfg!(windows),
    };
    assert_eq!(
        view.capture(&dir.path().join("repo")).unwrap(),
        fixture.expected
    );
    assert!(fixture.released.get());
    assert_eq!(fixture.calls.borrow().len(), 9);
}
