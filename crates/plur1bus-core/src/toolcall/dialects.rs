//! Provider dialects of a tool definition (`toolcall/dialects.ts`): the wire envelope of each provider family, the
//! keywords a family cannot express (removed from the wire, listed as reductions, still validated locally), strict mode,
//! and the way back from strict mode's `null` sentinels. A tool name is checked here, when a catalogue is compiled, before
//! a provider can execute a call. The wire text is part of the provider's cache key, so member order is TypeScript's
//! (`fixtures/parity/toolcall/dialects.json`).
use super::json::{JsStr, Obj, V};
use super::quirks::lookup_quirks;
use super::validation::{assert_schema, Thrown};

/// A tool as a provider is told about it (`ToolDefinition`).
#[derive(Clone, Debug)]
pub struct ToolDefinition {
    /// The name.
    pub name: String,
    /// The description; absent compiles to an empty string.
    pub description: Option<String>,
    /// JSON Schema of the arguments object; absent compiles to an empty closed object.
    pub parameters: Option<V>,
}

impl ToolDefinition {
    /// `{ name, description, parameters }`.
    pub fn to_v(&self) -> V {
        let mut o = Obj::new();
        o.set("name", V::s(&self.name));
        if let Some(d) = &self.description {
            o.set("description", V::s(d));
        }
        if let Some(p) = &self.parameters {
            o.set("parameters", p.clone());
        }
        V::Obj(o)
    }
}

/// A keyword that did not reach the wire.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reduction {
    /// Where in the schema (`/properties/<name>/...`; names are not pointer-escaped).
    pub path: JsStr,
    /// The keyword.
    pub keyword: JsStr,
}

/// A compiled tool (`CompiledDialect`).
#[derive(Clone, Debug)]
pub struct CompiledDialect {
    /// The provider's envelope.
    pub wire: V,
    /// What the wire schema lost.
    pub reductions: Vec<Reduction>,
}

impl CompiledDialect {
    /// `{ wire, reductions }`.
    pub fn to_v(&self) -> V {
        let reductions = self
            .reductions
            .iter()
            .map(|r| {
                V::obj([
                    ("path", V::Str(r.path.clone())),
                    ("keyword", V::Str(r.keyword.clone())),
                ])
            })
            .collect();
        V::obj([
            ("wire", self.wire.clone()),
            ("reductions", V::Arr(reductions)),
        ])
    }
}

/// The options of [`compile_dialect`].
#[derive(Clone, Copy, Debug, Default)]
pub struct CompileOptions<'a> {
    /// Strict mode; absent takes the family's default.
    pub strict: Option<bool>,
    /// The model family whose limits apply; absent takes the wire family.
    pub model_family: Option<&'a str>,
}

/// `fromRegisteredTool`: name, description and input schema of a registered tool.
pub fn from_registered_tool(name: &str, description: &str, input_schema: &V) -> ToolDefinition {
    ToolDefinition {
        name: name.to_owned(),
        description: Some(description.to_owned()),
        parameters: Some(input_schema.clone()),
    }
}

const ANNOTATIONS: &[&str] = &[
    "$schema",
    "$id",
    "$comment",
    "default",
    "examples",
    "deprecated",
    "readOnly",
    "writeOnly",
];
const GEMINI_UNSUPPORTED: &[&str] = &[
    "allOf",
    "oneOf",
    "uniqueItems",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
    "minProperties",
    "maxProperties",
];

/// `new RegExp(pattern).test(name)`: no flags, so `$` is the end of the name and nothing else.
fn name_matches(pattern: &str, name: &[u16]) -> bool {
    regress::Regex::with_flags(pattern, regress::Flags::default())
        .is_ok_and(|re| re.find_from_ucs2(name, 0).next().is_some())
}

struct Converter<'a> {
    family: &'a str,
    strict: bool,
    reductions: Vec<Reduction>,
}

impl Converter<'_> {
    fn convert(&mut self, schema: &V, path: &JsStr) -> Result<V, Thrown> {
        let empty = Obj::new();
        let s = schema.as_obj().unwrap_or(&empty);
        let mut out = Obj::new();
        let mut notes: Vec<String> = Vec::new();
        for (key, v) in s.entries() {
            let k = key.lossy();
            let k = k.as_str();
            let annotation = ANNOTATIONS.contains(&k);
            if annotation || (self.family == "gemini" && GEMINI_UNSUPPORTED.contains(&k)) {
                self.reductions.push(Reduction {
                    path: path.clone(),
                    keyword: key.clone(),
                });
                if !annotation {
                    notes.push(format!("{k}={}", v.stringify()));
                }
                continue;
            }
            let converted = match (k, v) {
                ("properties", V::Obj(props)) => {
                    let mut pairs = Vec::with_capacity(props.len());
                    for (name, sub) in props.entries() {
                        let mut at = path.clone().plus("/properties/");
                        at.push(name);
                        pairs.push((name.clone(), self.convert(sub, &at)?));
                    }
                    V::Obj(Obj::from_pairs(pairs))
                }
                ("anyOf" | "oneOf" | "allOf", V::Arr(subs)) => {
                    let mut list = Vec::with_capacity(subs.len());
                    for (i, sub) in subs.iter().enumerate() {
                        list.push(self.convert(sub, &path.clone().plus(&format!("/{k}/{i}")))?);
                    }
                    V::Arr(list)
                }
                ("items" | "additionalProperties", V::Obj(_)) => {
                    self.convert(v, &path.clone().plus(&format!("/{k}")))?
                }
                _ => v.clone(),
            };
            out.set(key.clone(), converted);
        }
        if self.family == "gemini" {
            if let Some(c) = out.get("const").cloned() {
                out.set("enum", V::Arr(vec![c]));
                out.remove("const");
            }
        }
        if self.strict && out.get("type").is_some_and(|t| t.is_str("object")) {
            if !matches!(s.get("additionalProperties"), Some(V::Bool(false))) {
                return Err(Thrown::error(format!(
                    "strict objects must be closed at {path}"
                )));
            }
            let mut props = out
                .get("properties")
                .and_then(V::as_obj)
                .cloned()
                .unwrap_or_default();
            let required = s.get("required").and_then(V::as_arr).unwrap_or(&[]);
            let names: Vec<JsStr> = props
                .entries()
                .iter()
                .map(|(name, _)| name.clone())
                .collect();
            for name in &names {
                if required.iter().any(|r| r.as_js() == Some(name)) {
                    continue;
                }
                let child = props.get_js(name).cloned().unwrap_or(V::Null);
                // An optional property becomes nullable: by widening its one type where that is all it says about
                // types, else by a union with the null type.
                let widened = child.as_obj().and_then(|c| {
                    let plain = !c.get("anyOf").is_some_and(V::truthy)
                        && !c.get("enum").is_some_and(V::truthy)
                        && c.get("const").is_none();
                    let own = c
                        .get("type")
                        .filter(|t| plain && t.as_js().is_some())?
                        .clone();
                    let mut copy = c.clone();
                    copy.set("type", V::Arr(vec![own, V::s("null")]));
                    Some(V::Obj(copy))
                });
                let union = || {
                    V::obj([(
                        "anyOf",
                        V::Arr(vec![child.clone(), V::obj([("type", V::s("null"))])]),
                    )])
                };
                props.set(name.clone(), widened.unwrap_or_else(union));
            }
            out.set("properties", V::Obj(props));
            out.set("required", V::Arr(names.into_iter().map(V::Str).collect()));
            out.set("additionalProperties", V::Bool(false));
        }
        if !notes.is_empty() {
            let mut text = out
                .get("description")
                .filter(|d| d.truthy())
                .map(V::to_js_string);
            let note = format!("Internal validation constraints: {}", notes.join("; "));
            let description = match text.take() {
                Some(kept) => kept.plus("\n").plus(&note),
                None => JsStr::from(note),
            };
            out.set("description", V::Str(description));
        }
        Ok(V::Obj(out))
    }
}

/// `compileDialect`: the envelope `family` wants for `tool`. In order: the name against the model family's pattern and
/// length, strict mode against what the family supports, the schema's vocabulary, the root type, the conversion (strict
/// objects must be closed), the description's length.
pub fn compile_dialect(
    tool: &ToolDefinition,
    family: &str,
    options: &CompileOptions<'_>,
) -> Result<CompiledDialect, Thrown> {
    let quirks = lookup_quirks(options.model_family.unwrap_or(family), None);
    let name: Vec<u16> = tool.name.encode_utf16().collect();
    if name.len() > quirks.max_name_length || !name_matches(quirks.name_pattern, &name) {
        return Err(Thrown::error(format!(
            "invalid tool name for {family}: {}",
            tool.name
        )));
    }
    let strict = options.strict.unwrap_or(quirks.strict);
    if strict && (family == "gemini" || family == "anthropic" || !quirks.strict) {
        return Err(Thrown::error(format!(
            "strict mode unsupported by {family}"
        )));
    }
    let closed_empty = V::obj([
        ("type", V::s("object")),
        ("properties", V::Obj(Obj::new())),
        ("additionalProperties", V::Bool(false)),
    ]);
    let schema = tool.parameters.as_ref().unwrap_or(&closed_empty);
    assert_schema(schema)?;
    if !schema.get("type").is_some_and(|t| t.is_str("object")) {
        return Err(Thrown::error("tool parameters must be an object schema"));
    }
    let mut converter = Converter {
        family,
        strict,
        reductions: Vec::new(),
    };
    let converted = converter.convert(schema, &JsStr::default())?;
    let description = tool.description.as_deref().unwrap_or("");
    if description.encode_utf16().count() > quirks.max_description_length {
        return Err(Thrown::error(format!(
            "description exceeds {}",
            quirks.max_description_length
        )));
    }
    let (name, description) = (V::s(&tool.name), V::s(description));
    let wire = match family {
        "openai-chat" => V::obj([
            ("type", V::s("function")),
            (
                "function",
                V::obj([
                    ("name", name),
                    ("description", description),
                    ("parameters", converted),
                    ("strict", V::Bool(strict)),
                ]),
            ),
        ]),
        "openai-responses" => V::obj([
            ("type", V::s("function")),
            ("name", name),
            ("description", description),
            ("parameters", converted),
            ("strict", V::Bool(strict)),
        ]),
        "anthropic" => V::obj([
            ("name", name),
            ("description", description),
            ("input_schema", converted),
        ]),
        _ => V::obj([
            ("name", name),
            ("description", description),
            ("parametersJsonSchema", converted),
        ]),
    };
    Ok(CompiledDialect {
        wire,
        reductions: converter.reductions,
    })
}

/// `compileCatalogue`: every tool of a request, after the model family's tool count and the uniqueness of names.
pub fn compile_catalogue(
    tools: &[ToolDefinition],
    family: &str,
    model_family: Option<&str>,
) -> Result<Vec<CompiledDialect>, Thrown> {
    let model_family = model_family.unwrap_or(family);
    if tools.len() > lookup_quirks(model_family, None).max_tools {
        return Err(Thrown::error("too many tools for model family"));
    }
    let names: std::collections::HashSet<&str> = tools.iter().map(|t| t.name.as_str()).collect();
    if names.len() != tools.len() {
        return Err(Thrown::error("duplicate tool names"));
    }
    let options = CompileOptions {
        strict: None,
        model_family: Some(model_family),
    };
    tools
        .iter()
        .map(|t| compile_dialect(t, family, &options))
        .collect()
}

/// `restoreStrictArguments`: removes the `null` a strict-mode model writes for an optional property, where the original
/// schema does not allow `null` there. Required and nullable data is kept; the validator reports what is then wrong.
/// `schema` is the tool's own schema (one `assert_schema` accepted).
pub fn restore_strict_arguments(schema: &V, value: &V) -> V {
    match value {
        V::Obj(o) if schema.get("type").is_some_and(|t| t.is_str("object")) => {
            let props = schema.get("properties").and_then(V::as_obj);
            let required = schema.get("required").and_then(V::as_arr).unwrap_or(&[]);
            let mut pairs = Vec::with_capacity(o.len());
            for (key, v) in o.entries() {
                let sub = props.and_then(|p| p.get_js(key));
                let optional = sub.is_some() && !required.iter().any(|r| r.as_js() == Some(key));
                if optional && matches!(v, V::Null) && !sub.is_some_and(nullable) {
                    continue;
                }
                let kept = match sub.filter(|s| s.as_obj().is_some()) {
                    Some(sub) => restore_strict_arguments(sub, v),
                    None => v.clone(),
                };
                pairs.push((key.clone(), kept));
            }
            V::Obj(Obj::from_pairs(pairs))
        }
        V::Arr(a) => match schema.get("items").filter(|i| i.as_obj().is_some()) {
            Some(items) => V::Arr(
                a.iter()
                    .map(|v| restore_strict_arguments(items, v))
                    .collect(),
            ),
            None => value.clone(),
        },
        _ => value.clone(),
    }
}

/// `validateNullable`: whether the schema itself admits `null`.
fn nullable(schema: &V) -> bool {
    let null = |v: &V| matches!(v, V::Null);
    let t = schema.get("type");
    t.is_some_and(|t| t.is_str("null"))
        || t.and_then(V::as_arr)
            .is_some_and(|a| a.iter().any(|x| x.is_str("null")))
        || schema
            .get("enum")
            .and_then(V::as_arr)
            .is_some_and(|a| a.iter().any(null))
        || schema.get("const").is_some_and(null)
        || schema
            .get("anyOf")
            .and_then(V::as_arr)
            .is_some_and(|a| a.iter().any(|s| s.as_obj().is_some() && nullable(s)))
}
