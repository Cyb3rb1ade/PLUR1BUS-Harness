//! Debug-only Windows fixture launcher; no product process ownership changes.
#[cfg(all(windows, debug_assertions))]
#[path = "support/windows_job.rs"]
mod job;

// Windows CRT argument quoting, including quotes and trailing backslashes.
#[cfg(any(windows, test))]
fn command_line(executable: &str, args: &[String]) -> String {
    std::iter::once(executable)
        .chain(args.iter().map(String::as_str))
        .map(|argument| {
            let mut output = String::from("\"");
            let mut slashes = 0;
            for character in argument.chars() {
                if character == '\\' {
                    slashes += 1;
                    continue;
                }
                if character == '"' {
                    output.extend(std::iter::repeat_n('\\', slashes * 2 + 1));
                } else {
                    output.extend(std::iter::repeat_n('\\', slashes));
                }
                slashes = 0;
                output.push(character);
            }
            output.extend(std::iter::repeat_n('\\', slashes * 2));
            output.push('"');
            output
        })
        .collect::<Vec<_>>()
        .join(" ")
}
#[cfg(any(windows, test))]
fn image_name(raw: &str) -> String {
    // Only basename metadata, bounded and safe for the failure-only wire format.
    let name: String = raw
        .chars()
        .take(128)
        .map(|c| {
            if c.is_ascii_alphanumeric() || "._-".contains(c) {
                c
            } else {
                '_'
            }
        })
        .collect();
    if name.is_empty() {
        "unavailable".to_owned()
    } else {
        name
    }
}
#[cfg(all(windows, debug_assertions))]
fn main() {
    let mut args = std::env::args().skip(1);
    let Some(fixture) = args.next().filter(|s| {
        matches!(
            s.as_str(),
            "production_lifecycle" | "production_diagnostics"
        )
    }) else {
        eprintln!("FIXTURE_JOB_ARGUMENT_INVALID");
        std::process::exit(2);
    };
    let executable = match std::env::current_exe() {
        Ok(path) => path.with_file_name(format!("{fixture}.exe")),
        Err(_) => {
            eprintln!("FIXTURE_JOB_EXECUTABLE_FAILED");
            std::process::exit(2);
        }
    };
    match job::run(&executable, &args.collect::<Vec<_>>()) {
        Ok(code) => std::process::exit(code.min(i32::MAX as u32) as i32),
        Err(reason) => {
            eprintln!("{reason}");
            std::process::exit(2);
        }
    }
}
#[cfg(not(all(windows, debug_assertions)))]
fn main() {
    eprintln!("FIXTURE_JOB_UNAVAILABLE");
    std::process::exit(2);
}

#[cfg(test)]
mod tests {
    #[test]
    fn command_line_quotes_empty_space_quote_and_trailing_slash() {
        assert_eq!(
            super::command_line(
                "app.exe",
                &["".into(), "a b".into(), "a\"b".into(), "a\\".into()]
            ),
            "\"app.exe\" \"\" \"a b\" \"a\\\"b\" \"a\\\\\""
        );
    }
    #[test]
    fn process_image_is_basename_only_and_wire_safe() {
        assert_eq!(
            super::image_name("msedgewebview2.exe"),
            "msedgewebview2.exe"
        );
        assert_eq!(super::image_name("evil name\n:123"), "evil_name__123");
        assert_eq!(super::image_name(&"x".repeat(200)).len(), 128);
    }
    #[cfg(windows)]
    fn worker_args(name: &str) -> Vec<String> {
        vec![
            "--exact".into(),
            format!("tests::{name}"),
            "--ignored".into(),
            "--nocapture".into(),
        ]
    }
    #[cfg(windows)]
    #[test]
    fn job_drains_inherited_descendant_after_primary_exit() {
        let job = super::job::Job::create().unwrap();
        let child = job
            .launch(
                &std::env::current_exe().unwrap(),
                &worker_args("primary_worker"),
            )
            .unwrap();
        assert_eq!(child.wait().unwrap(), 0);
        assert!(
            job.active().unwrap() > 0,
            "descendant must still be alive after primary exit"
        );
        assert!(job.drain(std::time::Duration::from_secs(10)).unwrap());
        assert_eq!(job.active().unwrap(), 0);
    }
    #[cfg(windows)]
    #[test]
    fn job_timeout_retains_names_then_termination_confirms_zero() {
        let job = super::job::Job::create().unwrap();
        let child = job
            .launch(
                &std::env::current_exe().unwrap(),
                &worker_args("long_primary_worker"),
            )
            .unwrap();
        assert_eq!(child.wait().unwrap(), 0);
        assert!(!job.drain(std::time::Duration::from_millis(50)).unwrap());
        let rows = job.remaining().unwrap();
        assert!(
            rows.contains("production_job"),
            "must report the actual remaining image: {rows}"
        );
        assert!(rows.split(',').all(|row| row.split(':').count() == 3));
        job.terminate().unwrap();
        assert!(job.drain(std::time::Duration::from_secs(10)).unwrap());
        assert_eq!(job.active().unwrap(), 0);
    }
    #[cfg(windows)]
    #[test]
    fn closing_job_kills_live_member_without_leaking() {
        let job = super::job::Job::create().unwrap();
        let child = job
            .launch(
                &std::env::current_exe().unwrap(),
                &worker_args("long_descendant_worker"),
            )
            .unwrap();
        assert_eq!(job.active().unwrap(), 1);
        drop(job);
        assert!(child.exited_within(std::time::Duration::from_secs(2)));
        child.wait().unwrap();
    }
    #[cfg(windows)]
    // This worker intentionally exits without waiting; the surrounding job owns the child.
    #[allow(clippy::zombie_processes)]
    fn spawn_descendant(name: &str) {
        std::process::Command::new(std::env::current_exe().unwrap())
            .args(worker_args(name))
            .spawn()
            .expect("owned descendant spawn");
    }
    #[cfg(windows)]
    #[test]
    #[ignore = "subprocess entry selected only by the job inheritance test"]
    fn primary_worker() {
        spawn_descendant("descendant_worker");
    }
    #[cfg(windows)]
    #[test]
    #[ignore = "subprocess entry selected only by the job timeout test"]
    fn long_primary_worker() {
        spawn_descendant("long_descendant_worker");
    }
    #[cfg(windows)]
    #[test]
    #[ignore = "owned descendant subprocess, never a top-level test"]
    fn descendant_worker() {
        std::thread::sleep(std::time::Duration::from_millis(1500));
    }
    #[cfg(windows)]
    #[test]
    #[ignore = "owned long-lived descendant terminated by its job"]
    fn long_descendant_worker() {
        std::thread::sleep(std::time::Duration::from_secs(30));
    }
}
