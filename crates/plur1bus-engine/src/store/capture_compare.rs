//! Capture rollback predicates compare every persisted column at the Lance deletion commit.
use super::{backend_error, Store};
use crate::contract::{MemoryRow, StoreError};
use serde_json::Value;

impl Store {
    pub(crate) fn delete_capture_admission_row(
        &self,
        expected: &MemoryRow,
    ) -> Result<(), StoreError> {
        self.writable()?;
        let value = serde_json::to_value(expected).map_err(|_| StoreError::InvalidInput)?;
        let object = value.as_object().ok_or(StoreError::InvalidInput)?;
        let mut terms = Vec::new();
        // Schema-owned column names, never caller SQL. Include vector elements as well as metadata.
        for field in self.schema.fields() {
            let name = field.name();
            let column = name.to_owned();
            let value = object.get(name).ok_or(StoreError::Corrupt)?;
            if name == "vector" {
                let vector = value.as_array().ok_or(StoreError::InvalidInput)?;
                let values = vector
                    .iter()
                    .map(scalar)
                    .collect::<Result<Vec<_>, _>>()?
                    .join(",");
                terms.push(format!(
                    "{column} = arrow_cast([{values}], 'FixedSizeList({}, Float32)')",
                    vector.len()
                ));
            } else {
                terms.push(format!("{column} = {}", scalar(value)?));
            }
        }
        while terms.len() > 1 {
            terms = terms
                .chunks(2)
                .map(|pair| {
                    if pair.len() == 2 {
                        format!("({} AND {})", pair[0], pair[1])
                    } else {
                        pair[0].clone()
                    }
                })
                .collect();
        }
        let filter = terms.pop().ok_or(StoreError::InvalidInput)?;
        let table = self.table.clone();
        self.executor
            .run(async move { table.delete(&filter).await.map_err(backend_error) })?;
        if self.get(&expected.id)?.is_some() {
            return Err(StoreError::Corrupt);
        }
        Ok(())
    }
}
fn scalar(value: &Value) -> Result<String, StoreError> {
    match value {
        Value::String(text) => Ok(super::super::filter::sql_string(text)),
        Value::Number(number) if number.as_f64().is_some_and(f64::is_finite) => {
            Ok(number.to_string())
        }
        Value::Bool(value) => Ok(value.to_string()),
        _ => Err(StoreError::InvalidInput),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    #[allow(clippy::unwrap_used, reason = "integration assertion")]
    fn deletion_compares_current_content_vector_and_authority() {
        let root = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let identity=serde_json::from_value(serde_json::json!({"provider":"fixture","model":"capture-compare","revision":"1","dimension":384,"normalization":"l2","prefixScheme":"fixture","instruction":"","dtype":"f32","tokenCap":null,"pooling":"mean","artifacts":[]})).unwrap();
        let pool = crate::store::StorePool::open(
            root.path(),
            crate::store::OpenMode::ReadWrite,
            Some(&identity),
            8,
        )
        .unwrap();
        let store = pool.get("agent").unwrap();
        let mut original = crate::capture::row_defaults::schema_defaults(vec![0.5; 384]);
        original.id = uuid::Uuid::new_v4().to_string();
        original.text = "A private row with a quoted ' value".into();
        original.stored_by = "agent".into();
        original.scope = "agent-private".into();
        original.emotional_intensity =
            serde_json::Number::from_f64(0.417_332_800_851_630_44).unwrap();
        for field in ["text", "vector", "owner"] {
            let mut edited = original.clone();
            match field {
                "text" => edited.text.push_str(" changed"),
                "vector" => edited.vector[0] = 0.75,
                _ => edited.owner_user_id = "other".into(),
            }
            store.upsert(&[edited.clone()]).unwrap();
            assert!(store.delete_capture_admission_row(&original).is_err());
            assert_eq!(store.get(&original.id).unwrap().unwrap().text, edited.text);
        }
        store.upsert(std::slice::from_ref(&original)).unwrap();
        store.delete_capture_admission_row(&original).unwrap();
        assert!(store.get(&original.id).unwrap().is_none());
    }
}
