//! Native desktop choices. No function accepts a renderer-supplied path.
use std::path::{Path, PathBuf};
pub type IntegrationResult<T> = Result<T, &'static str>;
const FOREIGN: &str = "DESKTOP_INTEGRATION_FOREIGN";
const STORAGE: &str = "DESKTOP_INTEGRATION_STORAGE";
const UNAVAILABLE: &str = "DESKTOP_INTEGRATION_UNAVAILABLE";
#[cfg(target_os = "linux")]
const ENTRY: &str = "app.plur1bus.desktop.desktop";

/// APPIMAGE is supplied by the launcher, never by shell IPC. Avoid the temporary
/// AppImage mount executable in menu/autostart registrations.
pub fn launch_executable() -> IntegrationResult<PathBuf> {
    #[cfg(target_os = "linux")]
    if let Some(image) = std::env::var_os("APPIMAGE") {
        let path = PathBuf::from(image);
        if !path.is_absolute() || !path.is_file() {
            return Err(UNAVAILABLE);
        }
        return Ok(path);
    }
    std::env::current_exe().map_err(|_| UNAVAILABLE)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Ownership {
    Absent,
    Owned,
    Foreign,
}
/// Injectable fixed-location OS adapter. Foreign shortcuts must never be changed.
pub trait DesktopIconAdapter {
    fn ownership(&self) -> IntegrationResult<Ownership>;
    /// Adapter must recheck ownership immediately before mutation.
    fn apply(&self, enabled: bool) -> IntegrationResult<()>;
}
pub fn icon_get(adapter: &impl DesktopIconAdapter) -> IntegrationResult<bool> {
    match adapter.ownership()? {
        Ownership::Absent => Ok(false),
        Ownership::Owned => Ok(true),
        Ownership::Foreign => Err(FOREIGN),
    }
}
pub fn icon_set(adapter: &impl DesktopIconAdapter, enabled: bool) -> IntegrationResult<bool> {
    if adapter.ownership()? == Ownership::Foreign {
        return Err(FOREIGN);
    }
    adapter.apply(enabled)?;
    let observed = icon_get(adapter)?;
    if observed != enabled {
        return Err("DESKTOP_INTEGRATION_NOT_APPLIED");
    }
    Ok(observed)
}

/// Injectable bounded file adapter; paths are created by native XDG resolution.
pub trait EntryIo {
    fn read(&self, path: &Path) -> IntegrationResult<Option<String>>;
    fn write(&self, path: &Path, contents: &str) -> IntegrationResult<()>;
    fn remove(&self, path: &Path) -> IntegrationResult<()>;
}
pub struct FileEntries;
fn safe_parents(path: &Path) -> IntegrationResult<()> {
    for ancestor in path.ancestors().skip(1) {
        match std::fs::symlink_metadata(ancestor) {
            Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {}
            Ok(_) => return Err(FOREIGN),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(STORAGE),
        }
    }
    Ok(())
}
impl EntryIo for FileEntries {
    fn read(&self, path: &Path) -> IntegrationResult<Option<String>> {
        safe_parents(path)?;
        match std::fs::symlink_metadata(path) {
            Ok(meta) if meta.is_file() && !meta.file_type().is_symlink() && meta.len() <= 16384 => {
                std::fs::read_to_string(path).map(Some).map_err(|_| STORAGE)
            }
            Ok(_) => Err(FOREIGN),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err(STORAGE),
        }
    }
    fn write(&self, path: &Path, contents: &str) -> IntegrationResult<()> {
        use std::io::Write;
        safe_parents(path)?;
        let parent = path.parent().ok_or(STORAGE)?;
        std::fs::create_dir_all(parent).map_err(|_| STORAGE)?;
        // Same-directory atomic replacement avoids partially updated launchers.
        let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|_| STORAGE)?;
        temp.write_all(contents.as_bytes()).map_err(|_| STORAGE)?;
        temp.as_file().sync_all().map_err(|_| STORAGE)?;
        temp.persist(path).map_err(|_| STORAGE)?;
        Ok(())
    }
    fn remove(&self, path: &Path) -> IntegrationResult<()> {
        safe_parents(path)?;
        std::fs::remove_file(path).map_err(|_| STORAGE)
    }
}
#[derive(Clone, Copy)]
pub enum EntryKind {
    Menu,
    Autostart,
}
fn entry_text(executable: &Path, kind: EntryKind) -> IntegrationResult<String> {
    let executable = executable
        .to_str()
        .filter(|s| !s.is_empty() && !s.contains('=') && !s.chars().any(char::is_control))
        .ok_or(UNAVAILABLE)?;
    let encoded: String = executable
        .as_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let mut command = String::from("\"");
    for c in executable.chars() {
        match c {
            '%' => command.push_str("%%"),
            '\\' | '"' | '$' | '`' => {
                command.push('\\');
                command.push(c);
            }
            _ => command.push(c),
        }
    }
    command.push('"');
    // Desktop-entry string decoding precedes Exec argument decoding.
    let mut command = command.replace('\\', "\\\\");
    if matches!(kind, EntryKind::Autostart) {
        command.push_str(" --autostart");
    } else {
        command.push_str(" %u");
    }
    Ok(format!("[Desktop Entry]\nType=Application\nName=PLUR1BUS\nExec={command}\nTerminal=false\nCategories=Utility;\nMimeType=x-scheme-handler/plur1bus;application/x-plur1bus-extension;\nX-PLUR1BUS-Owner=app.plur1bus.desktop\nX-PLUR1BUS-Executable={encoded}\n"))
}
fn is_owned(contents: &str, kind: EntryKind) -> bool {
    let Some(hex) = contents
        .lines()
        .find_map(|l| l.strip_prefix("X-PLUR1BUS-Executable="))
    else {
        return false;
    };
    if hex.len() > 8192 || !hex.len().is_multiple_of(2) {
        return false;
    }
    let decoded = (0..hex.len())
        .step_by(2)
        .map(|i| {
            hex.get(i..i + 2)
                .and_then(|h| u8::from_str_radix(h, 16).ok())
        })
        .collect::<Option<Vec<_>>>();
    let Some(path) = decoded.and_then(|b| String::from_utf8(b).ok()) else {
        return false;
    };
    Path::new(&path).is_absolute()
        && entry_text(Path::new(&path), kind).is_ok_and(|expected| expected == contents)
}
pub fn entry_get(io: &impl EntryIo, path: &Path, kind: EntryKind) -> IntegrationResult<bool> {
    match io.read(path)? {
        None => Ok(false),
        Some(text) if is_owned(&text, kind) => Ok(true),
        Some(_) => Err(FOREIGN),
    }
}
pub fn entry_set(
    io: &impl EntryIo,
    path: &Path,
    executable: &Path,
    kind: EntryKind,
    enabled: bool,
) -> IntegrationResult<bool> {
    if !executable.is_absolute() {
        return Err(UNAVAILABLE);
    }
    let present = entry_get(io, path, kind)?;
    if enabled {
        io.write(path, &entry_text(executable, kind)?)?;
    } else if present {
        io.remove(path)?;
    }
    let observed = entry_get(io, path, kind)?;
    if observed != enabled {
        return Err("DESKTOP_INTEGRATION_NOT_APPLIED");
    }
    Ok(observed)
}
/// Refresh enabled owned entries only. Absent means the person's choice remains off.
pub fn refresh_entries(
    io: &impl EntryIo,
    menu: &Path,
    autostart: &Path,
    executable: &Path,
) -> IntegrationResult<()> {
    // Preflight both entries so foreign content prevents all mutations.
    let menu_on = entry_get(io, menu, EntryKind::Menu)?;
    let auto_on = entry_get(io, autostart, EntryKind::Autostart)?;
    if menu_on {
        entry_set(io, menu, executable, EntryKind::Menu, true)?;
    }
    if auto_on {
        entry_set(io, autostart, executable, EntryKind::Autostart, true)?;
    }
    Ok(())
}
#[cfg(target_os = "linux")]
fn appimage_paths() -> IntegrationResult<(PathBuf, PathBuf, PathBuf)> {
    if std::env::var_os("FLATPAK_ID").is_some() || std::env::var_os("APPIMAGE").is_none() {
        return Err(UNAVAILABLE);
    }
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .ok_or(UNAVAILABLE)?;
    let xdg = |name, fallback| {
        std::env::var_os(name)
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .unwrap_or_else(|| home.join(fallback))
    };
    Ok((
        xdg("XDG_DATA_HOME", ".local/share")
            .join("applications")
            .join(ENTRY),
        xdg("XDG_CONFIG_HOME", ".config")
            .join("autostart")
            .join(ENTRY),
        launch_executable()?,
    ))
}
pub fn appimage_menu_get() -> IntegrationResult<bool> {
    native_entry(false, None)
}
pub fn appimage_menu_set(enabled: bool) -> IntegrationResult<bool> {
    native_entry(false, Some(enabled))
}
pub fn appimage_autostart_get() -> IntegrationResult<bool> {
    native_entry(true, None)
}
pub fn appimage_autostart_set(enabled: bool) -> IntegrationResult<bool> {
    native_entry(true, Some(enabled))
}
fn native_entry(autostart: bool, enabled: Option<bool>) -> IntegrationResult<bool> {
    #[cfg(target_os = "linux")]
    {
        let (menu, auto, exe) = appimage_paths()?;
        let (path, kind) = if autostart {
            (auto, EntryKind::Autostart)
        } else {
            (menu, EntryKind::Menu)
        };
        match enabled {
            Some(value) => entry_set(&FileEntries, &path, &exe, kind, value),
            None => entry_get(&FileEntries, &path, kind),
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (autostart, enabled);
        Err(UNAVAILABLE)
    }
}
pub fn refresh_on_launch() -> IntegrationResult<()> {
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("APPIMAGE").is_some() && std::env::var_os("FLATPAK_ID").is_none() {
            let (menu, auto, exe) = appimage_paths()?;
            return refresh_entries(&FileEntries, &menu, &auto, &exe);
        }
    }
    Ok(())
}

#[cfg(all(windows, not(feature = "store")))]
mod windows {
    use super::*;
    pub struct NativeIcon;
    // Constant script only; native executable comes from the process, no IPC paths.
    // A marker alone is insufficient: verify .lnk target AND empty arguments.
    const SCRIPT: &str = r#"
$ErrorActionPreference='Stop'
try {
  $desktop=[Environment]::GetFolderPath('DesktopDirectory')
  if ([string]::IsNullOrEmpty($desktop)) { throw 'unavailable' }
  $path=[IO.Path]::Combine($desktop,'PLUR1BUS.lnk')
  if ($env:PLUR1BUS_ICON_ACTION -eq 'get') { $key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\PLUR1BUS\DesktopInstaller') }
  else { $key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\PLUR1BUS\DesktopInstaller') }
  $owned=''
  if ($null -ne $key) { $owned=$key.GetValue('CreatedDesktop','') }
  if ($env:PLUR1BUS_ICON_ACTION -eq 'menuoff') {
    $owned=$key.GetValue('CreatedStartMenu','')
    if ($owned -eq '') { Write-Output 'absent'; exit 0 }
    $base=[IO.Path]::GetFullPath([Environment]::GetFolderPath('Programs')).TrimEnd('\')+'\'
    $path=[IO.Path]::GetFullPath($owned)
    if (!$path.StartsWith($base,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($path) -ne 'PLUR1BUS.lnk') { Write-Output 'foreign'; exit 0 }
    $parent=[IO.Path]::GetDirectoryName($path)
    while (($parent+'\').StartsWith($base,[StringComparison]::OrdinalIgnoreCase)) {
      if ((Get-Item -LiteralPath $parent -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { Write-Output 'foreign'; exit 0 }
      if (($parent+'\') -eq $base) { break }
      $parent=[IO.Path]::GetDirectoryName($parent)
    }
  }
  if ($owned -ne '' -and $owned -ne $path) { Write-Output 'foreign'; exit 0 }
  $exists=[IO.File]::Exists($path)
  $shell=New-Object -ComObject WScript.Shell
  if ($exists) {
    $item=Get-Item -LiteralPath $path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Write-Output 'foreign'; exit 0 }
    $link=$shell.CreateShortcut($path)
    if ($owned -ne $path -or $link.TargetPath -ne $env:PLUR1BUS_ICON_EXECUTABLE -or $link.Arguments -ne '') { Write-Output 'foreign'; exit 0 }
  } elseif (Test-Path -LiteralPath $path) { Write-Output 'foreign'; exit 0 }
  if ($env:PLUR1BUS_ICON_ACTION -eq 'on') {
    if (!$exists) { $link=$shell.CreateShortcut($path); $link.TargetPath=$env:PLUR1BUS_ICON_EXECUTABLE; $link.Arguments=''; $link.Save() }
    $key.SetValue('CreatedDesktop',$path,[Microsoft.Win32.RegistryValueKind]::String)
    $key.SetValue('DesktopIcon',1,[Microsoft.Win32.RegistryValueKind]::DWord)
    Write-Output 'owned'
  } elseif ($env:PLUR1BUS_ICON_ACTION -eq 'menuoff') {
    if ($exists) { [IO.File]::Delete($path) }
    $key.DeleteValue('CreatedStartMenu',$false)
    Write-Output 'absent'
  } elseif ($env:PLUR1BUS_ICON_ACTION -eq 'off') {
    if ($exists) { [IO.File]::Delete($path) }
    if ($owned -eq $path) { $key.DeleteValue('CreatedDesktop',$false) }
    $key.SetValue('DesktopIcon',0,[Microsoft.Win32.RegistryValueKind]::DWord)
    Write-Output 'absent'
  } elseif ($exists) { Write-Output 'owned' } else { Write-Output 'absent' }
  if ($null -ne $key) { $key.Dispose() }
} catch { Write-Output 'failed'; exit 1 }
"#;
    #[cfg(not(feature = "store"))]
    const AUTOSTART_SCRIPT: &str = r#"
$ErrorActionPreference='Stop'
try {
  $read=$env:PLUR1BUS_ICON_ACTION -eq 'get'
  if ($read) {
    $key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\PLUR1BUS\DesktopInstaller')
    $run=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Run')
  } else {
    $key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\PLUR1BUS\DesktopInstaller')
    $run=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\Microsoft\Windows\CurrentVersion\Run')
  }
  $expected='"'+$env:PLUR1BUS_ICON_EXECUTABLE+'" --autostart'
  $owned=''; $value=$null
  if ($null -ne $key) { $owned=$key.GetValue('OwnedAutostart','') }
  if ($null -ne $run) { $value=$run.GetValue('PLUR1BUS',$null) }
  if ($null -ne $value -and ($value -ne $expected -or $owned -ne $expected)) { Write-Output 'foreign'; exit 0 }
  if ($owned -ne '' -and $owned -ne $expected) { Write-Output 'foreign'; exit 0 }
  if ($env:PLUR1BUS_ICON_ACTION -eq 'on') {
    $run.SetValue('PLUR1BUS',$expected,[Microsoft.Win32.RegistryValueKind]::String)
    $key.SetValue('OwnedAutostart',$expected,[Microsoft.Win32.RegistryValueKind]::String)
    $key.SetValue('Autostart',1,[Microsoft.Win32.RegistryValueKind]::DWord)
    Write-Output 'owned'
  } elseif ($env:PLUR1BUS_ICON_ACTION -eq 'off') {
    if ($null -ne $value) { $run.DeleteValue('PLUR1BUS',$false) }
    if ($owned -eq $expected) { $key.DeleteValue('OwnedAutostart',$false) }
    $key.SetValue('Autostart',0,[Microsoft.Win32.RegistryValueKind]::DWord)
    Write-Output 'absent'
  } elseif ($null -ne $value) { Write-Output 'owned' } else { Write-Output 'absent' }
  if ($null -ne $run) { $run.Dispose() }; if ($null -ne $key) { $key.Dispose() }
} catch { Write-Output 'failed'; exit 1 }
"#;
    fn run_script(action: &str, script: &str) -> IntegrationResult<Ownership> {
        use std::os::windows::process::CommandExt;
        let root = std::env::var_os("SystemRoot")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .ok_or(UNAVAILABLE)?;
        let mut child =
            std::process::Command::new(root.join("System32/WindowsPowerShell/v1.0/powershell.exe"))
                .args([
                    "-NoLogo",
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    script,
                ])
                .env("PLUR1BUS_ICON_EXECUTABLE", launch_executable()?)
                .env("PLUR1BUS_ICON_ACTION", action)
                .creation_flags(0x08000000)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null())
                .spawn()
                .map_err(|_| STORAGE)?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if std::time::Instant::now() < deadline => {
                    std::thread::sleep(std::time::Duration::from_millis(20))
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(STORAGE);
                }
            }
        }
        let output = child.wait_with_output().map_err(|_| STORAGE)?;
        if !output.status.success() {
            return Err(STORAGE);
        }
        match String::from_utf8_lossy(&output.stdout).trim() {
            "owned" => Ok(Ownership::Owned),
            "absent" => Ok(Ownership::Absent),
            "foreign" => Ok(Ownership::Foreign),
            _ => Err(STORAGE),
        }
    }
    pub fn remove_start_menu() -> IntegrationResult<()> {
        match run_script("menuoff", SCRIPT)? {
            Ownership::Absent => Ok(()),
            Ownership::Foreign => Err(FOREIGN),
            Ownership::Owned => Err("DESKTOP_INTEGRATION_NOT_APPLIED"),
        }
    }
    impl DesktopIconAdapter for NativeIcon {
        fn ownership(&self) -> IntegrationResult<Ownership> {
            run_script("get", SCRIPT)
        }
        fn apply(&self, enabled: bool) -> IntegrationResult<()> {
            if run_script(if enabled { "on" } else { "off" }, SCRIPT)? == Ownership::Foreign {
                Err(FOREIGN)
            } else {
                Ok(())
            }
        }
    }
    #[cfg(not(feature = "store"))]
    pub fn autostart_get() -> IntegrationResult<bool> {
        match run_script("get", AUTOSTART_SCRIPT)? {
            Ownership::Absent => Ok(false),
            Ownership::Owned => Ok(true),
            Ownership::Foreign => Err(FOREIGN),
        }
    }
    #[cfg(not(feature = "store"))]
    pub fn autostart_set(enabled: bool) -> IntegrationResult<bool> {
        if run_script(if enabled { "on" } else { "off" }, AUTOSTART_SCRIPT)? == Ownership::Foreign {
            return Err(FOREIGN);
        }
        let observed = autostart_get()?;
        if observed != enabled {
            return Err("DESKTOP_INTEGRATION_NOT_APPLIED");
        }
        Ok(observed)
    }
}
pub fn desktop_icon_get() -> IntegrationResult<bool> {
    #[cfg(all(windows, not(feature = "store")))]
    {
        icon_get(&windows::NativeIcon)
    }
    #[cfg(any(not(windows), feature = "store"))]
    {
        Err(UNAVAILABLE)
    }
}
pub fn desktop_icon_set(enabled: bool) -> IntegrationResult<bool> {
    #[cfg(all(windows, not(feature = "store")))]
    {
        icon_set(&windows::NativeIcon, enabled)
    }
    #[cfg(any(not(windows), feature = "store"))]
    {
        let _ = enabled;
        Err(UNAVAILABLE)
    }
}

/// Direct-distribution autostart only. Store builds must use StartupTask.
pub fn windows_autostart_get() -> IntegrationResult<bool> {
    #[cfg(all(windows, not(feature = "store")))]
    {
        windows::autostart_get()
    }
    #[cfg(any(not(windows), feature = "store"))]
    {
        Err(UNAVAILABLE)
    }
}
pub fn windows_autostart_set(enabled: bool) -> IntegrationResult<bool> {
    #[cfg(all(windows, not(feature = "store")))]
    {
        windows::autostart_set(enabled)
    }
    #[cfg(any(not(windows), feature = "store"))]
    {
        let _ = enabled;
        Err(UNAVAILABLE)
    }
}
/// App-only uninstall removes only independently verified owned integrations.
/// Foreign entries survive; an error reports incomplete cleanup to the caller.
pub fn remove_owned_entries() -> IntegrationResult<()> {
    #[cfg(all(windows, not(feature = "store")))]
    {
        let icon = desktop_icon_set(false).map(|_| ());
        let menu = windows::remove_start_menu();
        let auto = windows_autostart_set(false).map(|_| ());
        icon.and(menu).and(auto)
    }
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("APPIMAGE").is_some() && std::env::var_os("FLATPAK_ID").is_none() {
            let (menu, auto, exe) = appimage_paths()?;
            let menu = entry_set(&FileEntries, &menu, &exe, EntryKind::Menu, false).map(|_| ());
            let auto =
                entry_set(&FileEntries, &auto, &exe, EntryKind::Autostart, false).map(|_| ());
            return menu.and(auto);
        }
    }
    #[cfg(any(not(windows), feature = "store"))]
    {
        Ok(())
    }
}

#[cfg(all(test, feature = "store"))]
mod store_tests {
    #[test]
    fn store_desktop_choices_never_enter_direct_distribution_adapters() {
        assert_eq!(super::desktop_icon_get(), Err(super::UNAVAILABLE));
        assert_eq!(super::desktop_icon_set(true), Err(super::UNAVAILABLE));
        assert_eq!(super::desktop_icon_set(false), Err(super::UNAVAILABLE));
        #[cfg(windows)]
        assert_eq!(super::remove_owned_entries(), Ok(()));
    }
}
