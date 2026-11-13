//! The one error type of the log write path. The messages are those of the TypeScript `Error`s (`writer.ts`, `sink.ts`,
//! `output.ts`), so a caller and a test can match on them the way the TypeScript tests do.
use std::fmt;
use std::io;

/// A failure of the writer, the sink, the output framer or the level policy.
#[derive(Debug)]
pub enum LogError {
    /// `log writer closed`: the writer was closed.
    Closed,
    /// `unregistered log event: <name>`: strict mode, the event is not in the catalogue.
    Unregistered(String),
    /// `diagnostic writer cannot write audit or payload`.
    WrongStream,
    /// `invalid log record: <code> <detail>`: the line failed `plur1bus_log_schema::validate_line`.
    Invalid {
        /// The validator's code (`Code::as_str`).
        code: &'static str,
        /// The validator's detail.
        detail: String,
    },
    /// `record cannot fit byte limit`.
    TooLarge,
    /// A `RangeError` of the TypeScript source: invalid level settings, rotation, role, retention days, window.
    Range(String),
    /// `log writer busy`: the role lock was not free in time.
    Busy,
    /// `log path is not a regular file`.
    NotRegularFile,
    /// `log directory is not a directory`.
    NotDirectory,
    /// `cannot secure log path`: the secure-path hook did not apply.
    CannotSecure,
    /// `short log write`.
    ShortWrite,
    /// `output wrapper closed`.
    OutputClosed,
    /// An operating-system error.
    Io(io::Error),
}

impl fmt::Display for LogError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            LogError::Closed => f.write_str("log writer closed"),
            LogError::Unregistered(name) => write!(f, "unregistered log event: {name}"),
            LogError::WrongStream => f.write_str("diagnostic writer cannot write audit or payload"),
            LogError::Invalid { code, detail } => write!(f, "invalid log record: {code} {detail}"),
            LogError::TooLarge => f.write_str("record cannot fit byte limit"),
            LogError::Range(message) => f.write_str(message),
            LogError::Busy => f.write_str("log writer busy"),
            LogError::NotRegularFile => f.write_str("log path is not a regular file"),
            LogError::NotDirectory => f.write_str("log directory is not a directory"),
            LogError::CannotSecure => f.write_str("cannot secure log path"),
            LogError::ShortWrite => f.write_str("short log write"),
            LogError::OutputClosed => f.write_str("output wrapper closed"),
            LogError::Io(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for LogError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            LogError::Io(e) => Some(e),
            _ => None,
        }
    }
}

impl From<io::Error> for LogError {
    fn from(e: io::Error) -> Self {
        LogError::Io(e)
    }
}
