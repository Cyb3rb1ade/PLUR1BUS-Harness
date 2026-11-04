//! Immutable q8 media graph catalogue and cancellable, read-only host-cache verification.

use super::embedder::MediaError;
use crate::contract::Cancel;
use crate::embedding::artifacts::{pinned_profile, Artifact, ArtifactFile};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};

/// Logical cache namespace shared with the existing text profile.
pub const MODEL: &str = "google/embeddinggemma-2";
/// Immutable upstream ONNX export revision.
pub const REVISION: &str = "daa72c51243991dfcaf9f9137d2c573d8f7790c0";
/// Repository supplying all three graph families.
pub const REPOSITORY: &str = "onnx-community/embeddinggemma-2-ONNX";

/// Independently loaded graph role; the text provider's session is never used here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaGraph {
    /// Image and sampled video frame encoder.
    Vision,
    /// Unpadded log-Mel encoder.
    Audio,
    /// Media-conditioned text graph producing 768-dimensional embeddings.
    Fusion,
}

/// All five supported host targets deliberately select q8 for both encoders (MM-1/E3).
/// Target set matches `scripts/release/release-native.mjs::TARGETS` and the verified
/// ONNX Runtime pins in `tests/common/onnx_runtime.rs`; Intel macOS has no pinned runtime.
pub fn platform_dtypes(
    os: &str,
    architecture: &str,
) -> Result<(&'static str, &'static str), MediaError> {
    match (os, architecture) {
        ("macos", "aarch64")
        | ("linux", "aarch64" | "x86_64")
        | ("windows", "aarch64" | "x86_64") => Ok(("q8", "q8")),
        _ => Err(MediaError::UnsupportedPlatform),
    }
}

/// The original immutable text catalogue entry, with no file-list mutation.
pub fn text_profile() -> Result<&'static Artifact, MediaError> {
    pinned_profile(MODEL, Some("q8")).ok_or(MediaError::InvalidProfile)
}

/// Pinned files for one graph; preparation remains the host's responsibility.
pub fn graph_files(graph: MediaGraph) -> Result<Vec<ArtifactFile>, MediaError> {
    let entries = match graph {
        MediaGraph::Vision => [
            (
                "onnx/vision_encoder_quantized.onnx",
                162495,
                "bb0de2df53a2448a32dc7908a187c168c8afd514d4d6f674f7f46024875fa4e3",
            ),
            (
                "onnx/vision_encoder_quantized.onnx_data",
                195228672,
                "3dabd69c0a36e9a8771ad82030dde74daa5a0e02b7047a5d3f3382b1137bab89",
            ),
        ],
        MediaGraph::Audio => [
            (
                "onnx/audio_encoder_quantized.onnx",
                249330,
                "04a9a9094ba76fb169e4c69be45a4b621580188654d6be59eab860eadcd42d3c",
            ),
            (
                "onnx/audio_encoder_quantized.onnx_data",
                340058624,
                "aa6361d898e1f1d6303f8dd2b5fabf4fd3629e15fd709e9cb06ac5cb9416a030",
            ),
        ],
        MediaGraph::Fusion => return Ok(text_profile()?.files.clone()),
    };
    Ok(entries
        .into_iter()
        .map(|(path, bytes, sha256)| ArtifactFile {
            path: path.into(),
            source_path: None,
            bytes,
            sha256: sha256.into(),
        })
        .collect())
}

/// Verify the graph and external weights before ORT sees any cache path.
pub(crate) fn verify_graph(
    root: &Path,
    graph: MediaGraph,
    cancel: &Cancel,
) -> Result<PathBuf, MediaError> {
    let directory = root.join(MODEL).join(REVISION);
    let files = graph_files(graph)?;
    for file in &files {
        verify_file(&directory, file, cancel)?;
    }
    let name = match graph {
        MediaGraph::Vision => "onnx/vision_encoder_quantized.onnx",
        MediaGraph::Audio => "onnx/audio_encoder_quantized.onnx",
        MediaGraph::Fusion => "onnx/model_quantized.onnx",
    };
    Ok(directory.join(name))
}

fn verify_file(
    directory: &Path,
    expected: &ArtifactFile,
    cancel: &Cancel,
) -> Result<(), MediaError> {
    cancel.check()?;
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // Descriptor metadata below closes the replacement race: a FIFO cannot block open,
        // and a final symlink cannot redirect it to a different object (MM-1 review P2).
        options.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_FLAG_OPEN_REPARSE_POINT opens the link itself; descriptor metadata rejects it below.
        options.custom_flags(0x0020_0000);
    }
    let mut file =
        options
            .open(directory.join(&expected.path))
            .map_err(|_| MediaError::ArtifactMissing {
                file: expected.path.clone(),
            })?;
    let metadata = file.metadata().map_err(|_| MediaError::ArtifactMissing {
        file: expected.path.clone(),
    })?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // Reject all reparse points, including symlinks, without following their targets.
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(MediaError::ArtifactMissing {
                file: expected.path.clone(),
            });
        }
    }
    if !metadata.is_file() || metadata.len() != expected.bytes {
        return Err(MediaError::ArtifactSize {
            file: expected.path.clone(),
        });
    }
    verify_reader(&mut file, expected, cancel)
}

fn verify_reader(
    reader: &mut impl Read,
    expected: &ArtifactFile,
    cancel: &Cancel,
) -> Result<(), MediaError> {
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut total = 0_u64;
    loop {
        cancel.check()?;
        let read = reader
            .read(&mut buffer)
            .map_err(|_| MediaError::ArtifactMissing {
                file: expected.path.clone(),
            })?;
        if read == 0 {
            break;
        }
        total = total
            .checked_add(read as u64)
            .filter(|total| *total <= expected.bytes)
            .ok_or_else(|| MediaError::ArtifactSize {
                file: expected.path.clone(),
            })?;
        hash.update(&buffer[..read]);
    }
    cancel.check()?;
    if total != expected.bytes {
        return Err(MediaError::ArtifactSize {
            file: expected.path.clone(),
        });
    }
    if format!("{:x}", hash.finalize()) != expected.sha256 {
        return Err(MediaError::ArtifactHash {
            file: expected.path.clone(),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    #[test]
    fn all_supported_platforms_use_q8_and_unknown_platforms_refuse() {
        for (os, arch) in [
            ("macos", "aarch64"),
            ("linux", "aarch64"),
            ("linux", "x86_64"),
            ("windows", "x86_64"),
            ("windows", "aarch64"),
        ] {
            assert_eq!(platform_dtypes(os, arch).unwrap(), ("q8", "q8"));
        }
        assert!(platform_dtypes("macos", "x86_64").is_err());
        assert!(platform_dtypes("linux", "riscv64").is_err());
    }
    #[test]
    fn windows_arm64_release_target_selects_q8_for_both_media_graphs() {
        assert_eq!(platform_dtypes("windows", "aarch64"), Ok(("q8", "q8")));
    }
    fn small_file() -> ArtifactFile {
        ArtifactFile {
            path: "graph.onnx".into(),
            source_path: None,
            bytes: 3,
            sha256: format!("{:x}", Sha256::digest(b"abc")),
        }
    }
    #[test]
    fn missing_size_and_hash_fail_before_any_runtime_access() {
        let root = tempfile::tempdir().unwrap();
        let expected = small_file();
        assert!(matches!(
            verify_file(root.path(), &expected, &Cancel::never()),
            Err(MediaError::ArtifactMissing { .. })
        ));
        std::fs::write(root.path().join(&expected.path), b"ab").unwrap();
        assert!(matches!(
            verify_file(root.path(), &expected, &Cancel::never()),
            Err(MediaError::ArtifactSize { .. })
        ));
        std::fs::write(root.path().join(&expected.path), b"bad").unwrap();
        assert!(matches!(
            verify_file(root.path(), &expected, &Cancel::never()),
            Err(MediaError::ArtifactHash { .. })
        ));
        std::fs::write(root.path().join(&expected.path), b"abc").unwrap();
        verify_file(root.path(), &expected, &Cancel::never()).unwrap();
    }
    #[test]
    fn cancellation_during_hashing_stops_before_the_next_read() {
        struct CancellingReader {
            cancel: Cancel,
            reads: usize,
        }
        impl Read for CancellingReader {
            fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
                self.reads += 1;
                self.cancel.cancel();
                buffer[0] = b'a';
                Ok(1)
            }
        }
        let cancel = Cancel::never();
        let mut reader = CancellingReader {
            cancel: cancel.clone(),
            reads: 0,
        };
        assert!(matches!(
            verify_reader(&mut reader, &small_file(), &cancel),
            Err(MediaError::Cancelled(_))
        ));
        assert_eq!(reader.reads, 1);
    }

    #[cfg(unix)]
    #[test]
    fn fifo_cache_entries_are_refused_without_blocking_the_deadline() {
        const CHILD: &str = "PLUR1BUS_TEST_MEDIA_FIFO";
        if let Some(directory) = std::env::var_os(CHILD) {
            let cancel = Cancel::with_deadline(
                std::time::Instant::now() + std::time::Duration::from_millis(50),
            );
            assert!(matches!(
                verify_file(Path::new(&directory), &small_file(), &cancel),
                Err(MediaError::ArtifactSize { .. })
            ));
            return;
        }
        let directory = tempfile::tempdir().unwrap();
        use std::os::unix::ffi::OsStrExt;
        let path =
            std::ffi::CString::new(directory.path().join("graph.onnx").as_os_str().as_bytes())
                .unwrap();
        // SAFETY: the CString is terminated and lives through mkfifo; the mode is owner read/write only.
        assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
        let mut child=std::process::Command::new(std::env::current_exe().unwrap())
            .arg("--exact").arg("media::artifacts::tests::fifo_cache_entries_are_refused_without_blocking_the_deadline")
            .arg("--nocapture").env(CHILD,directory.path()).spawn().unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(500);
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break Some(status);
            }
            if std::time::Instant::now() >= deadline {
                child.kill().unwrap();
                child.wait().unwrap();
                break None;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        };
        assert!(
            status.is_some_and(|status| status.success()),
            "cache FIFO blocked past its deadline; child was terminated"
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlink_cache_entries_cannot_bypass_the_descriptor_type_guard() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("regular"), b"abc").unwrap();
        std::os::unix::fs::symlink("regular", directory.path().join("graph.onnx")).unwrap();
        assert!(matches!(
            verify_file(directory.path(), &small_file(), &Cancel::never()),
            Err(MediaError::ArtifactMissing { .. })
        ));
    }
}
