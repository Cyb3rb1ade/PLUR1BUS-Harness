mod cli;
mod commands;
mod identity;
mod output;
mod paths;
use clap::Parser;
use cli::{Cli, Cmd};
use output::Out;

fn main() {
    let cli = Cli::parse();
    let out = Out { json: cli.json };
    let home = paths::resolve_home_from_process(cli.home.as_deref());
    let layout = paths::Layout::new(home);
    match cli.cmd {
        Cmd::Core {
            sub: cli::CoreCmd::Run,
        } => commands::core::run(&out, &layout),
        Cmd::Markdown => {
            print!("{}", clap_markdown::help_markdown::<Cli>());
        }
        Cmd::Setup(_) => commands::stubs::milestone(
            &out,
            "setup",
            "H2",
            "installer and service registration (spec §6.5)",
        ),
        Cmd::FirstAid { .. } => {
            commands::stubs::milestone(&out, "1staid", "H2", "check and repair (spec §6.6)")
        }
        Cmd::Module(_) => {
            commands::stubs::milestone(&out, "module", "H2", "module lifecycle and graph")
        }
        Cmd::Daemon(_) => commands::stubs::milestone(
            &out,
            "daemon",
            "H2",
            "supervisor control; in H1 start the core with `plur1bus core run`",
        ),
        Cmd::Service(_) => {
            commands::stubs::milestone(&out, "service", "H2", "OS service registration")
        }
        Cmd::Update(_) => commands::stubs::milestone(&out, "update", "H2", "manifest check"),
        Cmd::User(_) => commands::stubs::milestone(&out, "user", "M2", "users and roles (ADR-007)"),
        Cmd::Model(_) => commands::stubs::milestone(
            &out,
            "model",
            "M2",
            "provider profiles and model roles (D15)",
        ),
        Cmd::Login(_) => {
            commands::stubs::milestone(&out, "login", "M2", "API keys and OAuth templates (D16)")
        }
        Cmd::Channel(_) => commands::stubs::milestone(&out, "channel", "M4", "channels"),
        Cmd::Project(_) => commands::stubs::milestone(&out, "project", "M3", "projects"),
        Cmd::Import(_) => commands::stubs::milestone(
            &out,
            "import",
            "M1b-3",
            "OpenClaw/Hermes import (docs/import.md)",
        ),
        Cmd::Uninstall(_) => commands::stubs::milestone(&out, "uninstall", "M8", "uninstaller"),
        Cmd::Agent { .. } | Cmd::Memory { .. } | Cmd::Dreams { .. } | Cmd::Config { .. } => {
            commands::stubs::milestone(
                &out,
                "this",
                "H1",
                "implemented in Tasks 12–15 of this plan",
            )
        }
    }
}
