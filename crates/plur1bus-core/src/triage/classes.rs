//! Model classes and the profile table (`packages/core/src/triage/classes.ts`): which profile label a provider family
//! offers for a class. Profile labels, not live vendor model ids; a deployment maps allowed profiles into these rows.
use crate::approvals::js_json::J;
use crate::js::{js_trim, utf16_len};
use std::fmt;
use std::sync::OnceLock;

/// The classes, in ascending order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ModelClass {
    /// The smallest class.
    Small,
    /// The middle class.
    Medium,
    /// The large class.
    Large,
    /// The cap.
    Frontier,
}

/// `MODEL_CLASSES`: small < medium < large < frontier.
pub const MODEL_CLASSES: [ModelClass; 4] = [
    ModelClass::Small,
    ModelClass::Medium,
    ModelClass::Large,
    ModelClass::Frontier,
];

impl ModelClass {
    /// The TypeScript spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            ModelClass::Small => "small",
            ModelClass::Medium => "medium",
            ModelClass::Large => "large",
            ModelClass::Frontier => "frontier",
        }
    }

    /// The class of a TypeScript spelling.
    pub fn parse(text: &str) -> Option<ModelClass> {
        MODEL_CLASSES.into_iter().find(|c| c.as_str() == text)
    }

    /// The position in [`MODEL_CLASSES`].
    pub fn index(self) -> usize {
        self as usize
    }
}

const DEFAULTS: &str = include_str!("../../../../packages/core/src/triage/classes.defaults.json");

/// One row of the table: a provider family and its profile label per class, in the order of the file.
pub type ClassRow = (String, Vec<(ModelClass, String)>);

/// `CLASS_TABLE`: the rows of `classes.defaults.json`. Empty when the compiled-in file is unreadable, so nothing
/// resolves (fail closed); a unit test keeps that from shipping.
pub fn class_table() -> &'static [ClassRow] {
    static TABLE: OnceLock<Vec<ClassRow>> = OnceLock::new();
    TABLE.get_or_init(|| {
        let Some(J::Obj(families)) = J::parse(DEFAULTS) else {
            return Vec::new();
        };
        families
            .iter()
            .map(|(family, row)| {
                let profiles = MODEL_CLASSES
                    .into_iter()
                    .filter_map(|c| Some((c, row.get(c.as_str())?.as_str()?.to_owned())))
                    .collect();
                (family.clone(), profiles)
            })
            .collect()
    })
}

/// Why a class profile file was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClassProfileError {
    /// The text is not JSON.
    Json,
    /// The JSON is not an object of class to non-blank label of at most 128 code units.
    Invalid,
}

impl fmt::Display for ClassProfileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            ClassProfileError::Json => "class profile table is not JSON",
            ClassProfileError::Invalid => "invalid class profile table",
        })
    }
}

impl std::error::Error for ClassProfileError {}

/// `loadClassProfiles` without the read: `text` is the content of the file, `None` when it does not exist (then the
/// fallback holds). Read at a task boundary; a bad edit fails the decision safely rather than changing a running task.
pub fn parse_class_profiles(
    text: Option<&str>,
    fallback: &[(ModelClass, String)],
) -> Result<Vec<(ModelClass, String)>, ClassProfileError> {
    let Some(text) = text else {
        return Ok(fallback.to_vec());
    };
    let value = J::parse(text).ok_or(ClassProfileError::Json)?;
    if !matches!(value, J::Obj(_)) {
        return Err(ClassProfileError::Invalid);
    }
    value
        .members()
        .into_iter()
        .map(|(k, v)| {
            let class = ModelClass::parse(k).ok_or(ClassProfileError::Invalid)?;
            let label = v.as_str().ok_or(ClassProfileError::Invalid)?;
            if js_trim(label).is_empty() || utf16_len(label) > 128 {
                return Err(ClassProfileError::Invalid);
            }
            Ok((class, label.to_owned()))
        })
        .collect()
}

/// `resolveClass`: the first provider in the caller's order whose profile for the class is allowed
/// (`provider:profile`, matched exactly). No hidden fallback: a class without an allowed profile is `None`, never a
/// neighbouring class.
pub fn resolve_class(
    model_class: ModelClass,
    providers: &[&str],
    allowed: &dyn Fn(&str) -> bool,
) -> Option<(String, String)> {
    providers.iter().find_map(|provider| {
        let (_, row) = class_table()
            .iter()
            .find(|(family, _)| family == provider)?;
        let (_, profile) = row.iter().find(|(c, _)| *c == model_class)?;
        (!profile.is_empty() && allowed(&format!("{provider}:{profile}")))
            .then(|| ((*provider).to_owned(), profile.clone()))
    })
}
