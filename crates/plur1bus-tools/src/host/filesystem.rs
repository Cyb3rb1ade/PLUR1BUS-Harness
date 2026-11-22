use super::{Failure, Invocation, Policy};
use crate::fs::{FsFailure, FsFailureCode, FsTools};
use plur1bus_core::policy::fs_paths::{
    mkdir_verified, move_verified, open_verified, Access, CanonicalPath, FileKind, OpenFlags,
    PathFs,
};
use serde_json::{json, Value};
use std::fs::File;
use std::io::Read as _;

/// Perform the file operations backed by the existing verified filesystem executor.
/// The catalogued invocation must be supplied by Hostctl after approval.
pub fn apply<F: PathFs<Handle = File>>(
    fs: &FsTools<'_, F>,
    policy: &Policy<'_, F>,
    call: &Invocation<'_>,
) -> Option<Result<Value, Failure>> {
    match call.name {
        "hostctl.fs.stat" | "hostctl.fs.read" | "hostctl.fs.write" | "hostctl.fs.append"
        | "hostctl.fs.edit" | "hostctl.fs.copy" | "hostctl.fs.list" | "hostctl.fs.search"
        | "hostctl.fs.mkdir" | "hostctl.fs.move" => Some(run(fs, policy, call)),
        _ => None,
    }
}

fn run<F: PathFs<Handle = File>>(
    fs: &FsTools<'_, F>,
    policy: &Policy<'_, F>,
    call: &Invocation<'_>,
) -> Result<Value, Failure> {
    if (call.aborted)() {
        return Err(Failure::new("ABORTED", "Cancelled."));
    }
    let first = call.paths.first().ok_or_else(Failure::outside)?;
    if call.name == "hostctl.fs.mkdir" {
        return mkdir_verified(fs.ports.fs, first)
            .map(|()| json!({"created":true}))
            .map_err(|e| {
                let code = match e.reason {
                    "exists" => "EXISTS",
                    "unsupported-open" => "UNAVAILABLE",
                    "identity-changed" => "CHANGED",
                    _ => "IO_ERROR",
                };
                Failure::new(
                    code,
                    "Could not create the directory in the verified parent.",
                )
            });
    }
    if call.name == "hostctl.fs.move" {
        let destination = call.paths.get(1).ok_or_else(Failure::outside)?;
        return move_verified(fs.ports.fs, first, destination)
            .map(|()| json!({"moved":true}))
            .map_err(|e| {
                let code = match e.reason {
                    "exists" => "EXISTS",
                    "unsupported-open" => "UNAVAILABLE",
                    "identity-changed" => "CHANGED",
                    "cross-filesystem" => "CROSS_DEVICE",
                    _ => "IO_ERROR",
                };
                Failure::new(code, "Could not move the file to a verified, unused name.")
            });
    }
    if call.name == "hostctl.fs.stat" {
        return fs.stat_checked(first).map_err(|e| failure(&e));
    }
    if call.name == "hostctl.fs.read" {
        let offset = call
            .args
            .get("offset")
            .and_then(Value::as_f64)
            .map_or(0, |n| n as u64);
        let length = call
            .args
            .get("length")
            .and_then(Value::as_f64)
            .map(|n| n as u64);
        return fs
            .read_checked(first, offset, length, "utf8")
            .map_err(|e| failure(&e));
    }
    if matches!(call.name, "hostctl.fs.list" | "hostctl.fs.search") {
        return walk(fs, policy, call, first);
    }
    let text = |key: &str| {
        call.args
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
    };
    if call.name == "hostctl.fs.write" {
        return fs
            .write_checked(
                first,
                call.args.get("path"),
                text("content").as_bytes(),
                true,
                true,
            )
            .map_err(|e| failure(&e));
    }
    if call.name == "hostctl.fs.copy" {
        let destination = call.paths.get(1).ok_or_else(Failure::outside)?;
        let data = read_for_update(fs, first, call)?;
        return fs
            .write_checked(
                destination,
                call.args.get("destination"),
                &data,
                false,
                true,
            )
            .map_err(|e| failure(&e));
    }
    let original = read_for_update(fs, first, call)?;
    let original = std::str::from_utf8(&original)
        .ok()
        .filter(|text| !text.contains('\0'))
        .ok_or_else(|| Failure::new("BINARY", "Use a UTF-8 text file."))?;
    let (prefix, source) = original
        .strip_prefix('\u{feff}')
        .map_or(("", original), |s| ("\u{feff}", s));
    let changed = if call.name == "hostctl.fs.append" {
        format!("{prefix}{source}{}", text("content"))
    } else {
        let find = text("oldText");
        let Some(start) = source
            .find(find)
            .filter(|start| Some(*start) == source.rfind(find))
        else {
            return Err(Failure::new(
                "NOT_UNIQUE",
                "oldText must occur exactly once.",
            ));
        };
        let new = text("newText");
        format!(
            "{prefix}{}{new}{}",
            &source[..start],
            &source[start + find.len()..]
        )
    };
    fs.write_checked(first, call.args.get("path"), changed.as_bytes(), true, true)
        .map_err(|e| failure(&e))
}

fn walk<F: PathFs<Handle = File>>(
    fs: &FsTools<'_, F>,
    policy: &Policy<'_, F>,
    call: &Invocation<'_>,
    first: &CanonicalPath,
) -> Result<Value, Failure> {
    let searching = call.name == "hostctl.fs.search";
    let number = |k: &str, default| {
        call.args
            .get(k)
            .and_then(Value::as_f64)
            .map_or(default, |n| n as usize)
    };
    let depth = number("depth", if searching { 8 } else { 0 });
    let limit = number("limit", call.max_search_results);
    let query = call
        .args
        .get("query")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let content = call.args.get("mode").and_then(Value::as_str) == Some("content");
    let separator = if policy.fs.platform() == "win32" {
        '\\'
    } else {
        '/'
    };
    let mut work = vec![(first.clone(), String::new(), depth, None)];
    let mut output = Vec::new();
    let mut truncated = false;
    let mut directories = 0;
    let mut entries = 0;
    while let Some((path, relative, remaining, kind)) = work.pop() {
        if (call.aborted)() {
            return Err(Failure::new("ABORTED", "Cancelled."));
        }
        if let Some(kind) = kind {
            entries += 1;
            if entries > 1000 {
                truncated = true;
                break;
            }
            let hit = if !searching {
                true
            } else if content && kind == "file" {
                fs.read_checked(&path, 0, None, "utf8")
                    .ok()
                    .and_then(|result| {
                        result["content"]
                            .as_str()
                            .map(|text| super::matches(text, query))
                    })
                    .unwrap_or(false)
            } else {
                !content && super::matches(&relative, query)
            };
            if hit {
                if output.len() >= limit {
                    truncated = true;
                    break;
                }
                if searching {
                    output.push(json!({"path": relative}));
                } else {
                    output.push(json!({"path": relative, "type":kind}));
                }
            }
            if kind != "directory" || remaining == 0 {
                continue;
            }
        }
        directories += 1;
        if directories > 1000 {
            truncated = true;
            break;
        }
        let listing = fs.list_checked(&path, 1000).map_err(|e| failure(&e))?;
        truncated |= listing["truncated"] == true;
        let children = listing["entries"]
            .as_array()
            .ok_or_else(|| Failure::new("IO_ERROR", "Invalid directory listing."))?;
        // Keep traversal depth-first and in the ordering returned by the verified listing.
        for child in children.iter().rev() {
            let name = child["name"]
                .as_str()
                .ok_or_else(|| Failure::new("IO_ERROR", "Invalid entry name."))?;
            let Some(kind) = child["type"].as_str().and_then(|kind| match kind {
                "directory" => Some("directory"),
                "file" => Some("file"),
                "other" => Some("other"),
                _ => None,
            }) else {
                continue;
            };
            let raw = format!(
                "{}{separator}{name}",
                path.canonical().trim_end_matches(separator)
            );
            if let Ok(child) = policy.resolve(&raw, Access::Read) {
                let next = if relative.is_empty() {
                    name.to_owned()
                } else {
                    format!("{relative}/{name}")
                };
                let child_depth = if relative.is_empty() {
                    remaining
                } else {
                    remaining.saturating_sub(1)
                };
                work.push((child, next, child_depth, Some(kind)));
            }
        }
    }
    Ok(if searching {
        json!({"matches":output,"truncated":truncated,"backend":"bounded-js"})
    } else {
        json!({"entries":output,"truncated":truncated})
    })
}

fn read_for_update<F: PathFs<Handle = File>>(
    fs: &FsTools<'_, F>,
    source: &CanonicalPath,
    call: &Invocation<'_>,
) -> Result<Vec<u8>, Failure> {
    let file = open_verified(fs.ports.fs, source, OpenFlags::READ)
        .map_err(|_| Failure::new("CHANGED", "The source could not be verified."))?;
    let meta = fs
        .ports
        .fs
        .fstat(&file)
        .map_err(|_| Failure::new("IO_ERROR", "The source could not be read."))?;
    if meta.kind != FileKind::File {
        return Err(Failure::new("IO_ERROR", "Use a regular file."));
    }
    let max = call
        .max_output_bytes
        .min(fs.config.limits.max_read_bytes as usize);
    if meta.size > max as u64 {
        return Err(Failure::too_large(
            "The file is larger than the operation limit.",
        ));
    }
    let mut reader = file.take(max as u64 + 1);
    let mut data = Vec::with_capacity(meta.size as usize);
    let mut chunk = [0u8; 8192];
    loop {
        if (call.aborted)() {
            return Err(Failure::new("ABORTED", "Cancelled."));
        }
        let n = reader
            .read(&mut chunk)
            .map_err(|_| Failure::new("IO_ERROR", "The file could not be read."))?;
        if n == 0 {
            break;
        }
        data.extend_from_slice(&chunk[..n]);
        if data.len() > max {
            return Err(Failure::too_large(
                "The file is larger than the operation limit.",
            ));
        }
    }
    Ok(data)
}

fn failure(e: &FsFailure) -> Failure {
    use FsFailureCode as C;
    let code = match e.code {
        C::Aborted => "ABORTED",
        C::BinaryContent => "BINARY",
        C::TooLarge => "TOO_LARGE",
        C::NotFound => "NOT_FOUND",
        C::Changed => "CHANGED",
        C::Exists => "EXISTS",
        C::PathRefused => "OUTSIDE_ROOT",
        _ => "IO_ERROR",
    };
    Failure::new(code, "Check the target and permissions before retrying.")
}
