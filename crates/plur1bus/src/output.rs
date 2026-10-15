use plur1bus_rpc::RpcError;
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};

pub struct Out {
    pub json: bool,
}

/// Inserts the top-level `"schema"` id into a `--json` document (ADR-016 §8). `value` must
/// serialize to a JSON object — every CLI document does, including the raw RPC result (ruling
/// R13: this is the *only* key `ok`/`fail` add on top of it) and the hand-built stub/error/
/// journaled/degraded documents. Debug-asserted rather than `Result`-returned: a document that
/// isn't an object is a programming bug at the call site, not a runtime condition to handle.
fn document(schema: &str, mut value: Value) -> Value {
    debug_assert!(
        value.is_object(),
        "--json document must be a JSON object, got {value}"
    );
    if let Some(map) = value.as_object_mut() {
        map.insert("schema".to_string(), json!(schema));
    }
    value
}

/// `--color` (global flag): when output carries ANSI colour.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, clap::ValueEnum)]
pub enum ColorChoice {
    /// Colour only when the stream is a terminal and `NO_COLOR` is unset or empty
    #[default]
    Auto,
    /// Always colour, even into a pipe or with `NO_COLOR` set
    Always,
    /// Never colour
    Never,
}

/// The colour decision as a pure function. `no_color` is the value of the `NO_COLOR` variable (`None` when unset): any
/// non-empty value disables colour in `auto` mode (https://no-color.org). An explicit `--color=always` or
/// `--color=never` wins over the environment, `auto` colours only a terminal.
pub(crate) fn color_decision(choice: ColorChoice, no_color: Option<&str>, is_tty: bool) -> bool {
    match choice {
        ColorChoice::Always => true,
        ColorChoice::Never => false,
        ColorChoice::Auto => is_tty && matches!(no_color, None | Some("")),
    }
}

/// The `--color` choice in raw process arguments, read before clap parses so that `--help` and parse errors honour it.
/// The last occurrence wins, `--` ends the scan, and an unusable value is ignored (clap then reports it).
pub(crate) fn color_from_args<I, S>(args: I) -> ColorChoice
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    use clap::ValueEnum;
    let args: Vec<String> = args
        .into_iter()
        .map(|a| a.as_ref().to_string_lossy().into_owned())
        .collect();
    let mut choice = ColorChoice::Auto;
    let mut i = 0;
    while i < args.len() {
        let value = match args[i].as_str() {
            "--" => break,
            "--color" => {
                i += 1;
                args.get(i).map(String::as_str)
            }
            a => a.strip_prefix("--color="),
        };
        if let Some(c) = value.and_then(|v| ColorChoice::from_str(v, false).ok()) {
            choice = c;
        }
        i += 1;
    }
    choice
}

/// Whether error text on stderr is coloured; set once by [`init_color`].
static STDERR_COLOR: AtomicBool = AtomicBool::new(false);

/// Applies `--color` and `NO_COLOR` to this process's own diagnostics (stderr). Called once, right after parsing.
pub(crate) fn init_color(choice: ColorChoice) {
    use std::io::IsTerminal;
    let no_color = std::env::var_os("NO_COLOR");
    let on = color_decision(
        choice,
        no_color.as_deref().map(|v| v.to_str().unwrap_or("set")),
        std::io::stderr().is_terminal(),
    );
    STDERR_COLOR.store(on, Ordering::Relaxed);
}

/// `plur1bus:` prefix of a human error line, bold red when stderr is coloured.
fn error_prefix() -> &'static str {
    if STDERR_COLOR.load(Ordering::Relaxed) {
        "\x1b[1;31mplur1bus:\x1b[0m"
    } else {
        "plur1bus:"
    }
}

/// Exit code of a command that was interrupted by a signal or Ctrl-C (the shell convention for SIGINT, 128 + 2).
pub(crate) const EXIT_INTERRUPTED: i32 = 130;

/// The exit code for a child process that ended (`acp serve`, `core run`): its own code passed through, and
/// [`EXIT_INTERRUPTED`] when a signal ended it (Ctrl-C or a kill: it has no code), 1 when there is nothing else to go by.
pub(crate) fn child_exit_code(status: &std::process::ExitStatus) -> i32 {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if status.code().is_none() && status.signal().is_some() {
            return EXIT_INTERRUPTED;
        }
    }
    status.code().unwrap_or(1)
}

/// The one place that maps an error code to the exit code of the process. `Out::fail` derives its exit from it,
/// `ext::Failure::exit` and `backup::BackupError::code` call it, and `docs/errors.md` is checked against it
/// (`documented_exit_codes_match_the_mapping`, `scripts/check-cli-exit-codes.mjs`).
///
/// - `E_LOCKED` → 3: another process holds the store or the home; retry later.
/// - `E_INVALID_PARAMS`, `E_NOT_AVAILABLE`, `E_APPROVAL_REQUIRED`, `E_CANCELLED` → 2: the command was refused before it
///   did any work (a usage or input error, not possible here, an approval is missing, a confirmation was declined).
/// - everything else → 1: the command ran and failed.
///
/// A signal or Ctrl-C is not an error code: it ends with [`EXIT_INTERRUPTED`], and `plur1bus import` passes the
/// importer's own exit code through (`Out::fail_exit`).
pub(crate) fn exit_code_for(code_name: &str) -> i32 {
    match code_name {
        "E_LOCKED" => 3,
        "E_INVALID_PARAMS" | "E_NOT_AVAILABLE" | "E_APPROVAL_REQUIRED" | "E_CANCELLED" => 2,
        _ => 1,
    }
}

/// Writes `text` (plus a newline when asked) to `w` and flushes.
pub(crate) fn emit_to<W: std::io::Write>(
    w: &mut W,
    text: &str,
    newline: bool,
) -> std::io::Result<()> {
    w.write_all(text.as_bytes())?;
    if newline {
        w.write_all(b"\n")?;
    }
    w.flush()
}

/// What a failed stdout write means: `None` for a closed pipe (`plur1bus … | head -1`: the reader went away, which is
/// not an error of the command), a stderr message for any other write error (a full disk behind a redirect).
fn write_failure(e: &std::io::Error) -> Option<String> {
    (e.kind() != std::io::ErrorKind::BrokenPipe)
        .then(|| format!("plur1bus: cannot write to stdout: {e}"))
}

/// Set once stdout has failed (closed pipe or a real write error): later writes are dropped.
static STDOUT_CLOSED: AtomicBool = AtomicBool::new(false);
/// Set when the failure was a real write error rather than a closed pipe; `main` turns it into exit 1 at the end.
static STDOUT_BROKEN: AtomicBool = AtomicBool::new(false);

/// Whether a stdout write failed with something other than a closed pipe, so the output the caller asked for is lost.
pub(crate) fn stdout_write_failed() -> bool {
    STDOUT_BROKEN.load(Ordering::Relaxed)
}

/// Writes a line to stderr and ignores every error. `eprintln!` panics when stderr is closed or full (`2>&-`), which
/// would turn a closed-stderr run into exit 101 and lose the command's real exit code.
pub(crate) fn say_err(text: &str) {
    use std::io::Write;
    let mut e = std::io::stderr().lock();
    let _ = writeln!(e, "{text}");
}

/// The exit code a command that ends the process itself must use. Same rule as the end of `main`: a command that
/// would exit 0 but lost its stdout output to a real write error (not a closed pipe) exits 1 instead, so success is
/// never reported for output the caller asked for and did not get. Non-zero codes are kept, they already fail.
pub(crate) fn final_exit_code(code: i32) -> i32 {
    if code == 0 && stdout_write_failed() {
        1
    } else {
        code
    }
}

/// `process::exit` for commands that end the process themselves (`setup`, `firstaid repair`, `import`): applies
/// [`final_exit_code`] so they do not bypass the write-error check at the end of `main`.
pub(crate) fn exit(code: i32) -> ! {
    std::process::exit(final_exit_code(code))
}

/// `println!` that cannot panic on a closed or failing stdout; see [`write_stdout`].
pub(crate) fn say(text: &str) {
    write_stdout(text, true);
}

/// `print!` counterpart of [`say`]: `text` exactly as given.
pub(crate) fn say_raw(text: &str) {
    write_stdout(text, false);
}

/// Never exits: a command's output is not its work, and `say` is also called mid-flow, before an install, enable or
/// repair has run, and on error paths that carry their own exit code. A closed pipe is remembered and every later write
/// is silently dropped, so the command runs to its normal end and keeps its real exit code. Any other write error is
/// reported once on stderr and recorded for [`stdout_write_failed`].
fn write_stdout(text: &str, newline: bool) {
    if STDOUT_CLOSED.load(Ordering::Relaxed) {
        return;
    }
    if let Err(e) = emit_to(&mut std::io::stdout().lock(), text, newline) {
        STDOUT_CLOSED.store(true, Ordering::Relaxed);
        if let Some(msg) = write_failure(&e) {
            STDOUT_BROKEN.store(true, Ordering::Relaxed);
            say_err(&msg);
        }
    }
}

impl Out {
    /// Prints `value` as `--json` (the raw RPC/CLI value, `schema: "<schema>"` inserted at the
    /// top level per ADR-016 §8 and ruling R13) or `human()` otherwise.
    pub fn ok<T: Serialize>(&self, schema: &str, value: &T, human: impl FnOnce() -> String) {
        if self.json {
            let v = serde_json::to_value(value).unwrap_or_else(|e| {
                self.fail(
                    "E_INTERNAL",
                    &format!("cannot serialise the result: {e}"),
                    json!({}),
                )
            });
            say(&document(schema, v).to_string());
        } else {
            say(&human());
        }
    }
    /// Prints a result that reports a failure (a verification that found damage, a run that failed) and exits with the
    /// exit code of `code`. Without `--json` it is `human()` on stdout, as for [`Out::ok`]. With `--json` it is the
    /// result document, so everything a script read from it before is still there, plus a top-level `error` object
    /// that is the `error/1` document of the failure (`schema`, `error`, `message`, `reason`, ...): stdout stays ONE
    /// JSON document, and a caller that wants the failure reads `doc.error`. A result that already has a top-level
    /// `error` key keeps it (none of the commands that use this does).
    pub fn ok_but_failed<T: Serialize>(
        &self,
        schema: &str,
        value: &T,
        human: impl FnOnce() -> String,
        failure: Failure,
    ) -> ! {
        if self.json {
            let v = serde_json::to_value(value).unwrap_or_else(|e| {
                self.fail(
                    "E_INTERNAL",
                    &format!("cannot serialise the result: {e}"),
                    json!({}),
                )
            });
            let v = with_failure(v, &failure);
            say(&document(schema, v).to_string());
        } else {
            say(&human());
        }
        exit(exit_code_for(failure.code))
    }
    /// Prints an error and exits with the exit code of `code` ([`exit_code_for`]). JSON goes to stdout (stable shape,
    /// `schema: "error/1"`), human text to stderr.
    pub fn fail(&self, code: &str, message: &str, extra: serde_json::Value) -> ! {
        self.fail_exit(code, message, extra, exit_code_for(code))
    }
    /// [`Out::fail`] with an exit code that does not come from the code table: the importer's own exit code
    /// (`plur1bus import`) or [`EXIT_INTERRUPTED`] (`plur1bus login` on Ctrl-C). Never pass a literal for a code that
    /// `exit_code_for` knows; `every_fail_call_takes_its_exit_code_from_the_table` (tests/cli_surface.rs) fails on that.
    pub fn fail_exit(&self, code: &str, message: &str, extra: serde_json::Value, exit: i32) -> ! {
        if self.json {
            say(&error_document(code, message, &extra).to_string());
        } else {
            say_err(&format!("{} {message}", error_prefix()));
            if let Some(line) = ids_line(&extra) {
                say_err(&line);
            }
        }
        std::process::exit(exit)
    }
    // `from_*` here is the brief's literal interface name for a "build+emit error
    // from an RpcError" helper, not a `From` conversion, so it legitimately takes `&self`.
    #[allow(clippy::wrong_self_convention)]
    pub fn from_rpc_error(&self, e: &RpcError) -> ! {
        let extra = rpc_error_extra(e);
        self.fail(&e.code_name(), &e.to_string(), extra)
    }
}

/// What [`Out::ok_but_failed`] reports next to a result: an error code (it decides the exit code), a message and the
/// extra `error/1` fields (`reason`, `detail`, `ids`).
pub struct Failure {
    pub code: &'static str,
    pub message: String,
    pub extra: Value,
}

impl Failure {
    pub fn new(code: &'static str, reason: &str, message: impl Into<String>) -> Self {
        Failure {
            code,
            message: message.into(),
            extra: json!({ "reason": reason }),
        }
    }
}

/// `result` with the failure as its top-level `error` (the `error/1` document); a result that has an `error` keeps it.
fn with_failure(mut result: Value, failure: &Failure) -> Value {
    if let Some(o) = result.as_object_mut() {
        o.entry("error")
            .or_insert_with(|| error_document(failure.code, &failure.message, &failure.extra));
    }
    result
}

/// The `error/1` document for `code`: `{ schema, error, message, ..extra }`.
fn error_document(code: &str, message: &str, extra: &Value) -> Value {
    let mut v = json!({ "error": code, "message": message });
    if let (Some(a), Some(b)) = (v.as_object_mut(), extra.as_object()) {
        for (k, x) in b {
            a.insert(k.clone(), x.clone());
        }
    }
    document("error/1", v)
}

/// The `reason`/`detail`/`ids` `--json` fields for an `RpcError` (Task 4 carry-over review, G7):
/// `error.data.reason`, `error.data.detail` and `error.data.ids` (non-secret recovery ids, e.g.
/// a half-finished shared-copy refresh) survive onto the CLI's error document when the core sent
/// them. Split out from `from_rpc_error` so it is unit-testable without exercising `process::exit`.
fn rpc_error_extra(e: &RpcError) -> Value {
    let mut extra = json!({});
    if let RpcError::Call { reason, detail, .. } = e {
        if let Some(r) = reason {
            extra["reason"] = json!(r);
        }
        if let Some(d) = detail {
            extra["detail"] = json!(d);
        }
    }
    if let Some(ids) = e.ids() {
        extra["ids"] = json!(ids);
    }
    extra
}

/// The human `ids: k=v …` line (keys sorted) for an error document's `ids`, so the recovery ids of
/// e.g. a half-finished shared-copy refresh are not `--json`-only; `None` without ids.
fn ids_line(extra: &Value) -> Option<String> {
    let ids = extra.get("ids")?.as_object()?;
    if ids.is_empty() {
        return None;
    }
    let mut pairs: Vec<(&String, &Value)> = ids.iter().collect();
    pairs.sort_by(|a, b| a.0.cmp(b.0));
    let text = pairs
        .iter()
        .map(|(k, v)| match v.as_str() {
            Some(s) => format!("{k}={s}"),
            None => format!("{k}={v}"),
        })
        .collect::<Vec<_>>()
        .join(" ");
    Some(format!("ids: {text}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn document_inserts_schema_at_the_top_level() {
        let v = document("memory.recall/1", json!({ "blocks": [] }));
        assert_eq!(v["schema"], "memory.recall/1");
        assert_eq!(v["blocks"], json!([]));
    }

    #[test]
    fn document_leaves_the_rest_of_the_value_untouched() {
        let v = document(
            "agent.list/1",
            json!({ "agents": ["bernd"], "core": "ready" }),
        );
        assert_eq!(v["agents"], json!(["bernd"]));
        assert_eq!(v["core"], "ready");
        assert_eq!(
            v.as_object().unwrap().len(),
            3,
            "only `schema` is added on top of the original keys"
        );
    }

    #[test]
    fn exit_codes_map_e_approval_required_and_e_locked_and_e_not_available() {
        assert_eq!(exit_code_for("E_LOCKED"), 3);
        assert_eq!(exit_code_for("E_NOT_AVAILABLE"), 2);
        assert_eq!(
            exit_code_for("E_APPROVAL_REQUIRED"),
            2,
            "G18: a script run that hits E_APPROVAL_REQUIRED must exit 2, not report success"
        );
        assert_eq!(exit_code_for("E_DENIED"), 1);
        assert_eq!(exit_code_for("E_INTERNAL"), 1);
    }

    #[test]
    fn a_failed_result_carries_one_error_document_and_keeps_its_fields() {
        let f = Failure::new("E_STORAGE", "audit-verify-failed", "did not verify");
        let v = document(
            "audit.verify/1",
            with_failure(json!({ "ok": false, "findings": [1] }), &f),
        );
        assert_eq!(v["schema"], "audit.verify/1");
        assert_eq!(v["ok"], false);
        assert_eq!(v["findings"], json!([1]));
        assert_eq!(v["error"]["schema"], "error/1");
        assert_eq!(v["error"]["error"], "E_STORAGE");
        assert_eq!(v["error"]["message"], "did not verify");
        assert_eq!(v["error"]["reason"], "audit-verify-failed");
        // a result that already has an `error` keeps it
        let kept = with_failure(json!({ "error": "mine" }), &f);
        assert_eq!(kept["error"], "mine");
    }

    #[cfg(unix)]
    #[test]
    fn a_child_ended_by_a_signal_exits_130_and_any_other_child_keeps_its_code() {
        let status = |script: &str| {
            std::process::Command::new("sh")
                .args(["-c", script])
                .status()
                .unwrap()
        };
        assert_eq!(child_exit_code(&status("exit 0")), 0);
        assert_eq!(child_exit_code(&status("exit 7")), 7);
        assert_eq!(child_exit_code(&status("kill -TERM $$")), EXIT_INTERRUPTED);
        assert_eq!(child_exit_code(&status("kill -INT $$")), EXIT_INTERRUPTED);
    }

    #[test]
    fn the_exit_table_is_the_one_mapping() {
        for (code, exit) in [
            ("E_LOCKED", 3),
            ("E_INVALID_PARAMS", 2),
            ("E_NOT_AVAILABLE", 2),
            ("E_APPROVAL_REQUIRED", 2),
            ("E_CANCELLED", 2),
            ("E_CONFLICT", 1),
            ("E_STORAGE", 1),
            ("E_IMPORT_FAILED", 1),
            ("X_NOT_A_CODE", 1),
        ] {
            assert_eq!(exit_code_for(code), exit, "{code}");
        }
        // The other two places that used to repeat it now ask this one.
        for reason in [
            "core-running",
            "core-unavailable",
            "io",
            "restore-failed",
            "source-busy",
            "snapshot-mismatch",
            "exists",
            "whatever-else",
        ] {
            let (code, exit) = crate::backup::BackupError::new(reason, "").code();
            assert_eq!(exit, exit_code_for(code), "backup reason {reason}");
        }
        assert_eq!(
            crate::backup::BackupError::new("whatever-else", "").code(),
            ("E_INVALID_PARAMS", 2)
        );
    }

    #[test]
    fn error_documents_carry_reason_detail_and_ids() {
        use std::collections::BTreeMap;
        let mut ids = BTreeMap::new();
        ids.insert("sourceId".to_string(), "abc".to_string());
        ids.insert("sharedId".to_string(), "def".to_string());
        let e = RpcError::Call {
            error: serde_json::from_value(json!("E_STORAGE")).unwrap(),
            jsonrpc: 2,
            message: "shared-copy refresh failed halfway".into(),
            reason: Some("storage".into()),
            detail: Some("write failed".into()),
            ids: Some(Box::new(ids)),
            ext: None,
        };
        // Build the same document from_rpc_error would emit, without exercising process::exit.
        let extra = rpc_error_extra(&e);
        let mut v = json!({ "error": e.code_name(), "message": e.to_string() });
        if let (Some(a), Some(b)) = (v.as_object_mut(), extra.as_object()) {
            for (k, x) in b {
                a.insert(k.clone(), x.clone());
            }
        }
        let doc = document("error/1", v);
        assert_eq!(doc["schema"], "error/1");
        assert_eq!(doc["error"], "E_STORAGE");
        assert_eq!(doc["reason"], "storage");
        assert_eq!(doc["detail"], "write failed");
        assert_eq!(doc["ids"]["sourceId"], "abc");
        assert_eq!(doc["ids"]["sharedId"], "def");
    }

    #[test]
    fn human_errors_print_ids_in_stable_key_order() {
        let extra = json!({ "reason": "storage", "ids": { "staleSharedId": "c", "sourceId": "a", "sharedId": "b" } });
        assert_eq!(
            ids_line(&extra).as_deref(),
            Some("ids: sharedId=b sourceId=a staleSharedId=c")
        );
        assert_eq!(ids_line(&json!({ "reason": "storage" })), None);
        assert_eq!(ids_line(&json!({ "ids": {} })), None);
    }

    /// A writer that fails every write with `kind`.
    struct Failing(std::io::ErrorKind);
    impl std::io::Write for Failing {
        fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
            Err(self.0.into())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Err(self.0.into())
        }
    }

    #[test]
    fn a_failing_stdout_is_an_error_not_a_panic() {
        let e = emit_to(&mut Failing(std::io::ErrorKind::BrokenPipe), "x", true).unwrap_err();
        assert_eq!(e.kind(), std::io::ErrorKind::BrokenPipe);
        assert_eq!(write_failure(&e), None, "a closed pipe ends quietly");
        let e = emit_to(&mut Failing(std::io::ErrorKind::StorageFull), "x", false).unwrap_err();
        assert!(write_failure(&e)
            .unwrap()
            .contains("cannot write to stdout"));
    }

    #[test]
    fn emit_to_writes_the_text_with_or_without_a_newline() {
        let mut buf = Vec::new();
        emit_to(&mut buf, "a", true).unwrap();
        emit_to(&mut buf, "b", false).unwrap();
        assert_eq!(buf, b"a\nb");
    }

    #[test]
    fn color_decision_follows_the_flag_then_no_color_then_the_terminal() {
        use ColorChoice::{Always, Auto, Never};
        // auto: a terminal and no non-empty NO_COLOR
        assert!(color_decision(Auto, None, true));
        assert!(!color_decision(Auto, None, false));
        assert!(!color_decision(Auto, Some("1"), true));
        assert!(
            !color_decision(Auto, Some("0"), true),
            "any non-empty value disables colour"
        );
        assert!(!color_decision(Auto, Some("false"), true));
        assert!(
            color_decision(Auto, Some(""), true),
            "an empty NO_COLOR is ignored"
        );
        assert!(!color_decision(Auto, Some(""), false));
        // an explicit flag wins over the environment and the terminal
        assert!(color_decision(Always, Some("1"), false));
        assert!(color_decision(Always, None, false));
        assert!(!color_decision(Never, None, true));
        assert!(!color_decision(Never, Some(""), true));
    }

    #[test]
    fn color_flag_is_found_in_raw_arguments() {
        use ColorChoice::{Always, Auto, Never};
        assert_eq!(color_from_args(["memory", "--color=never"]), Never);
        assert_eq!(color_from_args(["--color", "always", "setup"]), Always);
        assert_eq!(
            color_from_args(["--color=always", "--color=never"]),
            Never,
            "the last one wins"
        );
        assert_eq!(
            color_from_args(["--", "--color=always"]),
            Auto,
            "`--` ends the scan"
        );
        assert_eq!(
            color_from_args(["--color=purple"]),
            Auto,
            "an unusable value is clap's to report"
        );
        assert_eq!(color_from_args(["--color"]), Auto);
        assert_eq!(color_from_args(Vec::<&str>::new()), Auto);
    }

    #[test]
    fn documented_exit_codes_match_the_mapping() {
        let doc =
            std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/errors.md"))
                .unwrap();
        let mut seen = 0;
        for line in doc.lines().filter_map(|l| l.strip_prefix("| `E_")) {
            let mut cols = line.split('|').map(str::trim);
            let code = format!("E_{}", cols.next().unwrap().trim_end_matches('`'));
            let exit: i32 = cols.next().unwrap().parse().unwrap();
            assert_eq!(
                exit_code_for(&code),
                exit,
                "docs/errors.md says {code} exits {exit}"
            );
            seen += 1;
        }
        assert!(seen >= 15, "sanity: saw {seen} documented codes");
    }
}
