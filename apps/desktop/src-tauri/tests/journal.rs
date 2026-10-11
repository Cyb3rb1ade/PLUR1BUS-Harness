use plur1bus_desktop::controller::journal::Journal;
#[test]
fn journal_refuses_untrusted_names_and_symlinks() {
    let d = tempfile::tempdir().unwrap();
    std::fs::write(d.path().join("upgrades.json"), b"{\"step\":\"swapping\"}").unwrap();
    assert!(Journal::load(d.path()).is_err());
    #[cfg(unix)]
    {
        std::fs::remove_file(d.path().join("upgrades.json")).unwrap();
        let file = d.path().join("foreign");
        std::fs::write(&file, b"{}").unwrap();
        std::os::unix::fs::symlink(file, d.path().join("upgrades.json")).unwrap();
        assert!(Journal::load(d.path()).is_err());
    }
}
