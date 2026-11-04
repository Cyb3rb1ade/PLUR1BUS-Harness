/// Compare the architecture injected by process startup without printing values.
pub fn fingerprint() -> Option<String> {
    use sha2::Digest;
    std::env::var_os("PROCESSOR_ARCHITECTURE")
        .map(|value| format!("{:x}", sha2::Sha256::digest(value.as_encoded_bytes())))
}
