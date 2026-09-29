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
            });
            verbs::list(out, layout, v, kind, state, None, None)
        }
        PluginCmd::Show { name } => verbs::show(out, layout, v, &name),
        PluginCmd::Install {
            path,
            enable,
            flags,
        } => verbs::install(out, layout, v, &path, enable.then_some(Agents::All), &flags),
        PluginCmd::Uninstall {
            name,
            purge,
            cascade,
            yes,
        } => verbs::uninstall(out, layout, v, &name, purge, cascade, yes),
        PluginCmd::Restore { trash_id } => verbs::restore(out, layout, v, &trash_id),
        PluginCmd::Enable { name, yes } => verbs::enable(out, layout, v, &name, vec![], yes),
        PluginCmd::Disable { name, yes } => verbs::disable(out, layout, v, &name, vec![], yes),
    }
}
