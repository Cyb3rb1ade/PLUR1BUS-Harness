//! Size-rotated append-only log files (ruling S17): `<file>.1` is the newest rotated file and `<file>.<keep>` the
//! oldest. The size is checked before each write, so a file only exceeds `max_bytes` when a single write is larger
//! than `max_bytes` on its own (that write then lands in a fresh file). Same rule as the core's `rotatingSink`.
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

pub struct RotatingFile {
    path: PathBuf,
    max_bytes: u64,
    keep: u32,
    file: Option<File>,
    size: u64,
}

impl RotatingFile {
    /// Opens `path` for appending (creating its parent directory), continuing from its current size. `keep` is at
    /// least 1.
    pub fn open(path: impl AsRef<Path>, max_bytes: u64, keep: u32) -> io::Result<Self> {
        let path = path.as_ref().to_path_buf();
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        let file = append(&path)?;
        let size = file.metadata()?.len();
        Ok(Self {
            path,
            max_bytes,
            keep: keep.max(1),
            file: Some(file),
            size,
        })
    }

    fn rotated(&self, n: u32) -> PathBuf {
        let mut s = self.path.clone().into_os_string();
        s.push(format!(".{n}"));
        PathBuf::from(s)
    }

    /// Shifts `<file>.i` to `<file>.i+1` (dropping `<file>.<keep>`), moves the live file to `<file>.1` and reopens
    /// an empty one. A failed rename (e.g. a Windows reader holding the file) is not an error: the writer keeps
    /// appending to the file it has and tries again on the next write.
    fn rotate(&mut self) -> io::Result<()> {
        self.file = None; // Windows cannot rename an open file
        let _ = fs::remove_file(self.rotated(self.keep));
        for i in (1..self.keep).rev() {
            let from = self.rotated(i);
            if from.exists() {
                let _ = fs::rename(&from, self.rotated(i + 1));
            }
        }
        let renamed = fs::rename(&self.path, self.rotated(1)).is_ok();
        let file = append(&self.path)?;
        self.size = if renamed { 0 } else { file.metadata()?.len() };
        self.file = Some(file);
        Ok(())
    }
}

fn append(path: &Path) -> io::Result<File> {
    OpenOptions::new().create(true).append(true).open(path)
}

impl Write for RotatingFile {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if self.file.is_none()
            || (self.size > 0 && self.size.saturating_add(buf.len() as u64) > self.max_bytes)
        {
            self.rotate()?;
        }
        let file = self.file.as_mut().expect("rotate reopened the file");
        file.write_all(buf)?;
        self.size += buf.len() as u64;
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        match self.file.as_mut() {
            Some(f) => f.flush(),
            None => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotates_at_max_bytes_keeping_n() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("supervisor.log");
        let mut f = RotatingFile::open(&path, 200, 2).unwrap();
        for i in 0..50 {
            f.write_all(format!("line {i:04} ................\n").as_bytes())
                .unwrap();
        }
        f.flush().unwrap();
        let rotated = |n: u32| dir.path().join(format!("supervisor.log.{n}"));
        assert!(path.exists() && rotated(1).exists() && rotated(2).exists());
        assert!(!rotated(3).exists(), "keep = 2 drops the third file");
        for p in [path.clone(), rotated(1), rotated(2)] {
            assert!(
                fs::metadata(&p).unwrap().len() <= 200,
                "{p:?} exceeds max_bytes"
            );
        }
        // Oldest to newest, the surviving lines are one gap-free run ending at the last line written.
        let text: String = [rotated(2), rotated(1), path]
            .iter()
            .map(|p| fs::read_to_string(p).unwrap())
            .collect();
        let nums: Vec<u32> = text.lines().map(|l| l[5..9].parse().unwrap()).collect();
        assert_eq!(*nums.last().unwrap(), 49);
        assert!(nums.windows(2).all(|w| w[1] == w[0] + 1), "{nums:?}");

        // Reopening continues from the current size instead of truncating.
        let before = fs::metadata(dir.path().join("supervisor.log"))
            .unwrap()
            .len();
        let mut again = RotatingFile::open(dir.path().join("supervisor.log"), 200, 2).unwrap();
        again.write_all(b"x\n").unwrap();
        let after = fs::metadata(dir.path().join("supervisor.log"))
            .unwrap()
            .len();
        assert!(after == before + 2 || after == 2);
    }
}
