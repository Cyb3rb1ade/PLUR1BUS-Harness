use std::path::Path;
/// Only caller-owned temporary trees. Failure text never contains the secret.
pub fn assert_no_token_on_disk(dir: &Path, secret: &str) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let entry = entry.unwrap();
        if entry.file_type().unwrap().is_dir() {
            assert_no_token_on_disk(&entry.path(), secret);
        } else if entry.file_type().unwrap().is_file() {
            let bytes = std::fs::read(entry.path()).unwrap();
            assert!(
                !String::from_utf8_lossy(&bytes).contains(secret),
                "credential found in scratch output"
            );
        }
    }
}
