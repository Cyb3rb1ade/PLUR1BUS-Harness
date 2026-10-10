use crate::*;
use std::path::PathBuf;
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub enum ImageSource {
    Online(String),
    Offline(PathBuf),
}
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub enum InstallStep {
    UseRuntime(RuntimeKind),
    BundleApple,
    ActivateApple,
    ShowDockerLicense,
    DownloadDockerAfterConsent { url: String },
    WaitForDocker,
    PullImage(String),
    LoadImage(PathBuf),
    SelectSidecars,
}
#[derive(Clone, Debug, serde::Serialize)]
pub struct InstallPlan {
    pub steps: Vec<InstallStep>,
    pub notices: Vec<String>,
}
/// Pure plan only. The installer must collect licence/download consent before execution.
pub fn plan_install(
    platform: Platform,
    detections: &[Detection],
    source: ImageSource,
) -> InstallPlan {
    let mut p = InstallPlan {
        steps: vec![],
        notices: vec![],
    };
    let stopped_apple = platform == Platform::MacArm
        && detections
            .iter()
            .any(|d| d.kind == RuntimeKind::Apple && d.state == RuntimeState::Stopped);
    let unsupported_apple = detections
        .iter()
        .any(|d| d.kind == RuntimeKind::Apple && d.state == RuntimeState::Unsupported);
    if stopped_apple {
        p.steps.extend([
            InstallStep::ActivateApple,
            InstallStep::UseRuntime(RuntimeKind::Apple),
        ]);
    } else if let Ok(runtime) = select_runtime(None, platform, detections) {
        p.steps.push(InstallStep::UseRuntime(runtime));
    } else if platform == Platform::MacArm && !unsupported_apple {
        p.steps
            .extend([InstallStep::BundleApple, InstallStep::ActivateApple]);
        p.notices.push(format!(
            "Apple container {APPLE_VERSION}, Apache-2.0; macOS >=26 required"
        ));
    } else {
        let url = match platform {
            Platform::Linux => "https://get.docker.com",
            Platform::Windows => "https://docs.docker.com/desktop/setup/install/windows-install/",
            _ => "https://docs.docker.com/desktop/setup/install/mac-install/",
        };
        p.steps.extend([
            InstallStep::ShowDockerLicense,
            InstallStep::DownloadDockerAfterConsent { url: url.into() },
            InstallStep::WaitForDocker,
        ]);
        p.notices.push("Docker required. Engine licence: https://github.com/moby/moby/blob/master/LICENSE ; Desktop terms: https://www.docker.com/legal/docker-subscription-service-agreement/ . Download only after consent; this library produces a plan.".into());
    }
    p.steps.push(match source {
        ImageSource::Online(s) => InstallStep::PullImage(s),
        ImageSource::Offline(p) => InstallStep::LoadImage(p),
    });
    p.steps.push(InstallStep::SelectSidecars);
    p
}
