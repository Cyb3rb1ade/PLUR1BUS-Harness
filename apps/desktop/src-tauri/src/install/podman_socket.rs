use super::verified::{self, Result};
use std::path::Path;
pub fn argv(flatpak: bool) -> (&'static str, Vec<&'static str>) {
    if flatpak {
        (
            "/usr/bin/flatpak-spawn",
            vec![
                "--host",
                "systemctl",
                "--user",
                "enable",
                "--now",
                "podman.socket",
            ],
        )
    } else {
        (
            "/usr/bin/systemctl",
            vec!["--user", "enable", "--now", "podman.socket"],
        )
    }
}
pub async fn enable() -> Result<()> {
    if !cfg!(target_os = "linux") {
        return Err("installer-platform");
    }
    let (program, args) = argv(std::env::var_os("FLATPAK_ID").is_some());
    verified::command(
        Path::new(program),
        &args.iter().map(|s| s.as_ref()).collect::<Vec<_>>(),
    )
    .await
}
