use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, sync::LazyLock};
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Arch {
    Amd64,
    Arm64,
}
impl Arch {
    pub fn host() -> Self {
        if cfg!(target_arch = "aarch64") {
            Self::Arm64
        } else {
            Self::Amd64
        }
    }
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AppleReq {
    pub min: String,
    pub tested: String,
    pub pkg_url: String,
    pub pkg_sha256: String,
    pub team_id: String,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Bundle {
    pub version: String,
    pub registry: Option<String>,
    pub repository: String,
    pub images: BTreeMap<Arch, String>,
    pub tarball: BTreeMap<Arch, Option<String>>,
    pub apple: AppleReq,
    pub supported_image_majors: Vec<u64>,
    pub docker_min_api: String,
}
impl Bundle {
    pub fn digest(&self, arch: Arch) -> Result<&str, &'static str> {
        self.images
            .get(&arch)
            .map(String::as_str)
            .filter(|s| crate::runtime::spec::valid_digest(s))
            .ok_or("bundle-image")
    }
    pub fn validate_release(&self, allow_placeholder: bool) -> Result<(), &'static str> {
        for arch in [Arch::Amd64, Arch::Arm64] {
            let d = self.digest(arch)?;
            if !allow_placeholder && d == format!("sha256:{}", "0".repeat(64)) {
                return Err("placeholder-image");
            }
        }
        if !allow_placeholder && self.apple.pkg_sha256 == "0".repeat(64) {
            return Err("placeholder-apple-package");
        }
        Ok(())
    }
    pub fn reference(&self) -> String {
        self.registry
            .as_ref()
            .map(|r| format!("{r}/{}", self.repository))
            .unwrap_or_else(|| self.repository.clone())
    }
}
pub fn embedded() -> &'static Bundle {
    static B: LazyLock<Bundle> = LazyLock::new(|| {
        serde_json::from_str(include_str!("../../../bundle/bundle.json.tmpl"))
            .expect("embedded bundle schema")
    });
    &B
}
