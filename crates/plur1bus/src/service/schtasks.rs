//! Task Scheduler task with a logon trigger for the current user, registered with `schtasks` from an XML file
//! written to `<home>/run/<name>.xml` (UTF-16LE with a BOM, as declared).
use super::{exec, exec_ok, os_args, remove_file, xml_escape, Runner, ServiceError};
use std::ffi::OsString;
use std::path::Path;

/// `DOMAIN\user` of the current process (`%USERDOMAIN%\%USERNAME%`), for the logon trigger and the principal. A
/// logon trigger for one's own account needs no admin rights.
pub fn current_user() -> String {
    let user = std::env::var("USERNAME").unwrap_or_else(|_| whoami::username());
    match std::env::var("USERDOMAIN") {
        Ok(d) if !d.is_empty() => format!("{d}\\{user}"),
        _ => user,
    }
}

/// The task definition. `RestartOnFailure` (every minute, 999 times) restarts a supervisor whose run failed;
/// `LeastPrivilege` + `InteractiveToken` runs it as the logged-in user without elevation; `ExecutionTimeLimit PT0S`
/// lets it run forever; `MultipleInstancesPolicy IgnoreNew` keeps a manual `/Run` from starting a second one.
pub fn render(bin: &Path, home: &Path, user: &str) -> String {
    let user = xml_escape(user);
    let bin = bin.to_string_lossy();
    // Command is the program path; quote it when it has spaces, as the Task Scheduler UI does.
    let command = if bin.contains(' ') {
        format!("\"{bin}\"")
    } else {
        bin.to_string()
    };
    let arguments = format!("--home {} supervise", quote_arg(&home.to_string_lossy()));
    format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>PLUR1BUS supervisor</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>{user}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>{user}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{command}</Command>
      <Arguments>{arguments}</Arguments>
    </Exec>
  </Actions>
</Task>
"#,
        command = xml_escape(&command),
        arguments = xml_escape(&arguments),
    )
}

/// One command-line argument quoted for `CommandLineToArgvW`: in double quotes, a `"` as `\"`, and backslashes
/// doubled only where they precede a quote (including the closing one).
fn quote_arg(s: &str) -> String {
    let mut out = String::from("\"");
    let mut backslashes = 0usize;
    for c in s.chars() {
        match c {
            '\\' => backslashes += 1,
            '"' => {
                out.push_str(&"\\".repeat(backslashes * 2 + 1));
                out.push('"');
                backslashes = 0;
            }
            c => {
                out.push_str(&"\\".repeat(backslashes));
                out.push(c);
                backslashes = 0;
            }
        }
    }
    out.push_str(&"\\".repeat(backslashes * 2));
    out.push('"');
    out
}

/// The task XML as schtasks reads it: UTF-16 little endian with a byte-order mark.
pub fn utf16le_with_bom(s: &str) -> Vec<u8> {
    let mut b = vec![0xFF, 0xFE];
    for u in s.encode_utf16() {
        b.extend_from_slice(&u.to_le_bytes());
    }
    b
}

pub fn install(r: &dyn Runner, name: &str, xml: &Path, start: bool) -> Result<(), ServiceError> {
    let args: Vec<OsString> = vec![
        "/Create".into(),
        "/XML".into(),
        xml.as_os_str().to_os_string(),
        "/TN".into(),
        name.into(),
        "/F".into(),
    ];
    exec_ok(r, "schtasks", &args)?;
    if start {
        exec_ok(r, "schtasks", &os_args(&["/Run", "/TN", name]))?;
    }
    Ok(())
}

fn query(r: &dyn Runner, name: &str) -> Option<String> {
    let out = exec(
        r,
        "schtasks",
        &os_args(&["/Query", "/TN", name, "/FO", "CSV"]),
    )
    .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Registered means `/Query` knows the task. `/End` stops a running supervisor first (Task Scheduler can only
/// terminate it; the core, if any, then ends by its own grace timer), `/Delete` unregisters it.
pub fn uninstall(r: &dyn Runner, name: &str, xml: &Path) -> Result<bool, ServiceError> {
    if query(r, name).is_none() {
        remove_file(xml)?;
        return Ok(false);
    }
    // /End fails when the task is not running; that is fine.
    exec(r, "schtasks", &os_args(&["/End", "/TN", name]))?;
    exec_ok(r, "schtasks", &os_args(&["/Delete", "/TN", name, "/F"]))?;
    remove_file(xml)?;
    Ok(true)
}

/// `/Query /FO CSV` prints a header and one row whose last column is the status. The status text is localised;
/// this recognises the English `Running` and the German `Wird ausgeführt` (matched on its ASCII prefix, because the
/// console code page is not UTF-8).
pub fn status(r: &dyn Runner, name: &str) -> (bool, bool) {
    match query(r, name) {
        None => (false, false),
        Some(csv) => {
            let running = csv.lines().skip(1).any(|row| {
                let last = row
                    .rsplit(',')
                    .next()
                    .unwrap_or("")
                    .trim()
                    .trim_matches('"');
                last == "Running" || last.starts_with("Wird ausgef")
            });
            (true, running)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(xml: &str) -> roxmltree::Document<'_> {
        roxmltree::Document::parse(xml).unwrap()
    }
    fn text<'a>(doc: &'a roxmltree::Document, path: &[&str]) -> &'a str {
        let mut node = doc.root_element();
        for tag in path {
            node = node
                .children()
                .find(|n| n.tag_name().name() == *tag)
                .unwrap_or_else(|| panic!("<{tag}> missing"));
        }
        node.text().unwrap_or("")
    }
    /// The file bytes decoded back from UTF-16LE (after the BOM).
    fn decode(bytes: &[u8]) -> String {
        assert_eq!(&bytes[..2], &[0xFF, 0xFE], "BOM");
        let units: Vec<u16> = bytes[2..]
            .chunks(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16(&units).unwrap()
    }

    #[test]
    fn task_xml_restarts_on_failure_at_logon_without_admin() {
        let xml = render(
            Path::new(r"C:\p1b\plur1bus.exe"),
            Path::new(r"C:\Users\c\AppData\Local\PLUR1BUS"),
            r"HOST\c",
        );
        let decoded = decode(&utf16le_with_bom(&xml));
        assert!(decoded.starts_with("<?xml version=\"1.0\" encoding=\"UTF-16\"?>"));
        let doc = parse(&decoded);
        assert_eq!(
            text(&doc, &["Triggers", "LogonTrigger", "UserId"]),
            r"HOST\c"
        );
        assert_eq!(
            text(&doc, &["Settings", "RestartOnFailure", "Interval"]),
            "PT1M"
        );
        assert_eq!(
            text(&doc, &["Settings", "RestartOnFailure", "Count"]),
            "999"
        );
        assert_eq!(
            text(&doc, &["Principals", "Principal", "RunLevel"]),
            "LeastPrivilege"
        );
        assert_eq!(text(&doc, &["Settings", "ExecutionTimeLimit"]), "PT0S");
        assert_eq!(
            text(&doc, &["Actions", "Exec", "Command"]),
            r"C:\p1b\plur1bus.exe"
        );
        assert_eq!(
            text(&doc, &["Actions", "Exec", "Arguments"]),
            r#"--home "C:\Users\c\AppData\Local\PLUR1BUS" supervise"#
        );
    }

    #[test]
    fn renders_a_home_with_spaces_and_umlauts() {
        let home = r"C:\Users\Max Mustermann & Co\AppData\Local\PLUR1BUS ü";
        let xml = render(
            Path::new(r"C:\Program Files\P1B <x>\plur1bus.exe"),
            Path::new(home),
            r"HOST\Max & Co",
        );
        assert!(xml.contains("Max Mustermann &amp; Co"), "{xml}");
        assert!(xml.contains("&quot;"), "{xml}");
        let doc = parse(&xml);
        assert_eq!(
            text(&doc, &["Actions", "Exec", "Command"]),
            r#""C:\Program Files\P1B <x>\plur1bus.exe""#
        );
        assert_eq!(
            text(&doc, &["Actions", "Exec", "Arguments"]),
            format!("--home \"{home}\" supervise")
        );
        assert_eq!(
            text(&doc, &["Principals", "Principal", "UserId"]),
            r"HOST\Max & Co"
        );
        // Round trip through UTF-16 keeps the umlaut.
        assert!(decode(&utf16le_with_bom(&xml)).contains("PLUR1BUS ü"));
    }

    #[test]
    fn arguments_quote_for_command_line_to_argv() {
        assert_eq!(quote_arg(r"C:\a b"), r#""C:\a b""#);
        assert_eq!(quote_arg(r"C:\"), r#""C:\\""#);
        assert_eq!(quote_arg(r#"a\"b"#), r#""a\\\"b""#);
    }

    #[test]
    fn status_reads_the_csv_row() {
        use super::super::testing::output;
        struct Csv(&'static str);
        impl Runner for Csv {
            fn run(&self, _: &str, _: &[OsString]) -> std::io::Result<std::process::Output> {
                let mut o = output(0);
                o.stdout = self.0.as_bytes().to_vec();
                Ok(o)
            }
        }
        let header = "\"TaskName\",\"Next Run Time\",\"Status\"\r\n";
        let run = format!("{header}\"\\PLUR1BUS Supervisor\",\"N/A\",\"Running\"\r\n");
        let ready = format!("{header}\"\\PLUR1BUS Supervisor\",\"N/A\",\"Ready\"\r\n");
        assert_eq!(status(&Csv(run.leak()), "n"), (true, true));
        assert_eq!(status(&Csv(ready.leak()), "n"), (true, false));
    }
}
