//! D112 model role resolution and unavailable-role warnings.
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Available,
    Unavailable,
    Manual,
}

#[derive(Deserialize)]
pub struct Model {
    pub provider: String,
    pub id: String,
    pub aliases: Vec<String>,
    pub status: Status,
}

impl Model {
    fn matches(&self, selector: &str) -> bool {
        self.id == selector || self.aliases.iter().any(|alias| alias == selector)
    }

    fn available(&self) -> bool {
        self.status != Status::Unavailable
    }
}

#[derive(Serialize)]
pub struct Resolved<'a> {
    pub provider: &'a str,
    pub id: &'a str,
    pub state: &'static str,
}

/// Prefer the longest qualifying provider prefix, then consider a bare model
/// ID or alias. Within one group, keep the first available model.
pub fn resolve<'a>(selector: &str, models: &'a [Model]) -> Option<Resolved<'a>> {
    let mut qualified = None::<&Model>;
    let mut bare = None::<&Model>;
    for model in models {
        if selector
            .strip_prefix(&model.provider)
            .and_then(|rest| rest.strip_prefix('/'))
            .is_some_and(|rest| model.matches(rest))
            && qualified.is_none_or(|best| {
                model.provider.len() > best.provider.len()
                    || (model.provider == best.provider && model.available() && !best.available())
            })
        {
            qualified = Some(model);
        }
        if model.matches(selector) && bare.is_none_or(|best| model.available() && !best.available())
        {
            bare = Some(model);
        }
    }
    let chosen = qualified.or(bare)?;
    Some(Resolved {
        provider: &chosen.provider,
        id: &chosen.id,
        state: if chosen.available() {
            "available"
        } else {
            "unavailable"
        },
    })
}

#[derive(Serialize)]
pub struct Warning<'a> {
    code: &'static str,
    role: &'a str,
    provider: &'a str,
    id: &'a str,
}

pub fn warnings<'a>(
    models: &'a [Model],
    roles: impl IntoIterator<Item = (&'a str, &'a str)>,
    provider: Option<&str>,
) -> Vec<Warning<'a>> {
    roles
        .into_iter()
        .filter_map(|(role, selector)| {
            let resolved = resolve(selector, models)?;
            (resolved.state == "unavailable" && provider.is_none_or(|p| p == resolved.provider))
                .then_some(Warning {
                    code: "role_unavailable",
                    role,
                    provider: resolved.provider,
                    id: resolved.id,
                })
        })
        .collect()
}
