//! `plur1bus-log-schema`: `validate_line` (diagnostic and payload records) and `validate_audit_line` (audit records).
//! First byte selects the mode: even, the rest is the line; odd, a record is built from a catalogue example and
//! mutated by the rest of the input, so the later checks (level, key order, attrs group) are reached. Invariants: no
//! panic; an accepted line names a catalogue entry (`lookup_event` finds it); the accepted line is a JSON object.
use arbitrary::Unstructured;
use plur1bus_log_schema as ls;
use serde_json::Value;

fn check(line: &str) {
    for audit in [false, true] {
        let r = if audit {
            ls::validate_audit_line(line)
        } else {
            ls::validate_line(line)
        };
        if let Ok(entry) = r {
            assert!(
                ls::lookup_event(&entry.event).is_some(),
                "accepted event {:?} is not in the catalogue",
                entry.event
            );
            assert_eq!(
                entry.is_audit(),
                audit,
                "a line was accepted by the wrong validator"
            );
            assert!(matches!(
                serde_json::from_str::<Value>(line),
                Ok(Value::Object(_))
            ));
        }
    }
}

fn mutated(u: &mut Unstructured) -> Option<String> {
    let cat = ls::catalogue();
    let entry = u.choose(&cat.events).ok()?;
    let mut rec = entry.examples.first()?.clone();
    for _ in 0..u.int_in_range(0..=3).ok()? {
        let obj = rec.as_object_mut()?;
        let keys: Vec<String> = obj.keys().cloned().collect();
        match u.int_in_range(0..=3).ok()? {
            0 if !keys.is_empty() => {
                obj.remove(u.choose(&keys).ok()?);
            }
            1 => {
                let k = if keys.is_empty() || u.ratio(1, 2).ok()? {
                    u.arbitrary::<String>().ok()?
                } else {
                    u.choose(&keys).ok()?.clone()
                };
                let v = match u.int_in_range(0..=4).ok()? {
                    0 => Value::String(u.arbitrary().ok()?),
                    1 => Value::from(u.arbitrary::<i64>().ok()?),
                    2 => Value::Bool(u.arbitrary().ok()?),
                    3 => Value::Null,
                    _ => Value::String(
                        u.choose(&["trace", "debug", "info", "warn", "error", "fatal", "FATAL"])
                            .ok()?
                            .to_string(),
                    ),
                };
                obj.insert(k, v);
            }
            2 if !keys.is_empty() => {
                let k = u.choose(&keys).ok()?.clone();
                let v = obj.remove(&k)?;
                obj.insert(k, v); // moves the key last: key-order checks
            }
            _ => {}
        }
    }
    serde_json::to_string(&rec).ok()
}

pub fn run(data: &[u8]) {
    let Some((&mode, rest)) = data.split_first() else {
        return;
    };
    if mode % 2 == 0 {
        if let Ok(line) = std::str::from_utf8(rest) {
            check(line);
        }
    } else if let Some(line) = mutated(&mut Unstructured::new(rest)) {
        check(&line);
    }
    let s = String::from_utf8_lossy(rest);
    let _ = (
        ls::Level::parse(&s),
        ls::lookup_event(&s),
        ls::is_source_key(&s),
    );
}
