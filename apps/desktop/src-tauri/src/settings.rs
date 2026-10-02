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

pub struct SettingsStore {
    dir: PathBuf,
}

impl SettingsStore {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    pub fn get(&self) -> Result<Settings, String> {
        let path = self.dir.join("settings.json");
        let file = match fs::File::open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Settings::default())
            }
            Err(error) => return Err(format!("settings read failed: {error}")),
        };
        let mut bytes = Vec::new();
        file.take(4097)
            .read_to_end(&mut bytes)
            .map_err(|error| format!("settings read failed: {error}"))?;
        if bytes.len() > 4096 {
            return Err("settings file exceeds 4096 bytes".into());
        }
        serde_json::from_slice(&bytes).map_err(|error| format!("settings parse failed: {error}"))
    }

    pub fn set(&self, settings: &Settings) -> Result<(), String> {
        fs::create_dir_all(&self.dir)
            .map_err(|error| format!("settings directory failed: {error}"))?;
        let bytes = serde_json::to_vec_pretty(settings)
            .map_err(|error| format!("settings serialization failed: {error}"))?;
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
