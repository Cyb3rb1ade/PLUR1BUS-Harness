#![allow(clippy::unwrap_used, reason = "media store fixture assertions")]
use base64::{engine::general_purpose::STANDARD, Engine as _};
use plur1bus_media::{
    jobs::{Error, Result},
    output::{
        sanitize_reference_video, Backend, Destination, Image, ImageFormat, Images, Namespace,
        OutputStore, Settings, Stage, Video, VideoControl, VideoStage, WriteGuard,
    },
    uploads::{Entry, Health, IndexRecord, Kind, Upload},
    video::{self, Codec, ProcessPort},
};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    ffi::{OsStr, OsString},
    fs::{self, File, OpenOptions},
    io::{Cursor, Read},
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
    time::{Duration, Instant},
};

type Files = BTreeMap<String, Vec<u8>>;
type Published = BTreeMap<String, Files>;

#[derive(Default)]
struct Memory {
    visible: Mutex<Published>,
    index: Mutex<BTreeMap<String, IndexRecord>>,
    refuse_binding_cleanup: std::cell::Cell<bool>,
    fail_manifest: bool,
    return_unbounded_read: bool,
}

struct Guard<'a> {
    visible: MutexGuard<'a, Published>,
    index: MutexGuard<'a, BTreeMap<String, IndexRecord>>,
    refuse_binding_cleanup: &'a std::cell::Cell<bool>,
    fail_manifest: bool,
}

struct Staged<'a> {
    visible: &'a mut Published,
    index: &'a mut BTreeMap<String, IndexRecord>,
    files: Files,
    fail_manifest: bool,
    temp: Option<tempfile::TempDir>,
}

impl Backend for Memory {
    type Guard<'a> = Guard<'a>;

    fn lock(&self, _: Instant) -> Result<Self::Guard<'_>> {
        Ok(Guard {
            visible: self.visible.lock().unwrap(),
            index: self.index.lock().unwrap(),
            refuse_binding_cleanup: &self.refuse_binding_cleanup,
            fail_manifest: self.fail_manifest,
        })
    }

    fn recover_staging(&mut self, deadline: Instant) -> Result<Self::Guard<'_>> {
        self.lock(deadline)
    }

    fn read(
        &self,
        space: Namespace,
        id: &str,
        name: &str,
        limit: usize,
        _: Instant,
    ) -> Result<Option<Vec<u8>>> {
        let dir = self.visible.lock().unwrap();
        let data = dir.get(&key(space, id)).and_then(|files| files.get(name));
        if !self.return_unbounded_read && data.is_some_and(|data| data.len() > limit) {
            return Err(Error::Storage);
        }
        Ok(data.cloned())
    }
}

fn key(space: Namespace, id: &str) -> String {
    match space {
        Namespace::Output => id.into(),
        Namespace::Upload => format!(".uploads/{id}"),
    }
}

impl WriteGuard for Guard<'_> {
    type Stage<'a>
        = Staged<'a>
    where
        Self: 'a;

    fn contains(&self, space: Namespace, id: &str, _: Instant) -> Result<bool> {
        Ok(self.visible.contains_key(&key(space, id)))
    }

    fn generated_bytes(&self, _: Instant) -> Result<u64> {
        Ok(self
            .visible
            .iter()
            .filter(|(id, _)| !id.starts_with(".uploads/"))
            .flat_map(|(_, files)| files)
            .map(|(_, data)| data.len() as u64)
            .sum())
    }

    fn stage(&mut self, _: Instant) -> Result<Self::Stage<'_>> {
        Ok(Staged {
            visible: &mut self.visible,
            index: &mut self.index,
            files: Files::new(),
            fail_manifest: self.fail_manifest,
            temp: None,
        })
    }

    fn entries(&self, _: Instant) -> Result<Vec<(String, i64)>> {
        Ok(self
            .visible
            .iter()
            .filter(|(id, _)| !id.starts_with(".uploads/"))
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

    fn uploads(&mut self, _: Instant) -> Result<Vec<Entry>> {
        Ok(self
            .visible
            .iter()
            .filter_map(|(key, files)| {
                let id = key.strip_prefix(".uploads/")?;
                let manifest: Value = serde_json::from_slice(&files["manifest.json"]).unwrap();
                let created_at = manifest["createdAt"].as_i64().unwrap();
                Some(Entry {
                    id: id.into(),
                    modified_at: created_at,
                    bytes: files.values().map(|b| b.len() as u64).sum(),
                    health: Health::Present { created_at },
                    saved: self.index.get(id).copied(),
                })
            })
            .collect())
    }

    fn write_upload_index(&mut self, id: &str, record: IndexRecord, _: Instant) -> Result<()> {
        self.index.insert(id.into(), record);
        Ok(())
    }

    fn upload_index_ids(&self, _: Instant) -> Result<Vec<String>> {
        Ok(self.index.keys().cloned().collect())
    }

    fn remove_upload_index(&mut self, id: &str, _: Instant) -> Result<()> {
        self.index.remove(id);
        Ok(())
    }

    fn delete_upload(&mut self, id: &str, verified_id: bool, _: Instant) -> Result<()> {
        assert!(verified_id);
        if self.refuse_binding_cleanup.get() {
            return Err(Error::Storage);
        }
        self.visible.remove(&key(Namespace::Upload, id));
        self.index.remove(id);
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

    fn publish(mut self, target: Destination<'_>, _: Instant) -> Result<()> {
        let (space, id) = match target {
            Destination::Output(id) => (Namespace::Output, id),
            Destination::Upload { id, index } => {
                self.index.insert(id.into(), index);
                (Namespace::Upload, id)
            }
        };
        if let Some(temp) = &self.temp {
            for entry in fs::read_dir(temp.path()).unwrap() {
                let entry = entry.unwrap();
                let name = entry.file_name().into_string().unwrap();
                assert!(self
                    .files
                    .insert(name, fs::read(entry.path()).unwrap())
                    .is_none());
            }
        }
        assert!(self.files.contains_key("manifest.json"));
        assert!(self.visible.insert(key(space, id), self.files).is_none());
        Ok(())
    }
}

impl VideoStage for Staged<'_> {
    type Writer = File;
    type Reader = File;

    fn create_payload(&mut self, name: &str, _: Instant) -> Result<(PathBuf, File)> {
        if self.temp.is_none() {
            self.temp = Some(tempfile::tempdir().unwrap());
        }
        let path = self.temp.as_ref().unwrap().path().join(name);
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .unwrap();
        Ok((path, file))
    }

    fn sync_payload(&self, path: &Path, _: Instant) -> Result<File> {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)
            .unwrap();
        file.sync_all().unwrap();
        Ok(file)
    }

    fn unlink_payload(&mut self, path: &Path, _: Instant) -> Result<()> {
        fs::remove_file(path).unwrap();
        Ok(())
    }
}

struct ScriptedCodec {
    prompts: std::cell::RefCell<Vec<Option<String>>>,
}

impl ProcessPort for ScriptedCodec {
    fn run(
        &self,
        codec: Codec,
        args: &[OsString],
        _: usize,
        _: Instant,
        _: &dyn Fn() -> bool,
    ) -> std::result::Result<Vec<u8>, video::Error> {
        let output = Path::new(args.last().unwrap());
        match codec {
            Codec::Ffprobe => Ok(br#"{"streams":[{"codec_type":"video","width":1280,"height":720,"avg_frame_rate":"24/1"}],"format":{"duration":"4"}}"#.to_vec()),
            Codec::Ffmpeg if output.extension() == Some(OsStr::new("png")) => {
                fs::write(output, b"poster").unwrap();
                Ok(vec![])
            }
            Codec::Ffmpeg => {
                let source = args.iter().position(|arg| arg == "-i").unwrap();
                let mut bytes = fs::read(Path::new(&args[source + 1])).unwrap();
                let prompt = args.iter().find_map(|arg| arg.to_str()?.strip_prefix("comment="));
                self.prompts.borrow_mut().push(prompt.map(str::to_owned));
                if let Some(prompt) = prompt {
                    bytes.extend_from_slice(prompt.as_bytes());
                }
                fs::write(output, bytes).unwrap();
                Ok(vec![])
            }
        }
    }
}

#[test]
fn video_publication_matches_the_typescript_processor_and_store() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../fixtures/parity/media/video-store.json"
    ))
    .unwrap();
    let input = &fixture["input"];
    let expected = &fixture["expected"];
    let now = input["now"].as_i64().unwrap();
    let bytes = STANDARD.decode(input["bytes"].as_str().unwrap()).unwrap();
    let codec = ScriptedCodec {
        prompts: std::cell::RefCell::new(vec![]),
    };
    let deadline = Instant::now() + Duration::from_secs(5);
    let publish = |store: &OutputStore<'_, Memory>, id: &str, parameters: &Value, source: &[u8]| {
        let mut stream = Cursor::new(&source[..10.min(source.len())])
            .chain(Cursor::new(&source[10.min(source.len())..]));
        store.put_video(
            id,
            &mut Video {
                parameters,
                references: &[],
                metadata: &input["metadata"],
                partial: false,
                agent_metadata: None,
                source: &mut stream,
            },
            &codec,
            &VideoControl {
                now_ms: now,
                deadline,
                cancelled: &|| false,
            },
        )
    };
    let memory = Memory::default();
    let store = OutputStore::new(&memory, Settings::default());
    let parameters = &input["request"];
    assert_eq!(
        publish(&store, "off", parameters, &bytes).unwrap(),
        expected["plain"]
    );
    let mut opt_in = parameters.clone();
    opt_in["embedMetadata"] = json!(true);
    assert_eq!(
        publish(&store, "on", &opt_in, &bytes).unwrap(),
        expected["optIn"]
    );
    let limited = OutputStore::new(
        &memory,
        Settings {
            max_video_bytes: Some(10),
            ..Settings::default()
        },
    );
    assert_eq!(
        json!(publish(&limited, "large", parameters, &bytes)
            .err()
            .unwrap()),
        expected["maxVideo"]
    );
    let quota = OutputStore::new(
        &memory,
        Settings {
            quota_bytes: Some(1),
            ..Settings::default()
        },
    );
    assert_eq!(
        json!(publish(&quota, "quota", parameters, &bytes).err().unwrap()),
        expected["quota"]
    );
    let already_charged = memory
        .lock(deadline)
        .unwrap()
        .generated_bytes(deadline)
        .unwrap();
    let late_quota = OutputStore::new(
        &memory,
        Settings {
            quota_bytes: Some(already_charged + bytes.len() as u64),
            ..Settings::default()
        },
    );
    assert_eq!(
        json!(publish(&late_quota, "late-quota", parameters, &bytes)
            .err()
            .unwrap()),
        expected["lateQuota"]
    );
    assert_eq!(json!(&*codec.prompts.borrow()), expected["prompts"]);
    assert_eq!(
        json!(publish(&store, "invalid", parameters, b"bad")
            .err()
            .unwrap()),
        expected["invalid"]
    );
    let visible = memory.visible.lock().unwrap();
    assert_eq!(
        json!(visible.keys().collect::<Vec<_>>()),
        expected["entries"]
    );
    assert_eq!(
        STANDARD.encode(&visible["off"]["0.mp4"]),
        expected["plainBytes"]
    );
    assert_eq!(
        STANDARD.encode(&visible["on"]["0.mp4"]),
        expected["optInBytes"]
    );
}

#[test]
fn video_reference_only_returns_the_clean_remux_from_private_staging() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../fixtures/parity/media/video-store.json"
    ))
    .unwrap();
    let bytes = STANDARD
        .decode(fixture["input"]["bytes"].as_str().unwrap())
        .unwrap();
    let memory = Memory::default();
    let codec = ScriptedCodec {
        prompts: std::cell::RefCell::new(vec![]),
    };
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut guard = memory.lock(deadline).unwrap();
    let mut stage = guard.stage(deadline).unwrap();
    let cleaned = sanitize_reference_video(
        &bytes,
        &mut stage,
        &codec,
        &VideoControl {
            now_ms: 0,
            deadline,
            cancelled: &|| false,
        },
    )
    .unwrap();
    assert_eq!(cleaned.format, video::Format::Mp4);
    assert_eq!(cleaned.bytes, bytes);
    assert_eq!(codec.prompts.take(), [None]);
    drop(stage);
    drop(guard);
    assert!(memory.visible.lock().unwrap().is_empty());
}

#[test]
fn upload_publication_and_owner_cleanup_match_the_typescript_store() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../fixtures/parity/media/upload-store.json"
    ))
    .unwrap();
    let input = &fixture["input"];
    let expected = &fixture["expected"];
    let id = input["id"].as_str().unwrap();
    let now = input["now"].as_i64().unwrap();
    let data = STANDARD.decode(input["data"].as_str().unwrap()).unwrap();
    let upload = Upload {
        kind: Kind::Image,
        mime_type: input["mimeType"].as_str().unwrap(),
        filename: input["filename"].as_str(),
        bytes: &data,
    };
    let memory = Memory::default();
    let store = OutputStore::new(
        &memory,
        Settings {
            retention_ms: Some(1000),
            ..Settings::default()
        },
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    assert_eq!(
        json!(store.put_uploaded(id, &upload, now, deadline).unwrap()),
        expected["manifest"]
    );
    let oversized = vec![0; 25 * 1024 * 1024 + 1];
    assert_eq!(
        store
            .put_uploaded(
                id,
                &Upload {
                    bytes: &oversized,
                    ..upload
                },
                now,
                deadline
            )
            .err(),
        Some(Error::TooLarge)
    );
    let read = store.get_uploaded(id, deadline).unwrap().unwrap();
    assert_eq!(json!(read.manifest), expected["manifest"]);
    assert_eq!(json!(STANDARD.encode(read.bytes)), expected["raw"]);
    assert_eq!(
        json!(memory.index.lock().unwrap().get(id).unwrap()),
        expected["index"]
    );
    assert_eq!(
        json!(store.get(id, deadline).unwrap()),
        expected["generatedLookup"]
    );
    let quota = expected["index"]["bytes"].as_u64().unwrap() * 2 - 1;
    let restricted = OutputStore::new(
        &memory,
        Settings {
            quota_bytes: Some(quota),
            ..Settings::default()
        },
    );
    assert_eq!(
        json!(restricted
            .put_uploaded(
                "00000000-0000-4000-8000-000000000001",
                &upload,
                now,
                deadline
            )
            .err()
            .unwrap()),
        expected["quota"]
    );
    assert_eq!(
        json!(store
            .put_uploaded(
                "wrong",
                &Upload {
                    mime_type: "image/jpeg",
                    ..upload
                },
                now,
                deadline
            )
            .err()
            .unwrap()),
        expected["wrongType"]
    );
    let path = key(Namespace::Upload, id);
    memory
        .visible
        .lock()
        .unwrap()
        .get_mut(&path)
        .unwrap()
        .insert("0.png".into(), vec![0; data.len()]);
    assert_eq!(
        json!(store.get_uploaded(id, deadline).err().unwrap()),
        expected["changedHash"]
    );
    memory
        .visible
        .lock()
        .unwrap()
        .get_mut(&path)
        .unwrap()
        .insert("0.png".into(), data);
    assert_eq!(
        json!(store.prune(now + 999, deadline).unwrap()),
        expected["retained"]
    );
    memory.refuse_binding_cleanup.set(true);
    assert_eq!(
        json!(store.prune(now + 1000, deadline).err().unwrap()),
        expected["cleanupFailure"]
    );
    assert_eq!(
        json!(store.get_uploaded(id, deadline).unwrap().is_some()),
        expected["presentAfterFailure"]
    );
    memory.refuse_binding_cleanup.set(false);
    assert_eq!(
        json!(store.prune(now + 1000, deadline).unwrap()),
        expected["expired"]
    );
    assert!(store.get_uploaded(id, deadline).unwrap().is_none());
    assert!(memory.index.lock().unwrap().is_empty());
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
        agent_metadata: None,
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
            .generated_bytes(deadline)
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

    let provenance = OutputStore::new(
        &memory,
        Settings {
            embed_metadata: Some(true),
            ..Settings::default()
        },
    );
    let mut request = input["request"].clone();
    request["embedMetadata"] = json!(true);
    let with_metadata = provenance
        .put_images(
            "generated",
            &Images {
                parameters: &request,
                agent_metadata: Some(false),
                references: &[],
                mask: None,
                ..generated
            },
            now,
            deadline,
        )
        .unwrap();
    assert_eq!(with_metadata, expected["withProvenance"]);
    request["embedMetadata"] = json!(false);
    let without_metadata = provenance
        .put_images(
            "raw",
            &Images {
                parameters: &request,
                agent_metadata: Some(true),
                references: &[],
                mask: None,
                ..generated
            },
            now,
            deadline,
        )
        .unwrap();
    assert_eq!(without_metadata, expected["withoutProvenance"]);

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

#[test]
fn output_store_checks_the_manifest_size_returned_by_its_backend() {
    let memory = Memory {
        return_unbounded_read: true,
        ..Memory::default()
    };
    let id = "example";
    let mut bytes = serde_json::to_vec(&json!({"schema":"media.output/1","id":id})).unwrap();
    bytes.resize(1024 * 1024 + 1, b' ');
    memory
        .visible
        .lock()
        .unwrap()
        .insert(id.into(), Files::from([("manifest.json".into(), bytes)]));
    let store = OutputStore::new(&memory, Settings::default());
    assert_eq!(
        store.get(id, Instant::now() + Duration::from_secs(2)),
        Err(Error::Storage)
    );
}
