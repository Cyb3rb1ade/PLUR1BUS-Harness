//! `plur1bus setup` (spec §6.5, H3b-b-1). The installer steps land in 2a-H3b-b Task 4; until then the command
//! refuses in container mode (HB14) and otherwise answers the milestone stub.
use crate::cli::SetupArgs;
use crate::output::Out;
use crate::paths::Layout;

pub fn run(out: &Out, layout: &Layout, args: SetupArgs) -> ! {
    let _ = (layout, args);
    super::refuse_in_container(out, "setup");
    super::stubs::milestone(
        out,
        "setup",
        "2a-H3b-b",
        "installer and service registration (spec §6.5)",
    )
}
