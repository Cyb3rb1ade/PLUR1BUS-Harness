//! `plur1bus plugin list|show|install|uninstall|restore|enable|disable` (spec §10.1): the shared `ext` verbs
//! (`super::ext::ext_verbs`) for kinds `module` and `channel`. There is no `--agent`: `modules.<name>.enabled` is a
//! module's only switch (X1-R11).
use super::ext::ext_verbs::{self as verbs, Verb};
use crate::cli::{PluginCmd, PluginKind};
use crate::ext::commit::Agents;
use crate::output::Out;
use crate::paths::Layout;

pub fn run(out: &Out, layout: &Layout, cmd: PluginCmd) {
    let v = Verb::Plugin;
    match cmd {
        PluginCmd::List { kind, state } => {
            let kind = kind.map(|k| match k {
                PluginKind::Module => "module",
                PluginKind::Channel => "channel",
                PluginKind::McpServer => "mcp-server",
                PluginKind::Bundle => "bundle",
            });
            verbs::list(out, layout, v, kind, state, None, None)
        }
        PluginCmd::Show { name } => verbs::show(out, layout, v, &name),
        PluginCmd::Install {
            path,
            enable,
            flags,
        } => {
            let agents = enable.map(|list| {
                if list.is_empty() {
                    Agents::All
                } else {
                    Agents::Some(list)
                }
            });
            verbs::install(out, layout, v, &path, agents, &flags)
        }
        PluginCmd::Uninstall {
            name,
            purge,
            cascade,
            yes,
        } => verbs::uninstall(out, layout, v, &name, purge, cascade, yes),
        PluginCmd::Restore { trash_id } => verbs::restore(out, layout, v, &trash_id),
        PluginCmd::Enable { name, agents, yes } => {
            verbs::enable(out, layout, v, &name, agents, yes)
        }
        PluginCmd::Disable { name, agents, yes } => {
            verbs::disable(out, layout, v, &name, agents, yes)
        }
    }
}
