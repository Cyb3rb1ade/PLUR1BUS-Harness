//! A2A SDK 1.0 JSON names and defaults for the fields covered by a card signature.
use serde_json::{Map, Value};

enum Shape {
    Text,
    Flag,
    OnFlag,
    Document,
    Record(&'static [Field]),
    List(&'static Shape),
    Dictionary(&'static Shape),
    Choice(&'static [Field]),
}

struct Field(&'static str, &'static str, Shape);

use Shape::*;

const TEXT_LIST: Shape = List(&Text);
const REQUIREMENTS: Shape = List(&Record(&[Field(
    "schemes",
    "schemes",
    Dictionary(&Record(&[Field("list", "list", TEXT_LIST)])),
)]));
const AUTHORIZATION_URL: Field = Field("authorizationUrl", "authorization_url", Text);
const DEVICE_URL: Field = Field("deviceAuthorizationUrl", "device_authorization_url", Text);
const TOKEN_URL: Field = Field("tokenUrl", "token_url", Text);
const REFRESH_URL: Field = Field("refreshUrl", "refresh_url", Text);
const SCOPES: Field = Field("scopes", "scopes", Dictionary(&Text));
const AUTHORIZATION_CODE: Shape = Record(&[
    AUTHORIZATION_URL,
    TOKEN_URL,
    REFRESH_URL,
    SCOPES,
    Field("pkceRequired", "pkce_required", OnFlag),
]);
const CLIENT_OR_PASSWORD: Shape = Record(&[TOKEN_URL, REFRESH_URL, SCOPES]);
const IMPLICIT: Shape = Record(&[AUTHORIZATION_URL, REFRESH_URL, SCOPES]);
const DEVICE_CODE: Shape = Record(&[DEVICE_URL, TOKEN_URL, REFRESH_URL, SCOPES]);
const SCHEME: Shape = Choice(&[
    Field(
        "apiKeySecurityScheme",
        "api_key_security_scheme",
        Record(&[
            Field("description", "description", Text),
            Field("location", "location", Text),
            Field("name", "name", Text),
        ]),
    ),
    Field(
        "httpAuthSecurityScheme",
        "http_auth_security_scheme",
        Record(&[
            Field("description", "description", Text),
            Field("scheme", "scheme", Text),
            Field("bearerFormat", "bearer_format", Text),
        ]),
    ),
    Field(
        "oauth2SecurityScheme",
        "oauth2_security_scheme",
        Record(&[
            Field("description", "description", Text),
            Field("oauth2MetadataUrl", "oauth2_metadata_url", Text),
            Field(
                "flows",
                "flows",
                Choice(&[
                    Field(
                        "authorizationCode",
                        "authorization_code",
                        AUTHORIZATION_CODE,
                    ),
                    Field(
                        "clientCredentials",
                        "client_credentials",
                        CLIENT_OR_PASSWORD,
                    ),
                    Field("implicit", "implicit", IMPLICIT),
                    Field("password", "password", CLIENT_OR_PASSWORD),
                    Field("deviceCode", "device_code", DEVICE_CODE),
                ]),
            ),
        ]),
    ),
    Field(
        "openIdConnectSecurityScheme",
        "open_id_connect_security_scheme",
        Record(&[
            Field("description", "description", Text),
            Field("openIdConnectUrl", "open_id_connect_url", Text),
        ]),
    ),
    Field(
        "mtlsSecurityScheme",
        "mtls_security_scheme",
        Record(&[Field("description", "description", Text)]),
    ),
]);
const CARD: Shape = Record(&[
    Field("name", "name", Text),
    Field("description", "description", Text),
    Field("version", "version", Text),
    Field("documentationUrl", "documentation_url", Text),
    Field("iconUrl", "icon_url", Text),
    Field(
        "supportedInterfaces",
        "supported_interfaces",
        List(&Record(&[
            Field("url", "url", Text),
            Field("tenant", "tenant", Text),
            Field("protocolBinding", "protocol_binding", Text),
            Field("protocolVersion", "protocol_version", Text),
        ])),
    ),
    Field(
        "provider",
        "provider",
        Record(&[
            Field("organization", "organization", Text),
            Field("url", "url", Text),
        ]),
    ),
    Field(
        "capabilities",
        "capabilities",
        Record(&[
            Field("streaming", "streaming", Flag),
            Field("pushNotifications", "push_notifications", Flag),
            Field("extendedAgentCard", "extended_agent_card", Flag),
            Field(
                "extensions",
                "extensions",
                List(&Record(&[
                    Field("uri", "uri", Text),
                    Field("description", "description", Text),
                    Field("required", "required", OnFlag),
                    Field("params", "params", Document),
                ])),
            ),
        ]),
    ),
    Field("defaultInputModes", "default_input_modes", TEXT_LIST),
    Field("defaultOutputModes", "default_output_modes", TEXT_LIST),
    Field("securitySchemes", "security_schemes", Dictionary(&SCHEME)),
    Field(
        "securityRequirements",
        "security_requirements",
        REQUIREMENTS,
    ),
    Field(
        "skills",
        "skills",
        List(&Record(&[
            Field("id", "id", Text),
            Field("name", "name", Text),
            Field("description", "description", Text),
            Field("tags", "tags", TEXT_LIST),
            Field("examples", "examples", TEXT_LIST),
            Field("inputModes", "input_modes", TEXT_LIST),
            Field("outputModes", "output_modes", TEXT_LIST),
            Field(
                "securityRequirements",
                "security_requirements",
                REQUIREMENTS,
            ),
        ])),
    ),
]);

fn projected(value: &Value, shape: &Shape) -> Option<Value> {
    if value.is_null() {
        return Some(Value::Null);
    }
    match shape {
        Text => value.as_str().map(|_| value.clone()),
        Flag => value.as_bool().map(Value::Bool),
        OnFlag => value
            .as_bool()
            .map(|b| if b { Value::Bool(b) } else { Value::Null }),
        Document => value.as_object().map(|_| value.clone()),
        List(shape) => value
            .as_array()?
            .iter()
            .map(|v| projected(v, shape))
            .collect::<Option<Vec<_>>>()
            .map(Value::Array),
        Dictionary(shape) => value
            .as_object()?
            .iter()
            .map(|(k, v)| Some((k.clone(), projected(v, shape)?)))
            .collect::<Option<Map<_, _>>>()
            .map(Value::Object),
        Record(fields) | Choice(fields) => {
            let source = value.as_object()?;
            let mut out = Map::new();
            for Field(key, alias, field_shape) in *fields {
                let current = source.get(*key).filter(|v| !v.is_null());
                let alternate = source.get(*alias).filter(|v| !v.is_null() && alias != key);
                if current.is_some() && alternate.is_some() {
                    return None;
                }
                if let Some(v) = current.or(alternate) {
                    out.insert((*key).to_owned(), projected(v, field_shape)?);
                }
            }
            if matches!(shape, Choice(_)) && out.len() > 1 {
                return None;
            }
            Some(Value::Object(out))
        }
    }
}

fn remove_empty(v: Value) -> Option<Value> {
    match v {
        Value::Null => None,
        Value::String(s) if s.is_empty() => None,
        Value::Array(items) => {
            let items: Vec<_> = items.into_iter().filter_map(remove_empty).collect();
            (!items.is_empty()).then_some(Value::Array(items))
        }
        Value::Object(obj) => {
            let obj: Map<_, _> = obj
                .into_iter()
                .filter_map(|(k, v)| Some((k, remove_empty(v)?)))
                .collect();
            (!obj.is_empty()).then_some(Value::Object(obj))
        }
        v => Some(v),
    }
}

pub(super) fn normalize(card: &Value) -> Option<Value> {
    Some(remove_empty(projected(card, &CARD)?).unwrap_or_else(|| Value::Object(Map::new())))
}
