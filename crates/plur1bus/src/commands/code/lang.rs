//! Small bilingual catalogue shared by both coding frontends; protocol documents retain their English keys.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct Language(pub bool);

impl Language {
    pub fn environment() -> Self {
        Self(
            ["LC_ALL", "LC_MESSAGES", "LANG"]
                .iter()
                .find_map(|key| std::env::var(key).ok().filter(|v| !v.is_empty()))
                .is_some_and(|v| v.starts_with("de")),
        )
    }

    pub fn text(self, english: &'static str, german: &'static str) -> &'static str {
        if self.0 {
            german
        } else {
            english
        }
    }
}
