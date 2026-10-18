use super::*;
impl Controller {
    pub(crate) async fn acquire(&self) -> Result<String, CtlError> {
        self.acquire_bundle(&self.bundle).await
    }
    pub(crate) async fn acquire_bundle(&self, bundle: &bundle::Bundle) -> Result<String, CtlError> {
        let arch = bundle::Arch::host();
        let digest = bundle
            .digest(arch)
            .map_err(|_| CtlError::Bundle)?
            .to_owned();
        if self.runtime.image_present(&digest).await? {
            return Ok(digest);
        }
        if let Some(Some(file)) = bundle.tarball.get(&arch) {
            let path = std::path::Path::new(file);
            let parts: Vec<_> = path.components().collect();
            if path.is_absolute()
                || parts.is_empty()
                || parts.len() > 2
                || parts
                    .iter()
                    .any(|p| !matches!(p, std::path::Component::Normal(_)))
                || (parts.len() == 2 && parts[0].as_os_str() != "image")
            {
                return Err(CtlError::Bundle);
            }
            // The release overlay maps resources directly into resource_dir. Refuse a
            // symlink at every payload component before passing a file to a runtime.
            let mut owned = self.resource_dir.clone();
            for part in parts {
                owned.push(part.as_os_str());
                let meta = std::fs::symlink_metadata(&owned).map_err(|_| CtlError::Bundle)?;
                if meta.is_symlink() {
                    return Err(CtlError::Bundle);
                }
            }
            if !owned.is_file() {
                return Err(CtlError::Bundle);
            }
            let loaded = self.runtime.image_load(&owned).await?;
            if loaded.rsplit('@').next() != Some(digest.as_str()) {
                return Err(CtlError::ImageDigest);
            }
        } else {
            self.runtime
                .image_pull(&bundle.reference(), &digest)
                .await?
        }
        Ok(digest)
    }
}
