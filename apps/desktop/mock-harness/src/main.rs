use plur1bus_mock_harness::{MockHarness, MockOptions};
use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::PathBuf,
};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut options = MockOptions::default();
    let mut port = 18700_u16;
    let mut bind = IpAddr::V4(Ipv4Addr::LOCALHOST);
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--port" => port = args.next().ok_or("missing port")?.parse()?,
            "--bind" => bind = args.next().ok_or("missing bind")?.parse()?,
            "--state-dir" => {
                options.state_dir = Some(PathBuf::from(args.next().ok_or("missing state-dir")?))
            }
            "--test-control" => options.test_control = true,
            _ => return Err(format!("unsupported argument: {arg}").into()),
        }
    }
    options.test_control |= std::env::var("PLUR1BUS_DESKTOP_TEST_CONTROL").as_deref() == Ok("1");
    options.approvals_decide |=
        std::env::var("PLUR1BUS_DESKTOP_APPROVALS_DECIDE").as_deref() == Ok("1");
    options.bind = SocketAddr::new(bind, port);
    let handle = MockHarness::start(options).await?;
    println!("{}", handle.origin);
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = term.recv() => {} }
    }
    #[cfg(not(unix))]
    tokio::signal::ctrl_c().await?;
    Ok(())
}
