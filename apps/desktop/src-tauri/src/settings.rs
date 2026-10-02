use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    #[default]
    System,
    Light,
    Dark,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Locale {
    #[default]
    System,
    En,
    De,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    pub theme: Theme,
    pub locale: Locale,
}

// Disk data is extensible; the IPC Settings input above stays closed.
#[derive(Serialize, Deserialize, Default)]
#[serde(default)]
struct StoredSettings {
    theme: Theme,
    locale: Locale,
    #[serde(flatten)]
    extra: serde_json::Map<String, serde_json::Value>,
}

pub struct SettingsStore {
    dir: PathBuf,
}

impl SettingsStore {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    pub fn get(&self) -> Result<Settings, String> {
        let stored = self.read()?;
        Ok(Settings {
            theme: stored.theme,
            locale: stored.locale,
        })
    }

    fn read(&self) -> Result<StoredSettings, String> {
        let path = self.dir.join("settings.json");
        let file = match fs::File::open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(StoredSettings::default())
            }
            Err(error) => return Err(format!("settings read failed: {error}")),
        };
        let mut bytes = Vec::new();
        file.take(4097)
            .read_to_end(&mut bytes)
            .map_err(|error| format!("settings read failed: {error}"))?;
        if bytes.len() > 4096 {
            return self.preserve_failed_read("settings file exceeds 4096 bytes");
        }
        match serde_json::from_slice(&bytes) {
            Ok(stored) => Ok(stored),
            Err(error) => self.preserve_failed_read(&format!("settings parse failed: {error}")),
        }
    }

    fn preserve_failed_read(&self, reason: &str) -> Result<StoredSettings, String> {
        // Only move a regular file. An unreadable path or failed backup blocks saves.
        let path = self.dir.join("settings.json");
        if !fs::symlink_metadata(&path)
            .map_err(|e| format!("settings metadata failed: {e}"))?
            .is_file()
        {
            return Err(format!("{reason}; settings path is not a regular file"));
        }
        let backup = tempfile::Builder::new()
            .prefix("settings-recovered-")
            .suffix(".json")
            .tempfile_in(&self.dir)
            .map_err(|e| format!("{reason}; backup failed: {e}"))?;
        fs::rename(&path, backup.path())
            .map_err(|e| format!("{reason}; preservation failed: {e}"))?;
        backup
            .keep()
            .map_err(|e| format!("{reason}; retaining backup failed: {e}"))?;
        Err(format!(
            "{reason}; original settings preserved in a recovery file"
        ))
    }

    pub fn set(&self, settings: &Settings) -> Result<(), String> {
        // Re-read immediately before every save, including when settings_get failed.
        let mut stored = self.read()?;
        stored.theme = settings.theme;
        stored.locale = settings.locale;
        fs::create_dir_all(&self.dir)
            .map_err(|error| format!("settings directory failed: {error}"))?;
        let bytes = serde_json::to_vec_pretty(&stored)
            .map_err(|error| format!("settings serialization failed: {error}"))?;
        if bytes.len() > 4096 {
            return Err("settings file exceeds 4096 bytes".into());
        }
        let mut temporary = tempfile::Builder::new()
            .prefix(".settings-")
            .tempfile_in(&self.dir)
            .map_err(|error| format!("settings temporary file failed: {error}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            temporary
                .as_file()
                .set_permissions(fs::Permissions::from_mode(0o600))
                .map_err(|error| format!("settings permissions failed: {error}"))?;
        }
        temporary
            .write_all(&bytes)
            .map_err(|error| format!("settings write failed: {error}"))?;
        temporary
            .as_file()
            .sync_all()
            .map_err(|error| format!("settings sync failed: {error}"))?;
        temporary
            .persist(self.dir.join("settings.json"))
            .map_err(|error| format!("settings replace failed: {}", error.error))?;
        Ok(())
    }
}
