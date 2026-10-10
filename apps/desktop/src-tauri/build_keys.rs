/// Release artifacts must provision both trust chains, except explicitly unsigned PR builds.
pub fn check<'a>(
    release: bool,
    allow_placeholder: bool,
    keys: impl IntoIterator<Item = &'a str>,
) -> Result<(), &'static str> {
    if release
        && !allow_placeholder
        && keys
            .into_iter()
            .any(|key| key.trim().is_empty() || key.contains("PLACEHOLDER"))
    {
        Err("release build refuses placeholder update keys")
    } else {
        Ok(())
    }
}
