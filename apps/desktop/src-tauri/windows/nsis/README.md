# Per-user NSIS installer

`installer.nsi` derives from the Tauri CLI 2.12.0 template (MIT OR Apache-2.0):
https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.0/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi

The custom Options page owns the first-install desktop/start-menu/autostart choices.
`/S` keeps all selected; `/NODESKTOP`, `/NOSTARTMENU`, `/NOAUTOSTART` opt out.
`Software\PLUR1BUS\DesktopInstaller` records initial choices and ownership. Updates,
including a new installer without `/UPDATE`, never recreate deleted shortcuts or
reset app choices. No data-removal checkbox or recursive application-data deletion
ships in this template. The app's tiered uninstall checks its typed confirmation.
The OS uninstaller retains harness data, snapshots and keychain credentials.

Keep upstream resource/protocol handling and its own-target shortcut checks when
updating this template. Windows CI compiles the template for both architectures;
manual interactive/quiet installation is a release acceptance item.
