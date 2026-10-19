#[cfg(feature = "ssh")]
mod direct_key_policy;
#[cfg(feature = "ssh")]
mod spike;

#[cfg(feature = "ssh")]
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    tokio::time::timeout(std::time::Duration::from_secs(120), spike::run()).await?
}

#[cfg(not(feature = "ssh"))]
fn main() {
    println!("SSH spike size baseline (transport disabled)");
}
