mod audit;
mod cli;
mod coexistence;
mod commands;
mod container;
mod ext;
mod identity;
mod install;
mod journal;
mod modules;
mod output;
mod paths;
mod proc;
mod repair;
mod service;
mod supervisor;
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
        Cmd::Supervise { no_core } => {
            supervisor::run(&layout, supervisor::SuperviseOpts { no_core })
        }
        Cmd::Markdown => {
            output::say_raw(&clap_markdown::help_markdown::<Cli>());
        }
        Cmd::Setup(args) => commands::setup::run(&out, &layout, args),
        Cmd::FirstAid {
            sub: cli::FirstAidCmd::Repair(args),
        } => commands::repair::run(&out, &layout, args),
        Cmd::FirstAid { sub } => commands::firstaid::run(&out, &layout, sub),
        Cmd::Module { sub } => commands::module::run(&out, &layout, sub),
        Cmd::Admin { sub } => commands::admin::run(&out, &layout, sub),
        Cmd::Daemon { sub } => commands::daemon::run(&out, &layout, sub),
        Cmd::Service { sub } => commands::service::run(&out, &layout, sub),
        Cmd::Update(args) => commands::update::run(&out, &layout, args),
        Cmd::User(_) => commands::stubs::milestone(&out, "user", "M2", "users and roles (ADR-007)"),
        Cmd::Model { sub } => commands::model::run(&out, &layout, sub),
        Cmd::Secret { sub } => commands::secret::run(&out, &layout, sub),
        Cmd::Login(_) => {
            commands::stubs::milestone(&out, "login", "M2", "API keys and OAuth templates (D16)")
        }
        Cmd::Channel(_) => commands::stubs::milestone(&out, "channel", "M4", "channels"),
        Cmd::Project(_) => commands::stubs::milestone(&out, "project", "M3", "projects"),
        Cmd::Import(args) => commands::import::run(&out, &layout, args),
        Cmd::Uninstall(_) => commands::stubs::milestone(&out, "uninstall", "M8", "uninstaller"),
        Cmd::Agent { sub } => commands::agent::run(&out, &layout, sub),
        Cmd::Config { sub } => commands::config::run(&out, &layout, sub),
        Cmd::Memory { sub } => commands::memory::run(&out, &layout, sub),
        Cmd::Dreams { sub } => commands::dreams::run(&out, &layout, sub),
        Cmd::Ext {
            cmd: cli::ExtCmd::Worker { op },
        } => ext::stage::worker_main(&layout, op),
        Cmd::Ext { cmd } => commands::ext::run(&out, &layout, cmd),
        Cmd::Skill { sub } => commands::skill::run(&out, &layout, sub),
        Cmd::Plugin { sub } => commands::plugin::run(&out, &layout, sub),
    }
    // A real stdout write error (not a closed pipe) lost the output the caller asked for: do not report success.
    // Commands that end the process themselves go through `output::exit`, which applies the same rule.
    let code = output::final_exit_code(0);
    if code != 0 {
        std::process::exit(code);
    }
}
