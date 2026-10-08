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
                !safe(v)
                    || !matches!(
                        p.as_str(),
                        STATE_MOUNT
                            | "/models"
                            | "/backup"
                            | "/var/lib/plur1bus"
                            | "/var/lib/plur1bus-models"
                            | "/src"
                            | "/dst"
                            | "/snap"
                    )
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

/// Canonical bundled harness policy, including the spec's native state roots.
pub fn harness_spec(
    b: &crate::controller::bundle::Bundle,
    port: u16,
    res: &crate::controller::Resources,
    extra_env: &[(String, String)],
) -> ContainerSpec {
    let digest = b
        .digest(crate::controller::bundle::Arch::host())
        .unwrap_or_default()
        .to_string();
    let labels = Labels::from([
        ("app.plur1bus.role".into(), "harness".into()),
        ("app.plur1bus.version".into(), b.version.clone()),
        ("app.plur1bus.image.digest".into(), digest.clone()),
    ]);
    let mut env = vec![
        ("PLUR1BUS_CONTAINER".into(), "1".into()),
        ("PLUR1BUS_HOME".into(), "/var/lib/plur1bus".into()),
        (
            "TZ".into(),
            std::env::var("TZ")
                .ok()
                .filter(|v| {
                    v.len() < 128
                        && v.chars()
                            .all(|c| c.is_ascii_alphanumeric() || "_/-+".contains(c))
                })
                .unwrap_or_else(|| "UTC".into()),
        ),
        (
            "LANG".into(),
            std::env::var("LANG")
                .ok()
                .filter(|v| {
                    v.len() < 128
                        && v.chars()
                            .all(|c| c.is_ascii_alphanumeric() || "_.@-".contains(c))
                })
                .unwrap_or_else(|| "C.UTF-8".into()),
        ),
    ];
    env.extend_from_slice(extra_env);
    ContainerSpec {
        name: crate::ids::CONTAINER.into(),
        image_digest: digest,
        host_port: Some(port),
        memory_mib: res.memory_mib,
        cpus: res.cpus,
        volumes: vec![
            ("plur1bus-state".into(), "/var/lib/plur1bus".into(), false),
            (
                "plur1bus-models".into(),
                "/var/lib/plur1bus-models".into(),
                false,
            ),
        ],
        env,
        labels,
        network: Some("plur1bus".into()),
        cmd: None,
        restart: true,
    }
}
