//! D112 discovery reconciliation. Replays a provider's successful list without
//! reading the clock, changing scan metadata or selecting a model.

use std::{
    cmp::Ordering,
    collections::{BTreeMap, HashMap, HashSet},
    sync::LazyLock,
};

use chrono::{Days, NaiveDate};
use icu_collator::{options::CollatorOptions, CollatorBorrowed};
use icu_locale_core::locale;
use regex::{Regex, RegexBuilder};
use regex_syntax::ast::{parse::Parser, Ast, RepetitionKind, RepetitionRange};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::roles::{self, Status};

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Chat,
    Embedding,
    Tts,
    Asr,
    Image,
    Moderation,
    Rerank,
    Realtime,
    Unknown,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Capability {
    Tools,
    Vision,
    Reasoning,
    AudioIn,
    AudioOut,
    StructuredOutput,
    PromptCaching,
}

#[derive(Clone, Copy, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Scan,
    Table,
    Manual,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ReasoningStyle {
    Openrouter,
    Gemini,
    Ollama,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct Reasoning {
    pub supported: bool,
    pub style: ReasoningStyle,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Api {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<Kind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<Vec<Capability>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<Reasoning>,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overrides {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<Kind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<Vec<Capability>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aliases: Option<Vec<String>>,
}

#[derive(Deserialize, Serialize)]
pub struct RawEntry {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created: Option<i64>,
    #[serde(flatten)]
    pub api: Api,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Fields {
    pub display_name: String,
    pub kind: Kind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    pub capabilities: Vec<Capability>,
    pub aliases: Vec<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub provider: String,
    pub id: String,
    #[serde(flatten)]
    pub fields: Fields,
    pub status: Status,
    pub first_seen: String,
    pub last_seen: String,
    pub source: Source,
    pub overrides: Overrides,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api: Option<Api>,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct Catalog {
    #[serde(flatten)]
    pub header: BTreeMap<String, Value>,
    pub models: Vec<Model>,
}

#[derive(Deserialize)]
pub struct Input {
    pub catalog: Catalog,
    pub provider: String,
    pub raw: Vec<RawEntry>,
    pub now: String,
    pub vendor: Option<String>,
    /// Preserve the Core's role insertion order for the warning list.
    pub roles: Vec<(String, String)>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    Empty,
    Metadata,
}

impl Error {
    pub fn message(self) -> &'static str {
        match self {
            Self::Empty => "empty raw list",
            Self::Metadata => "invalid model metadata table",
        }
    }
}

#[derive(Serialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum Warning {
    ShadowedByManual {
        provider: String,
        id: String,
    },
    RoleUnavailable {
        role: String,
        provider: String,
        id: String,
    },
}

#[derive(Serialize)]
pub struct Output {
    pub catalog: Catalog,
    pub new: Vec<String>,
    pub reappeared: Vec<String>,
    pub unavailable: Vec<String>,
    pub unchanged: usize,
    pub shadowed: Vec<String>,
    pub warnings: Vec<Warning>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Rule {
    pattern: String,
    kind: Kind,
    context_window: Option<u64>,
    capabilities: Vec<Capability>,
    aliases: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct MetadataFile {
    schema: String,
    revision: String,
    vendors: BTreeMap<String, Vec<Rule>>,
}

pub struct Metadata {
    pub revision: String,
    sections: BTreeMap<String, Vec<(Regex, Rule)>>,
}

// The source admits the anchored, non-nested repetition subset. The AST is
// bounded by the 200 UTF-16 unit pattern ceiling before walking it.
fn supported(ast: &Ast, repeated: bool) -> bool {
    match ast {
        Ast::Repetition(rep) => {
            let repeats = match rep.op.kind {
                RepetitionKind::ZeroOrOne => false,
                RepetitionKind::Range(
                    RepetitionRange::Exactly(n) | RepetitionRange::Bounded(_, n),
                ) => n > 1,
                _ => true,
            };
            !(repeats && repeated) && supported(&rep.ast, repeated || repeats)
        }
        Ast::Group(group) => supported(&group.ast, repeated),
        Ast::Alternation(alt) => alt.asts.iter().all(|node| supported(node, repeated)),
        Ast::Concat(concat) => concat.asts.iter().all(|node| supported(node, repeated)),
        Ast::Flags(_) => false,
        _ => true,
    }
}

impl Metadata {
    pub fn load(json: &str) -> Result<Self, Error> {
        let file: MetadataFile = serde_json::from_str(json).map_err(|_| Error::Metadata)?;
        if file.schema != "plur1bus.model-metadata/1" || file.revision.is_empty() {
            return Err(Error::Metadata);
        }
        let mut patterns = HashSet::new();
        let mut aliases = HashSet::new();
        let mut sections = BTreeMap::new();
        for (vendor, rules) in file.vendors {
            let mut validated = Vec::with_capacity(rules.len());
            for rule in rules {
                if rule.pattern.encode_utf16().count() > 200
                    || !rule.pattern.starts_with('^')
                    || !rule.pattern.ends_with('$')
                    || !patterns.insert(rule.pattern.clone())
                    || rule.context_window == Some(0)
                    || rule
                        .aliases
                        .iter()
                        .flatten()
                        .any(|name| !aliases.insert(name.clone()))
                {
                    return Err(Error::Metadata);
                }
                let ast = Parser::new()
                    .parse(&rule.pattern)
                    .map_err(|_| Error::Metadata)?;
                if !supported(&ast, false) {
                    return Err(Error::Metadata);
                }
                let pattern = RegexBuilder::new(&rule.pattern)
                    .size_limit(1 << 20)
                    .build()
                    .map_err(|_| Error::Metadata)?;
                validated.push((pattern, rule));
            }
            sections.insert(vendor, validated);
        }
        Ok(Self {
            revision: file.revision,
            sections,
        })
    }

    pub(crate) fn effective(
        &self,
        vendor: Option<&str>,
        id: &str,
        api: &Api,
        overrides: &Overrides,
    ) -> (Fields, Source) {
        enrich(id, api, overrides, self.find(vendor, id))
    }

    fn find(&self, vendor: Option<&str>, id: &str) -> Option<&Rule> {
        vendor
            .filter(|name| *name != "generic")
            .into_iter()
            .chain(["generic"])
            .filter_map(|name| self.sections.get(name))
            .flatten()
            .find(|(pattern, _)| pattern.is_match(id))
            .map(|(_, rule)| rule)
    }
}

static TTS: LazyLock<Option<Regex>> = LazyLock::new(|| Regex::new("(^|[^a-z])tts([^a-z]|$)").ok());
static DATE: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"-([0-9]{4})-?([0-9]{2})-?([0-9]{2})").ok());

fn heuristic(id: &str) -> Kind {
    let id = id.to_lowercase();
    if id.contains("gpt-live") || id.contains("realtime") {
        Kind::Realtime
    } else if id.contains("embed") {
        Kind::Embedding
    } else if id.contains("rerank") {
        Kind::Rerank
    } else if id.contains("whisper") || id.contains("transcribe") {
        Kind::Asr
    } else if id.contains("speech") || TTS.as_ref().is_some_and(|re| re.is_match(&id)) {
        Kind::Tts
    } else if id.contains("moderation") {
        Kind::Moderation
    } else if ["dall-e", "imagen", "image"]
        .iter()
        .any(|word| id.contains(word))
    {
        Kind::Image
    } else {
        Kind::Unknown
    }
}

fn enrich(id: &str, raw: &Api, overrides: &Overrides, rule: Option<&Rule>) -> (Fields, Source) {
    let rule_filled = rule.is_some_and(|rule| {
        raw.kind.is_none()
            || (rule.context_window.is_some() && raw.context_window.is_none())
            || (!rule.capabilities.is_empty() && raw.capabilities.is_none())
    });
    let fields = Fields {
        display_name: overrides
            .display_name
            .as_ref()
            .or(raw.display_name.as_ref())
            .cloned()
            .unwrap_or_else(|| id.into()),
        kind: overrides
            .kind
            .or(raw.kind)
            .or(rule.map(|rule| rule.kind))
            .unwrap_or_else(|| heuristic(id)),
        context_window: overrides
            .context_window
            .or(raw.context_window)
            .or_else(|| rule.and_then(|value| value.context_window)),
        capabilities: overrides
            .capabilities
            .as_ref()
            .or(raw.capabilities.as_ref())
            .or_else(|| rule.map(|value| &value.capabilities))
            .cloned()
            .unwrap_or_default(),
        aliases: overrides
            .aliases
            .as_ref()
            .or_else(|| rule.and_then(|value| value.aliases.as_ref()))
            .cloned()
            .unwrap_or_default(),
    };
    (
        fields,
        if rule_filled {
            Source::Table
        } else {
            Source::Scan
        },
    )
}

fn parsed_date(id: &str) -> Option<NaiveDate> {
    let parts = DATE.as_ref()?.captures(id)?;
    let year: i32 = parts[1].parse().ok()?;
    let month: i32 = parts[2].parse().ok()?;
    let day: u64 = parts[3].parse().ok()?;
    // Date.UTC offsets the years 0–99 and normalizes overflowing month/day fields.
    let month_index = month - 1;
    let year = if year < 100 { year + 1900 } else { year } + month_index.div_euclid(12);
    let date =
        NaiveDate::from_ymd_opt(year, u32::try_from(month_index.rem_euclid(12)).ok()? + 1, 1)?;
    date.checked_add_days(Days::new(day))?.pred_opt()
}

static COLLATOR: LazyLock<Option<CollatorBorrowed<'static>>> = LazyLock::new(|| {
    CollatorBorrowed::try_new(locale!("en-US").into(), CollatorOptions::default()).ok()
});

/// Greater means the first claimant takes precedence.
fn compare(a: &Model, b: &Model, alias: &str, created: &HashMap<&str, Option<i64>>) -> Ordering {
    let user = |model: &Model| {
        model.source == Source::Manual
            || model
                .overrides
                .aliases
                .as_ref()
                .is_some_and(|items| items.iter().any(|value| value == alias))
    };
    let active = |model: &Model| model.status != Status::Unavailable;
    let primary = user(a)
        .cmp(&user(b))
        .then_with(|| active(a).cmp(&active(b)));
    if primary != Ordering::Equal {
        return primary;
    }
    let dates = |model: &Model| created.get(model.id.as_str()).copied().flatten();
    let (a_created, b_created) = (dates(a), dates(b));
    if a_created.is_some() || b_created.is_some() {
        return a_created.cmp(&b_created);
    }
    match (parsed_date(&a.id), parsed_date(&b.id)) {
        (Some(a), Some(b)) => a.cmp(&b),
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (None, None) => COLLATOR.as_ref().map_or_else(
            || b.id.cmp(&a.id),
            |collator| collator.compare(&b.id, &a.id),
        ),
    }
}

fn group_and_dedup(models: Vec<Model>, raw: &[RawEntry]) -> Vec<Model> {
    let created: HashMap<_, _> = raw
        .iter()
        .map(|entry| (entry.id.as_str(), entry.created))
        .collect();
    let mut positions = HashMap::<String, usize>::new();
    let mut groups: Vec<Vec<Model>> = Vec::new();
    for model in models {
        let index = *positions.entry(model.provider.clone()).or_insert_with(|| {
            groups.push(Vec::new());
            groups.len() - 1
        });
        groups[index].push(model);
    }
    for group in &mut groups {
        let mut winners = HashMap::new();
        for (index, model) in group.iter().enumerate() {
            for alias in &model.fields.aliases {
                let candidate = winners.entry(alias.clone()).or_insert(index);
                if compare(model, &group[*candidate], alias, &created).is_gt() {
                    *candidate = index;
                }
            }
        }
        for (index, model) in group.iter_mut().enumerate() {
            let mut all = HashSet::new();
            let repeated: HashSet<_> = model
                .fields
                .aliases
                .iter()
                .filter(|alias| !all.insert((*alias).clone()))
                .cloned()
                .collect();
            model
                .fields
                .aliases
                .retain(|alias| winners.get(alias) == Some(&index) && !repeated.contains(alias));
        }
    }
    groups.into_iter().flatten().collect()
}

pub fn apply(input: &Input, metadata: &Metadata) -> Result<Output, Error> {
    if input.raw.is_empty() {
        return Err(Error::Empty);
    }
    let mut positions: HashMap<&str, usize> = HashMap::new();
    let mut raw = Vec::new();
    for entry in &input.raw {
        let index = *positions.entry(&entry.id).or_insert_with(|| {
            raw.push(None);
            raw.len() - 1
        });
        raw[index] = Some(entry);
    }

    let (existing, mut models): (Vec<_>, Vec<_>) = input
        .catalog
        .models
        .iter()
        .cloned()
        .partition(|model| model.provider == input.provider);
    let mut output = Output {
        catalog: Catalog {
            header: input.catalog.header.clone(),
            models: Vec::new(),
        },
        new: Vec::new(),
        reappeared: Vec::new(),
        unavailable: Vec::new(),
        unchanged: 0,
        shadowed: Vec::new(),
        warnings: Vec::new(),
    };
    for model in &existing {
        if model.source == Source::Manual
            && positions
                .remove(model.id.as_str())
                .is_some_and(|index| raw[index].take().is_some())
        {
            output.shadowed.push(model.id.clone());
            output.warnings.push(Warning::ShadowedByManual {
                provider: input.provider.clone(),
                id: model.id.clone(),
            });
        }
    }
    let lookup = |id: &str| metadata.find(input.vendor.as_deref(), id);
    for mut model in existing {
        if model.source != Source::Manual {
            if let Some(entry) = positions
                .remove(model.id.as_str())
                .and_then(|index| raw[index].take())
            {
                if model.status == Status::Unavailable {
                    output.reappeared.push(model.id.clone());
                } else {
                    output.unchanged += 1;
                }
                (model.fields, model.source) =
                    enrich(&model.id, &entry.api, &model.overrides, lookup(&model.id));
                model.status = Status::Available;
                model.last_seen.clone_from(&input.now);
                model.api = Some(entry.api.clone());
            } else if model.status == Status::Available {
                output.unavailable.push(model.id.clone());
                model.status = Status::Unavailable;
            }
        }
        models.push(model);
    }
    for entry in raw.into_iter().flatten() {
        output.new.push(entry.id.clone());
        let overrides = Overrides::default();
        let (fields, source) = enrich(&entry.id, &entry.api, &overrides, lookup(&entry.id));
        models.push(Model {
            provider: input.provider.clone(),
            id: entry.id.clone(),
            fields,
            status: Status::Available,
            first_seen: input.now.clone(),
            last_seen: input.now.clone(),
            source,
            overrides,
            api: Some(entry.api.clone()),
        });
    }
    let models = group_and_dedup(models, &input.raw);
    let role_models: Vec<_> = models
        .iter()
        .map(|model| roles::Model {
            provider: model.provider.clone(),
            id: model.id.clone(),
            status: model.status,
            aliases: model.fields.aliases.clone(),
        })
        .collect();
    let role_names = input
        .roles
        .iter()
        .map(|(role, model)| (role.as_str(), model.as_str()));
    output.warnings.extend(
        roles::warnings(&role_models, role_names, Some(&input.provider))
            .into_iter()
            .map(|warning| Warning::RoleUnavailable {
                role: warning.role.into(),
                provider: warning.provider.into(),
                id: warning.id.into(),
            }),
    );
    output.catalog.models = models;
    Ok(output)
}

/// Re-enrich table-derived entries when the metadata revision changes.
/// Preserve saved overrides and scan/manual fields, then re-evaluate aliases.
pub fn reenrich<'a>(
    catalog: &Catalog,
    metadata: &Metadata,
    vendor_of: impl Fn(&str) -> Option<&'a str>,
) -> Catalog {
    let mut next = catalog.clone();
    for model in next
        .models
        .iter_mut()
        .filter(|model| model.source == Source::Table)
    {
        (model.fields, model.source) = metadata.effective(
            vendor_of(&model.provider),
            &model.id,
            model.api.as_ref().unwrap_or(&Api::default()),
            &model.overrides,
        );
    }
    next.header.insert(
        "tableRevision".into(),
        Value::String(metadata.revision.clone()),
    );
    next.models = group_and_dedup(next.models, &[]);
    next
}
