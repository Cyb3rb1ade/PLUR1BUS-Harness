//! `plur1bus update` (spec §6.5). `--check` lands in 2a-H3b-b Task 5 and refuses in container mode (HB14); applying
//! an update (without `--check`) is M8.
use crate::cli::UpdateArgs;
use crate::output::Out;
use crate::paths::Layout;

pub fn run(out: &Out, layout: &Layout, args: UpdateArgs) -> ! {
    let _ = layout;
    if !args.check {
        super::stubs::milestone(
            out,
            "update",
            "M8",
            "downloading and applying a release (`update --check` shows what it would change)",
        );
    }
    super::refuse_in_container(out, "update --check");
    super::stubs::milestone(
        out,
        "update --check",
        "2a-H3b-b",
        "release manifest check (spec §6.5)",
    )
}
