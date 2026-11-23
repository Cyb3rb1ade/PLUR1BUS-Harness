#![allow(clippy::unwrap_used, reason = "media store fixture assertions")]
use base64::{engine::general_purpose::STANDARD, Engine as _};
use plur1bus_media::{
    jobs::{Error, Result},
    output::{Backend, Image, ImageFormat, Images, OutputStore, Settings, Stage, WriteGuard},
};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    sync::{Mutex, MutexGuard},
    time::{Duration, Instant},
};

type Files = BTreeMap<String, Vec<u8>>;
type Published = BTreeMap<String, Files>;

#[derive(Default)]
struct Memory {
    visible: Mutex<Published>,
    fail_manifest: bool,
}

struct Guard<'a> {
    visible: MutexGuard<'a, Published>,
    fail_manifest: bool,
}

struct Staged<'a> {
    visible: &'a mut Published,
    files: Files,
    fail_manifest: bool,
}

impl Backend for Memory {
    type Guard<'a> = Guard<'a>;

    fn lock(&self, _: Instant) -> Result<Self::Guard<'_>> {
        Ok(Guard {
            visible: self.visible.lock().unwrap(),
            fail_manifest: self.fail_manifest,
        })
    }

    fn read_manifest(&self, id: &str, limit: usize, _: Instant) -> Result<Option<Vec<u8>>> {
        let dir = self.visible.lock().unwrap();
        let data = dir.get(id).and_then(|files| files.get("manifest.json"));
        if data.is_some_and(|data| data.len() > limit) {
            return Err(Error::Storage);
        }
        Ok(data.cloned())
    }
}

impl WriteGuard for Guard<'_> {
    type Stage<'a>
        = Staged<'a>
    where
        Self: 'a;

    fn contains(&self, id: &str, _: Instant) -> Result<bool> {
        Ok(self.visible.contains_key(id))
    }

    fn charged_bytes(&self, _: Instant) -> Result<u64> {
        Ok(self
            .visible
            .values()
            .flatten()
            .map(|(_, data)| data.len() as u64)
            .sum())
    }

    fn stage(&mut self, _: Instant) -> Result<Self::Stage<'_>> {
        Ok(Staged {
            visible: &mut self.visible,
            files: Files::new(),
            fail_manifest: self.fail_manifest,
        })
    }

    fn entries(&self, _: Instant) -> Result<Vec<(String, i64)>> {
        Ok(self
            .visible
            .iter()
            .map(|(id, files)| {
                let manifest: Value = serde_json::from_slice(&files["manifest.json"]).unwrap();
                (id.clone(), manifest["createdAt"].as_i64().unwrap())
            })
            .collect())
    }

    fn delete(&mut self, id: &str, _: Instant) -> Result<()> {
        self.visible.remove(id);
        Ok(())
    }
}

impl Stage for Staged<'_> {
    fn write_private(&mut self, name: &str, bytes: &[u8], _: Instant) -> Result<()> {
        if self.fail_manifest && name == "manifest.json" {
            return Err(Error::Storage);
        }
        assert!(self.files.insert(name.into(), bytes.to_vec()).is_none());
        Ok(())
    }

    fn publish(self, id: &str, _: Instant) -> Result<()> {
        assert!(self.files.contains_key("manifest.json"));
        assert!(self.visible.insert(id.into(), self.files).is_none());
        Ok(())
    }
}

#[test]
fn generated_output_matches_the_typescript_manifest_charge_and_retention() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../fixtures/parity/media/output-store.json"
    ))
    .unwrap();
    let input = &fixture["input"];
    let expected = &fixture["expected"];
    let bytes = STANDARD.decode(input["bytes"].as_str().unwrap()).unwrap();
    let now = input["now"].as_i64().unwrap();
    let id = input["id"].as_str().unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    let files = [Image {
        bytes: &bytes,
        format: ImageFormat::Png,
    }];
    let generated = Images {
        parameters: &input["request"],
        references: &[&bytes],
        mask: Some(&bytes),
        metadata: &input["metadata"],
        partial: input["partial"].as_bool().unwrap(),
        files: &files,
    };
    let memory = Memory::default();
    let store = OutputStore::new(
        &memory,
        Settings {
            retention_ms: Some(1000),
            ..Settings::default()
        },
    );
    assert_eq!(
        json!(store.put_images(id, &generated, now, deadline).unwrap()),
        expected["manifest"]
    );
    assert_eq!(json!(store.get(id, deadline).unwrap()), expected["get"]);
    assert_eq!(
        memory
            .lock(deadline)
            .unwrap()
            .charged_bytes(deadline)
            .unwrap(),
        expected["charge"].as_u64().unwrap()
    );
    let error = store
        .put_images(id, &generated, now, deadline)
        .err()
        .unwrap();
    assert_eq!(json!(error), expected["duplicate"]);
    let limited = OutputStore::new(
        &memory,
        Settings {
            quota_bytes: Some(expected["charge"].as_u64().unwrap() * 2 - 1),
            ..Settings::default()
        },
    );
    let error = limited
        .put_images("fixture-b", &generated, now, deadline)
        .err()
        .unwrap();
    assert_eq!(json!(error), expected["quota"]);
    let wrong = [Image {
        bytes: &bytes,
        format: ImageFormat::Jpeg,
    }];
    let error = store
        .put_images(
            "fixture-c",
            &Images {
                files: &wrong,
                ..generated
            },
            now,
            deadline,
        )
        .err()
        .unwrap();
    assert_eq!(json!(error), expected["wrongFormat"]);
    assert_eq!(
        json!(memory.visible.lock().unwrap().keys().collect::<Vec<_>>()),
        expected["visibleAfterRefusals"]
    );
    assert_eq!(
        json!(store.prune(now + 999, deadline).unwrap()),
        expected["retained"]
    );
    assert_eq!(
        json!(store.prune(now + 1000, deadline).unwrap()),
        expected["expired"]
    );
    assert_eq!(
        json!(store.get(id, deadline).unwrap()),
        expected["afterExpiry"]
    );

    let storage_failure = Memory {
        fail_manifest: true,
        ..Memory::default()
    };
    let store = OutputStore::new(&storage_failure, Settings::default());
    assert_eq!(
        store
            .put_images(
                id,
                &Images {
                    files: &files,
                    ..generated
                },
                now,
                deadline
            )
            .err(),
        Some(Error::Storage)
    );
    assert!(storage_failure.visible.lock().unwrap().is_empty());
}
