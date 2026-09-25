use serde::Serialize;
use serde_json::json;

pub struct Out {
    pub json: bool,
}

impl Out {
    pub fn ok<T: Serialize>(&self, value: &T, human: impl FnOnce() -> String) {
        if self.json {
            println!("{}", serde_json::to_string(value).unwrap());
        } else {
            println!("{}", human());
        }
    }
    /// Prints an error and exits. JSON goes to stdout (stable shape), human text to stderr.
    pub fn fail(&self, code: &str, message: &str, extra: serde_json::Value, exit: i32) -> ! {
        if self.json {
            let mut v = json!({ "error": code, "message": message });
            if let (Some(a), Some(b)) = (v.as_object_mut(), extra.as_object()) {
                for (k, x) in b {
                    a.insert(k.clone(), x.clone());
                }
            }
            println!("{v}");
        } else {
            eprintln!("plur1bus: {message}");
        }
        std::process::exit(exit)
    }
    // `from_*` here is the brief's literal interface name for a "build+emit error
    // from an RpcError" helper, not a `From` conversion, so it legitimately takes `&self`.
    #[allow(clippy::wrong_self_convention)]
    pub fn from_rpc_error(&self, e: &plur1bus_rpc::RpcError) -> ! {
        let exit = match e.code_name().as_str() {
            "E_LOCKED" => 3,
            "E_NOT_AVAILABLE" => 2,
            _ => 1,
        };
        self.fail(&e.code_name(), &e.to_string(), json!({}), exit)
    }
}
