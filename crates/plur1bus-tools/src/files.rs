//! Owner-private run files; refuse links before touching credentials and hold a single-instance lock.
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::Path;

pub(crate) fn private_dir(path: &Path) -> io::Result<()> {
    if path
        .symlink_metadata()
        .is_ok_and(|m| !m.is_dir() || m.is_symlink())
    {
        return Err(io::Error::other(
            "tools directory is not a regular directory",
        ));
    }
    fs::create_dir_all(path)?;
    secure(path, true)
}

pub(crate) fn secure(path: &Path, directory: bool) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(
            path,
            fs::Permissions::from_mode(if directory { 0o700 } else { 0o600 }),
        )?;
    }
    #[cfg(windows)]
    {
        let sid = plur1bus_rpc::win::user_sid()?;
        let sddl = if directory {
            plur1bus_rpc::acl::run_dir_sddl(&sid)
        } else {
            plur1bus_rpc::acl::user_and_system_sddl(&sid)
        };
        plur1bus_rpc::win::set_path_dacl(path, &sddl)?;
    }
    Ok(())
}

pub(crate) fn private_file(path: &Path) -> io::Result<File> {
    if path
        .symlink_metadata()
        .is_ok_and(|m| !m.is_file() || m.is_symlink())
    {
        return Err(io::Error::other("tools run file is not regular"));
    }
    let mut options = OpenOptions::new();
    options.create(true).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(path)?;
    secure(path, false)?;
    Ok(file)
}

pub(crate) fn write_private(path: &Path, text: &str) -> io::Result<()> {
    let mut file = private_file(path)?;
    file.set_len(0)?;
    file.write_all(text.as_bytes())?;
    file.sync_all()
}

pub(crate) fn read_private(path: &Path) -> io::Result<String> {
    let metadata = path.symlink_metadata()?;
    if metadata.is_symlink() || !metadata.is_file() || metadata.len() > 128 {
        return Err(io::Error::other("invalid control credential file"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(io::Error::other("control credential is not owner-private"));
        }
    }
    fs::read_to_string(path)
}

pub(crate) fn fresh_token() -> io::Result<String> {
    let mut bytes = zeroize::Zeroizing::new([0; 32]);
    getrandom::fill(bytes.as_mut()).map_err(|_| io::Error::other("tools entropy unavailable"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

pub(crate) fn same(left: &str, right: &str) -> bool {
    let mismatch = left
        .bytes()
        .zip(right.bytes())
        .fold(0, |acc, (a, b)| acc | (a ^ b));
    left.len() == right.len() && mismatch == 0
}

pub(crate) fn ticket_key(value: &str) -> Option<zeroize::Zeroizing<[u8; 32]>> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return None;
    }
    let mut key = zeroize::Zeroizing::new([0; 32]);
    for (index, pair) in value.as_bytes().chunks_exact(2).enumerate() {
        let digit = |b: u8| {
            if b.is_ascii_digit() {
                b - b'0'
            } else {
                b - b'a' + 10
            }
        };
        key[index] = digit(pair[0]) * 16 + digit(pair[1]);
    }
    Some(key)
}
