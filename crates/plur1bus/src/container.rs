//! Container mode (ADR-012 §11, HB14): the harness image sets `PLUR1BUS_CONTAINER=1`. There `setup` and `update`
//! refuse with `E_NOT_AVAILABLE reason=container-managed`: the image, not the CLI, owns the installation.
//! Desktop D1 Task 3 reuses this file (O1).

/// Whether this process runs in the harness container: `PLUR1BUS_CONTAINER` is exactly `"1"`.
pub fn container_mode() -> bool {
    is_container_value(std::env::var("PLUR1BUS_CONTAINER").ok().as_deref())
}

fn is_container_value(v: Option<&str>) -> bool {
    v == Some("1")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn container_mode_only_for_exactly_1() {
        assert!(is_container_value(Some("1")));
        for v in [
            Some("true"),
            Some(""),
            Some(" 1"),
            Some("yes"),
            Some("0"),
            None,
        ] {
            assert!(!is_container_value(v), "{v:?}");
        }
    }
}
