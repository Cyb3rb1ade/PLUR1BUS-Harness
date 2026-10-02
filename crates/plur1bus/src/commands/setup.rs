//! `plur1bus setup` (spec §6.5, H3b-b-1): refuses in container mode (HB14), then runs the installer steps
//! (`install::setup`) and prints `setup/1`: `{ home, target, steps, manifest, check }`. Exit 0 when no step failed
//! and `1staid check` reported no failure; 1 otherwise.
use crate::cli::SetupArgs;
use crate::install::manifest;
use crate::install::setup::{self, Prompter, SetupOpts, StdinPrompter, StepResult};
use crate::install::targets::Target;
use crate::output::Out;
use crate::paths::Layout;
use serde_json::{json, Value};

/// With `--non-interactive` nothing is asked: every answer comes from the flags and the defaults.
struct NoPrompts;

impl Prompter for NoPrompts {
    fn ask(&mut self, _key: &str, _question: &str, default: &str) -> String {
        default.to_string()
    }
    fn confirm(&mut self, _question: &str) -> bool {
        false
    }
}

pub fn run(out: &Out, layout: &Layout, args: SetupArgs) -> ! {
    super::refuse_in_container(out, "setup");
    let opts = SetupOpts {
        non_interactive: args.non_interactive,
        accept_nc: args.accept_nc_licence,
        no_service: args.no_service,
        core_from: args.core_from,
        channel: args.channel,
        use_class: args.use_class,
        agent: args.agent,
        profile: args.profile,
    };
    let mut prompter: Box<dyn Prompter> = if opts.non_interactive {
        Box::new(NoPrompts)
    } else {
        Box::new(StdinPrompter)
    };
    let steps = setup::run_steps(out, layout, &opts, prompter.as_mut());
    let failed = steps.iter().any(|s| s.status == "failed");
    let check = steps
        .iter()
        .find(|s| s.id == "check" && s.status == "done")
        .map(|s| s.detail.clone());
    let manifest = if failed {
        Value::Null
    } else {
        match manifest::read(layout) {
            Ok(Some(m)) => serde_json::to_value(m).unwrap_or(Value::Null),
            _ => Value::Null,
        }
    };
    let check_failures = check.as_ref().and_then(|c| c["fail"].as_u64()).unwrap_or(0);
    let doc = json!({
        "home": layout.home,
        "target": Target::current().map(Target::id),
        "steps": steps,
        "manifest": manifest,
        "check": check,
    });
    out.ok("setup/1", &doc, || describe(&steps, check.as_ref()));
    std::process::exit(if failed || check_failures > 0 { 1 } else { 0 })
}

fn describe(steps: &[StepResult], check: Option<&Value>) -> String {
    let mut lines: Vec<String> = steps
        .iter()
        .map(|s| {
            let mut line = format!("{:<8} {}", s.status, s.id);
            if let Some(r) = &s.reason {
                line.push_str(&format!(" ({r})"));
            }
            if let Some(m) = s.detail["message"].as_str() {
                line.push_str(&format!(": {m}"));
            }
            if let Some(h) = s.detail["hint"].as_str() {
                line.push_str(&format!("\n         hint: {h}"));
            }
            line
        })
        .collect();
    if let Some(c) = check {
        lines.push(format!(
            "1staid check: {} ok, {} warn, {} fail{}",
            c["ok"],
            c["warn"],
            c["fail"],
            match c["failing"].as_array() {
                Some(f) if !f.is_empty() => format!(
                    " ({})",
                    f.iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
                _ => String::new(),
            }
        ));
    }
    lines.join("\n")
}
