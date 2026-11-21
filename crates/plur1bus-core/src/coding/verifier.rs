//! Selects the four review checks. Execution and isolation belong to the verifier port.
use crate::collab::{CollabError, CollabErrorCode as C};
use crate::js::utf16_len;
use crate::logs::methods::AbortSignal;
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;

pub(super) const MAX_VERIFIER_OUTPUT: usize = 65_536;

/// Ordered verifier steps.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CheckKind {
    /// Formatting verification.
    Format,
    /// Lint verification.
    Lint,
    /// Type checking.
    Typecheck,
    /// Test suite.
    Test,
}

impl CheckKind {
    /// The four mandatory checks, in execution order.
    pub const ALL: [Self; 4] = [Self::Format, Self::Lint, Self::Typecheck, Self::Test];

    /// The manifest's key for this check.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Format => "format",
            Self::Lint => "lint",
            Self::Typecheck => "typecheck",
            Self::Test => "test",
        }
    }
}

/// Arguments for one check. No shell interpretation is permitted.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifierCommand {
    /// Semantic kind of check.
    pub kind: CheckKind,
    /// Program and individual arguments.
    pub argv: Vec<String>,
    /// A successful formatter must also produce no diagnostic text.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub empty_output: bool,
}

/// The committed convention selected for a coding worktree.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifierPlan {
    /// Language or explicit project configuration.
    pub toolchain: &'static str,
    /// Whether the checked configuration requests network access. Host policy remains authoritative.
    pub network_allowed: bool,
    /// Exactly four ordered checks.
    pub commands: Vec<VerifierCommand>,
}

/// A bounded verifier result from the sandbox port.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifierResult {
    /// Whether the check passed under the sandbox's policy.
    pub ok: bool,
    /// Exit status, if the process produced one.
    pub exit_code: Option<i32>,
    /// Operator-readable refusal reason.
    pub reason: Option<String>,
    /// Output to hash or redact before release.
    pub output: String,
}

/// The host's sandboxed verifier. An unavailable sandbox must refuse.
pub trait Verifier {
    /// Runs one checked argv with the supplied root and cancellation.
    fn run(
        &self,
        root: &str,
        command: &VerifierCommand,
        network_allowed: bool,
        abort: &AbortSignal,
    ) -> VerifierResult;
}

fn invalid(message: impl Into<String>) -> CollabError {
    CollabError::new(C::Invalid, message)
}

fn parse(text: &str) -> Result<Value, CollabError> {
    serde_json::from_str(text).map_err(|_| CollabError::raw("malformed verifier conventions"))
}

fn convention(text: &str) -> Result<VerifierPlan, CollabError> {
    let config = parse(text)?;
    let config = config
        .as_object()
        .filter(|map| {
            map.keys()
                .all(|key| matches!(key.as_str(), "commands" | "networkAllowed"))
        })
        .ok_or_else(|| invalid("invalid verifier conventions"))?;
    let mut commands = Vec::with_capacity(CheckKind::ALL.len());
    for kind in CheckKind::ALL {
        let missing = || invalid(format!("missing verifier: {}", kind.as_str()));
        let args = config
            .get("commands")
            .and_then(|all| all.get(kind.as_str()))
            .and_then(Value::as_array)
            .filter(|args| (1..=32).contains(&args.len()))
            .ok_or_else(missing)?;
        let argv = args
            .iter()
            .map(|arg| {
                arg.as_str()
                    .filter(|s| !s.is_empty() && utf16_len(s) <= 4096 && !s.contains('\0'))
                    .map(str::to_owned)
                    .ok_or_else(missing)
            })
            .collect::<Result<Vec<_>, _>>()?;
        commands.push(VerifierCommand {
            kind,
            argv,
            empty_output: false,
        });
    }
    Ok(VerifierPlan {
        toolchain: "project",
        network_allowed: config.get("networkAllowed").and_then(Value::as_bool) == Some(true),
        commands,
    })
}

fn default_plan(
    toolchain: &'static str,
    argv: [Vec<String>; 4],
    require_empty_format: bool,
) -> VerifierPlan {
    let commands = CheckKind::ALL
        .into_iter()
        .zip(argv)
        .map(|(kind, argv)| VerifierCommand {
            kind,
            argv,
            empty_output: require_empty_format && kind == CheckKind::Format,
        })
        .collect();
    VerifierPlan {
        toolchain,
        network_allowed: false,
        commands,
    }
}

fn plan(toolchain: &'static str, argv: [&[&str]; 4]) -> VerifierPlan {
    default_plan(
        toolchain,
        argv.map(|args| args.iter().map(|s| (*s).to_owned()).collect()),
        toolchain == "go",
    )
}

fn node_plan(text: &str, pnpm_lock: bool, windows: bool) -> Result<VerifierPlan, CollabError> {
    let package = parse(text)?;
    if package.is_null() {
        return Err(CollabError::raw("malformed package manifest"));
    }
    let manager = if pnpm_lock
        || package["packageManager"]
            .as_str()
            .is_some_and(|s| s.starts_with("pnpm@"))
    {
        "pnpm"
    } else {
        "npm"
    };
    let scripts = &package["scripts"];
    let sep = if windows { '\\' } else { '/' };
    let choose = |names: &[&str], bin: &str, fallback: &[&str]| {
        if let Some(chosen) = names.iter().find(|name| scripts[**name].is_string()) {
            vec![manager.to_owned(), "run".to_owned(), (*chosen).to_owned()]
        } else {
            std::iter::once(format!("node_modules{sep}.bin{sep}{bin}"))
                .chain(fallback.iter().map(|arg| (*arg).to_owned()))
                .collect()
        }
    };
    Ok(default_plan(
        "node",
        [
            choose(
                &["format:check", "check:format", "format"],
                "prettier",
                &["--check", "."],
            ),
            choose(&["lint"], "eslint", &["."]),
            choose(&["typecheck", "check:types"], "tsc", &["--noEmit"]),
            choose(&["test"], "test-runner", &[]),
        ],
        false,
    ))
}

/// Detect verifier commands only from the nine supported manifest names.
pub fn detect_verifiers(
    files: &BTreeMap<String, String>,
    windows: bool,
) -> Result<VerifierPlan, CollabError> {
    let file = |name: &str| {
        files
            .get(name)
            .filter(|text| !text.is_empty())
            .map(String::as_str)
    };
    if let Some(text) = file(".plur1bus-verifiers.json") {
        return convention(text);
    }
    if let Some(text) = file("package.json") {
        return node_plan(text, file("pnpm-lock.yaml").is_some(), windows);
    }
    if file("pyproject.toml").is_some() || file("requirements.txt").is_some() {
        return Ok(plan(
            "python",
            [
                &["ruff", "format", "--check", "."],
                &["ruff", "check", "."],
                &["mypy", "."],
                &["pytest"],
            ],
        ));
    }
    if file("Cargo.toml").is_some() {
        return Ok(plan(
            "rust",
            [
                &["cargo", "fmt", "--all", "--", "--check"],
                &[
                    "cargo",
                    "clippy",
                    "--workspace",
                    "--all-targets",
                    "--offline",
                    "--",
                    "-D",
                    "warnings",
                ],
                &["cargo", "check", "--workspace", "--offline"],
                &["cargo", "test", "--workspace", "--offline"],
            ],
        ));
    }
    if file("go.mod").is_some() {
        return Ok(plan(
            "go",
            [
                &["gofmt", "-l", "."],
                &["go", "vet", "./..."],
                &["go", "test", "-run", "^$", "./..."],
                &["go", "test", "./..."],
            ],
        ));
    }
    if file("build.gradle").is_some() || file("build.gradle.kts").is_some() {
        return Ok(plan(
            "java",
            [
                &["./gradlew", "--offline", "spotlessCheck"],
                &["./gradlew", "--offline", "checkstyleMain"],
                &["./gradlew", "--offline", "compileJava"],
                &["./gradlew", "--offline", "test"],
            ],
        ));
    }
    Err(invalid(
        "no supported coding toolchain or project conventions",
    ))
}

#[cfg(test)]
#[path = "verifier_vectors.rs"]
mod vectors;
