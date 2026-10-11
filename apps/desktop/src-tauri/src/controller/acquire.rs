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
            if path.is_absolute() || path.components().count() != 1 {
                return Err(CtlError::Bundle);
            }
            let loaded = self
                .runtime
                .image_load(&self.resource_dir.join(path))
                .await?;
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
