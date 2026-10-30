//! Isolated A13 producer: foreign configuration becomes metadata-only imported packages, with no copied executable code.
use super::imported::{self, Candidate, HeaderAuth, Transport};
use super::record::{self, InspectionRecord};
use super::state::write_private_atomic;
use super::ExtError;
use crate::paths::Layout;
use plur1bus_ext::compat::acknowledged_capabilities;
use plur1bus_ext::pack::{pack_files, PayloadFile};
use serde_json::{json, Value};
use std::io::Cursor;
use std::path::Path;

const CREATED: &str = "1970-01-01T00:00:00.000Z";

fn files(candidate: &Candidate, remote: bool) -> Result<Vec<PayloadFile>, ExtError> {
    let readme = PayloadFile { rel: "README.md".into(), exec: false,
        bytes: b"Imported MCP configuration. This package is disabled. Review and configure it before enabling.\n".to_vec() };
    if remote {
        return Ok(vec![readme]);
    }
    let metadata = json!({"manifest_version":"0.4","name":candidate.name,"version":candidate.version(),
        "description":"Imported MCP server requires manual setup","author":{"name":"Local import"},
        "server":{"type":"binary","entry_point":"SETUP_REQUIRED.txt","mcp_config":{
            "command":"${__dirname}/SETUP_REQUIRED.txt","args":[]}}});
    Ok(vec![readme, PayloadFile { rel: "manifest.json".into(), exec: false,
        bytes: serde_json::to_vec(&metadata).map_err(|_| imported::invalid())? },
        PayloadFile { rel: "SETUP_REQUIRED.txt".into(), exec: false,
            bytes: b"No source command, arguments, code or working directory was imported. Install a reviewed MCP package to finish setup.\n".to_vec() }])
}

/** This private operation assigns imported provenance; source data never selects a trust tier or enable flag. */
pub fn prepare(
    layout: &Layout,
    id: &str,
    installation_id: &str,
    candidate_file: &Path,
) -> Result<Value, ExtError> {
    if !record::valid_id(id) || !imported::is_hash(installation_id) {
        return Err(imported::invalid());
    }
    let candidate = Candidate::parse(&imported::read_metadata(candidate_file, false)?)?;
    let remote = match &candidate.transport {
        Transport::Http { url, .. } => plur1bus_ext::kinds::url_host(url).ok(),
        Transport::Manual { .. } => None,
    };
    let secrets: Vec<Value> = candidate.required_secrets.iter().map(|item| {
        let slot = if item.slot.starts_with(|character: char| character.is_ascii_alphabetic()) { item.slot.clone() }
            else { format!("IMPORT_SLOT_{}", &imported::hash(item.slot.as_bytes())[..16]).to_ascii_uppercase() };
        json!({"slot":slot,"label":{"en":format!("Imported slot {}",item.slot)},"required":true})
    }).collect();
    let mut template = json!({"format":1,"id":candidate.identity(),"name":candidate.name,"version":candidate.version(),
        "kind":"mcp-server","title":{"en":"Imported MCP configuration"},"summary":{"en":"Disabled source configuration"},
        "publisher":{"id":"imported","name":"Local import"},"licence":"LicenseRef-Imported-Configuration",
        "compat":{"harness":">=0.0.0"},"requires":{"runtime":{"type":if remote.is_some(){"none"}else{"binary"}}},
        "defaultEnabled":false,"capabilities":{"network":{"mode":"none"},"filesystem":[],
            "processes":{"spawn":remote.is_none()},"harness":{"authority":"none"},"tools":[],"secrets":secrets},
        "notes":{"en":imported::provenance_note(&candidate.digest()?,installation_id)}});
    if let (Some(host), Transport::Http { url, auth }) = (&remote, &candidate.transport) {
        template["capabilities"]["network"] = json!({"mode":"allowlist","hosts":[host]});
        template["remote"] = json!({"url":url,"auth":match auth{HeaderAuth::None=>"none",HeaderAuth::Header=>"header"}});
    }
    let mut archive = Cursor::new(Vec::new());
    let manifest = pack_files(
        &template,
        files(&candidate, remote.is_some())?,
        CREATED,
        &mut archive,
    )?;
    plur1bus_ext::kinds::check_kind(&manifest)?;
    let package = archive.into_inner();
    let rec = InspectionRecord {
        inspection_id: id.into(),
        expires_at: super::iso8601(
            record::now_ms().saturating_add(super::host::inspect_ttl().as_millis() as u64),
        ),
        sha256: imported::hash(&package),
        source_path: None,
        normalised: true,
        manifest: serde_json::to_value(&manifest).map_err(|_| imported::invalid())?,
        trust: json!({"tier":"imported"}),
        checks: json!([]),
        capabilities: acknowledged_capabilities(&manifest),
        scripts: json!([]),
        requires: manifest.requires.clone(),
        replaces: None,
        members: Vec::new(),
    };
    write_private_atomic(&record::spool_path(layout, id), &package)
        .map_err(|_| imported::invalid())?;
    write_private_atomic(
        &record::record_path(layout, id),
        &serde_json::to_vec(&rec).map_err(|_| imported::invalid())?,
    )
    .map_err(|_| imported::invalid())?;
    let mut staged = super::stage::stage_with(layout, id, false)?;
    staged.record.source = "local".into();
    staged.record.trust = "imported".into();
    let metadata_path = staged.dir.join("record.json");
    let mut metadata = imported::read_metadata(&metadata_path, false)?;
    metadata["trust"] = json!("imported");
    write_private_atomic(
        &metadata_path,
        &serde_json::to_vec(&metadata).map_err(|_| imported::invalid())?,
    )
    .map_err(|_| imported::invalid())?;
    Ok(json!({"inspection":rec,"staged":staged}))
}
