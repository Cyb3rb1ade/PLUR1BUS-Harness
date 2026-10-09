mod audit;
mod backup;
mod cli;
mod coexistence;
mod commands;
mod container;
mod ext;
mod firstaid_bundle;
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
mod update;
use cli::{Cli, Cmd};
use output::Out;

fn main() {
    let cli = cli::parse();
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
        Cmd::Completions { shell } => commands::completions::run(shell),
        Cmd::Manpages { dir } => commands::completions::manpages(&out, &dir),
        Cmd::Setup(args) => commands::setup::run(&out, &layout, args),
        Cmd::FirstAid {
            sub: cli::FirstAidCmd::Repair(args),
        } => commands::repair::run(&out, &layout, args),
        Cmd::FirstAid { sub } => commands::firstaid::run(&out, &layout, sub),
        Cmd::Module { sub } => commands::module::run(&out, &layout, sub),
        Cmd::Admin { sub } => commands::admin::run(&out, &layout, sub),
        Cmd::Backup { sub } => commands::backup::run(&out, &layout, sub),
        Cmd::Daemon { sub } => commands::daemon::run(&out, &layout, sub),
        Cmd::Service { sub } => commands::service::run(&out, &layout, sub),
        Cmd::Update(args) => commands::update::run(&out, &layout, args),
        Cmd::User { sub } => commands::user::run(&out, &layout, sub),
        Cmd::Model { sub } => commands::model::run(&out, &layout, sub),
        Cmd::Audit { sub } => commands::audit::run(&out, &layout, sub),
        Cmd::Budget { sub } => commands::budget::run(&out, &layout, sub),
        Cmd::Secret { sub } => commands::secret::run(&out, &layout, sub),
        Cmd::Grant { sub } => commands::grant::run(&out, &layout, sub),
        Cmd::Approval { sub } => commands::approval::run(&out, &layout, sub),
        Cmd::Login(args) => commands::login::run(&out, &layout, args),
        Cmd::Channel(_) => commands::stubs::milestone(&out, "channel", "M4", "channels"),
        Cmd::Project { sub } => commands::project::run(&out, &layout, sub),
        Cmd::Trace { sub } => commands::project::trace(&out, &layout, sub),
        Cmd::Media { sub } => commands::media::run(&out, &layout, sub),
        Cmd::Identity { sub } => commands::identity::run(&out, &layout, sub),
        Cmd::Import(args) => commands::import::run(&out, &layout, args),
        Cmd::Uninstall(args) => commands::uninstall::run(&out, &layout, args),
        Cmd::Agent { sub } => commands::agent::run(&out, &layout, sub),
        Cmd::Config { sub } => commands::config::run(&out, &layout, sub),
        Cmd::Memory { sub } => commands::memory::run(&out, &layout, sub),
        Cmd::Session { sub } => commands::session::run(&out, &layout, sub),
        Cmd::Chat(args) => commands::session::chat(&out, &layout, args),
        Cmd::Acp { sub } => commands::acp::run(&out, &layout, sub),
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
