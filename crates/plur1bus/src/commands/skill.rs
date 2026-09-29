//! `plur1bus skill list|show|install|uninstall|restore|enable|disable` (spec §10.1): the shared `ext` verbs
//! (`super::ext::ext_verbs`) for kind `skill`, with per-agent selection on `enable`, `disable`, `list` and
//! `install --enable=<agent,…>` (X1-R11).
use super::ext::ext_verbs::{self as verbs, Verb};
use crate::cli::SkillCmd;
use crate::ext::commit::Agents;
use crate::output::Out;
use crate::paths::Layout;

pub fn run(out: &Out, layout: &Layout, cmd: SkillCmd) {
    let v = Verb::Skill;
    match cmd {
        SkillCmd::List {
            agent,
            source,
            state,
        } => verbs::list(out, layout, v, None, state, agent, source),
        SkillCmd::Show { name } => verbs::show(out, layout, v, &name),
        SkillCmd::Install {
            path,
            enable,
            flags,
        } => {
            // `--enable` alone (or with an empty list) is every agent; `--enable=bernd,anna` only those.
            let enable = enable.map(|l| {
                let l: Vec<String> = l.into_iter().filter(|a| !a.is_empty()).collect();
                if l.is_empty() {
                    Agents::All
                } else {
                    Agents::Some(l)
                }
            });
            verbs::install(out, layout, v, &path, enable, &flags)
        }
        SkillCmd::Uninstall {
            name,
            purge,
            cascade,
            yes,
        } => verbs::uninstall(out, layout, v, &name, purge, cascade, yes),
        SkillCmd::Restore { trash_id } => verbs::restore(out, layout, v, &trash_id),
        SkillCmd::Enable { name, agents, yes } => verbs::enable(out, layout, v, &name, agents, yes),
        SkillCmd::Disable { name, agents, yes } => {
            verbs::disable(out, layout, v, &name, agents, yes)
        }
    }
}
