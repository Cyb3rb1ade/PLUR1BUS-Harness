//! Value-free schema diagnostics shared by the root configuration and installed module validators.
use jsonschema::error::{TypeKind, ValidationErrorKind};
use jsonschema::ValidationError;

/// Explain the failed constraint without formatting its instance, allowed values, patterns or arbitrary messages.
/// Callers add the structural configuration path separately; rejected credentials never enter this text.
pub fn validation_constraint(error: &ValidationError<'_>) -> String {
    match &error.kind {
        ValidationErrorKind::Required { property } => format!("{property} is a required property"),
        ValidationErrorKind::AdditionalProperties { unexpected }
        | ValidationErrorKind::UnevaluatedProperties { unexpected } => {
            format!("contains unsupported properties: {}", unexpected.join(", "))
        }
        ValidationErrorKind::Type { kind } => {
            let types = match kind {
                TypeKind::Single(kind) => kind.to_string(),
                TypeKind::Multiple(kinds) => kinds
                    .into_iter()
                    .map(|kind| kind.to_string())
                    .collect::<Vec<_>>()
                    .join(" or "),
            };
            format!("must be {types}")
        }
        ValidationErrorKind::MaxLength { limit } => {
            format!("must contain at most {limit} characters")
        }
        ValidationErrorKind::MinLength { limit } => {
            format!("must contain at least {limit} characters")
        }
        ValidationErrorKind::MaxItems { limit } => format!("must contain at most {limit} items"),
        ValidationErrorKind::MinItems { limit } => format!("must contain at least {limit} items"),
        ValidationErrorKind::MaxProperties { limit } => {
            format!("must contain at most {limit} properties")
        }
        ValidationErrorKind::MinProperties { limit } => {
            format!("must contain at least {limit} properties")
        }
        ValidationErrorKind::AdditionalItems { limit } => {
            format!("must contain at most {limit} items")
        }
        ValidationErrorKind::Maximum { limit } => format!("must be at most {limit}"),
        ValidationErrorKind::Minimum { limit } => format!("must be at least {limit}"),
        ValidationErrorKind::ExclusiveMaximum { limit } => format!("must be below {limit}"),
        ValidationErrorKind::ExclusiveMinimum { limit } => format!("must be above {limit}"),
        ValidationErrorKind::MultipleOf { multiple_of } => {
            format!("must be a multiple of {multiple_of}")
        }
        kind => fixed_constraint(kind).to_string(),
    }
}

fn fixed_constraint(kind: &ValidationErrorKind) -> &'static str {
    match kind {
        ValidationErrorKind::AdditionalProperties { .. }
        | ValidationErrorKind::UnevaluatedProperties { .. } => "contains unsupported properties",
        ValidationErrorKind::UnevaluatedItems { .. } => "contains unsupported items",
        ValidationErrorKind::Enum { .. } => "must be one of the allowed values",
        ValidationErrorKind::Constant { .. } => "must match the declared constant",
        ValidationErrorKind::Pattern { .. } => "must match the declared pattern",
        ValidationErrorKind::Format { .. } => "must match the declared format",
        ValidationErrorKind::AnyOf | ValidationErrorKind::OneOfNotValid => {
            "must match an allowed schema"
        }
        ValidationErrorKind::OneOfMultipleValid => "must match exactly one allowed schema",
        ValidationErrorKind::Not { .. } | ValidationErrorKind::FalseSchema => {
            "is not allowed by the schema"
        }
        ValidationErrorKind::Contains => "must contain an item matching the declared schema",
        ValidationErrorKind::UniqueItems => "must contain unique items",
        ValidationErrorKind::PropertyNames { .. } => {
            "contains a name that violates the declared constraints"
        }
        ValidationErrorKind::ContentEncoding { .. } | ValidationErrorKind::FromUtf8 { .. } => {
            "must match the declared content encoding"
        }
        ValidationErrorKind::ContentMediaType { .. } => {
            "must match the declared content media type"
        }
        _ => "does not satisfy the declared constraint",
    }
}
