//! `plur1bus 1staid repair` (spec §6.6, HB16). The plan and its steps land in 2a-H3b-b Tasks 7 and 8.
use crate::cli::RepairArgs;
use crate::output::Out;
use crate::paths::Layout;

pub fn run(out: &Out, layout: &Layout, args: RepairArgs) -> ! {
    let _ = (layout, args);
    super::stubs::milestone(out, "1staid repair", "2a-H3b-b", "repair (spec §6.6)")
}
