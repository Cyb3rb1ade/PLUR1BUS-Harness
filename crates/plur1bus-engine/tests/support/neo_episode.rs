//! Real-file episode composition fixture.
use super::*;
pub(super) struct Policy {
    pub(super) allowed: AtomicBool,
    pub(super) stop_after_first: AtomicBool,
    pub(super) journal: PathBuf,
}
impl CapturePolicy for Policy {
    fn allowed(&self, _: &RequestContext) -> Result<bool, EngineError> {
        if self.stop_after_first.load(Ordering::SeqCst)
            && fs::metadata(&self.journal).is_ok_and(|m| m.len() > 0)
        {
            self.allowed.store(false, Ordering::SeqCst);
        }
        Ok(self.allowed.load(Ordering::SeqCst))
    }
}
pub(super) fn turn(root: &Path, user: &str) -> TurnRecord {
    serde_json::from_value(json!({
        "agentId":"alpha",
        "principal":{"agentId":"alpha","workspace":format!("workspace-dir:v1:{}",root.display()),
            "user":harness_user_principal(user),"channel":"telegram","accountId":"fixture",
            "chat":{"id":"fixture","kind":"direct"},"trust":"proved"},
        "agent":{"origin":"user","background":false},"runId":"run-one","sessionKey":"stable-session",
        "incognito":false,"messages":[
            {"role":"user","content":"Architecture decision chosen"},
            {"role":"assistant","content":"I will plan the implementation"},
            {"role":"user","content":"yes exactly"},
            {"role":"assistant","content":"maybe we could use a queue"},
            {"role":"user","content":"never leak workspace data"}
        ]
    })).unwrap()
}
pub(super) struct Fixture {
    pub(super) root: tempfile::TempDir,
    pub(super) host: Arc<support::TestHost>,
    pub(super) policy: Arc<Policy>,
    pub(super) journal: EpisodeStore,
    pub(super) turn: TurnRecord,
    pub(super) context: RequestContext,
    pub(super) directory: PathBuf,
}
pub(super) fn setup() -> Fixture {
    let root = support::canonical_tempdir();
    let host = Arc::new(support::TestHost::new(root.path().join("state")));
    host.set_workspace("alpha", root.path().into());
    host.time.store(1_794_139_200_000, Ordering::SeqCst);
    let turn = turn(root.path(), "one");
    let context = RequestContext::build(&turn.principal, &turn.agent, host.as_ref()).unwrap();
    let directory = root
        .path()
        .join("workspaces")
        .join(Layout::for_key(&context.workspace_key).canonical);
    let policy = Arc::new(Policy {
        allowed: AtomicBool::new(true),
        stop_after_first: AtomicBool::new(false),
        journal: directory.join("episodes.jsonl"),
    });
    let mood = Arc::new(plur1bus_engine::capture::emotion_pool::EmotionalPool::new(
        host.clone(),
        json!({}),
    ));
    let journal = EpisodeStore::open(root.path(), host.clone(), policy.clone(), mood).unwrap();
    Fixture {
        root,
        host,
        policy,
        journal,
        turn,
        context,
        directory,
    }
}
pub(super) fn rows(directory: &Path, file: &str) -> Vec<Value> {
    fs::read_to_string(directory.join(file))
        .unwrap()
        .lines()
        .filter(|line| !line.is_empty())
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}
pub(super) fn native_file(dir: &Path, prefix: &str) -> PathBuf {
    fs::read_dir(dir)
        .unwrap()
        .map(|v| v.unwrap().path())
        .find(|p| p.file_name().unwrap().to_string_lossy().starts_with(prefix))
        .unwrap()
}
