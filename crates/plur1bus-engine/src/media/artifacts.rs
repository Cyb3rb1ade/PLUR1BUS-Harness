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
pub fn platform_dtypes(
    os: &str,
    architecture: &str,
) -> Result<(&'static str, &'static str), MediaError> {
    match (os, architecture) {
        ("macos", "aarch64" | "x86_64")
        | ("linux", "aarch64" | "x86_64")
        | ("windows", "x86_64") => Ok(("q8", "q8")),
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
    let mut file = std::fs::File::open(directory.join(&expected.path)).map_err(|_| {
        MediaError::ArtifactMissing {
            file: expected.path.clone(),
        }
    })?;
    let metadata = file.metadata().map_err(|_| MediaError::ArtifactMissing {
        file: expected.path.clone(),
    })?;
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
            ("macos", "x86_64"),
            ("linux", "aarch64"),
            ("linux", "x86_64"),
            ("windows", "x86_64"),
        ] {
            assert_eq!(platform_dtypes(os, arch).unwrap(), ("q8", "q8"));
        }
        assert!(platform_dtypes("windows", "aarch64").is_err());
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
}
