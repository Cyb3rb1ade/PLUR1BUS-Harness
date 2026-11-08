use super::{glob, list, text};
use crate::ToolError;
use serde_json::{json, Value};
pub(super) fn check(input: &Value) -> Result<Value, ToolError> {
    let merged = &input["merged"];
    let affected=list(input,"running").iter().filter_map(|p| {
        let mut reasons=Vec::new();
        if list(p,"dependsOn").iter().any(|d|d==&merged["key"]){reasons.push("dependency")}
        let interface=list(p,"consumes").iter().any(|d|list(merged,"provides").contains(d));
        if interface {reasons.push("interface")}
        let overlap:Vec<_>=list(merged,"files").iter().filter(|f|list(p,"changedFiles").contains(*f)||list(p,"owns").iter().any(|o|glob::matches(text(o,"glob"),f.as_str().unwrap_or("")))).cloned().collect();
        if !overlap.is_empty(){reasons.push("overlap")}
        if reasons.is_empty(){return None}
        let lane=if text(p,"lane")=="closed"||list(merged,"files").iter().any(|f|!glob::valid(f.as_str().unwrap_or(""))||f.as_str().unwrap_or("").contains('*')){"closed"}else if text(p,"lane")=="wide"||p["section"]!=merged["section"]{"wide"}else{"contained"};
        Some(json!({"package":p["key"],"reasons":reasons,"interfaceFiles":if interface {list(merged,"files").to_vec()}else{overlap},"lane":lane}))
    }).collect::<Vec<_>>();
    let mut affected = affected;
    if affected.len() >= 5 {
        for p in &mut affected {
            if p["lane"] != "closed" {
                p["lane"] = json!("wide")
            }
        }
    }
    Ok(json!({"affected":affected}))
}
