#[path = "src/shell_commands.rs"]
mod shell_commands;

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(shell_commands::SHELL_COMMANDS)),
    )
    .expect("desktop application ACL generation failed");
}
