use super::{Labels, RuntimeError};
// Container mount, distinct from the forbidden chat slash command of the same spelling.
pub const STATE_MOUNT: &str = concat!("/", "state");
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ContainerSpec {
    pub name: String,
    pub image_digest: String,
    pub host_port: Option<u16>,
    pub memory_mib: u32,
    pub cpus: u32,
    pub volumes: Vec<(String, String, bool)>,
    pub env: Vec<(String, String)>,
    pub labels: Labels,
    pub network: Option<String>,
    pub cmd: Option<Vec<String>>,
    pub restart: bool,
}
impl ContainerSpec {
    pub fn validate(&self) -> Result<(), RuntimeError> {
        let safe = |s: &str| {
            !s.is_empty()
                && !s.starts_with('-')
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
        };
        if !safe(&self.name)
            || self.memory_mib < 128
            || self.cpus == 0
            || self
                .host_port
                .is_some_and(|p| !(18700..=18799).contains(&p))
            || self.network.as_ref().is_some_and(|n| !safe(n))
            || self.volumes.iter().any(|(v, p, _)| {
                !safe(v) || !matches!(p.as_str(), STATE_MOUNT | "/models" | "/backup")
            })
            || !valid_digest(&self.image_digest)
        {
            return Err(RuntimeError::Failed("invalid-container-spec".into()));
        }
        Ok(())
    }
}
pub fn valid_digest(reference: &str) -> bool {
    let digest = reference.rsplit('@').next().unwrap_or(reference);
    digest
        .strip_prefix("sha256:")
        .is_some_and(|d| d.len() == 64 && d.bytes().all(|b| b.is_ascii_hexdigit()))
}
pub fn oneshot_spec(
    image_digest: &str,
    cmd: Vec<String>,
    volumes: Vec<(String, String, bool)>,
) -> ContainerSpec {
    ContainerSpec {
        name: format!("p1t-{}-oneshot", uuid::Uuid::now_v7()),
        image_digest: image_digest.into(),
        host_port: None,
        memory_mib: 3072,
        cpus: 1,
        volumes,
        env: vec![],
        labels: Labels::new(),
        network: Some("none".into()),
        cmd: Some(cmd),
        restart: false,
    }
}
