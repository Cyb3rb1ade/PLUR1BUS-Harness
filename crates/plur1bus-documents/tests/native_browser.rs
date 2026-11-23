#![allow(
    clippy::unwrap_used,
    reason = "explicit native browser acceptance test"
)]

use plur1bus_documents::{
    browser::Chromium,
    chromium::{Control, Error},
    render::{assemble_html, FontDirectory},
    templates::{Document, Kit, Meta, Template},
};
use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

#[test]
#[ignore = "requires PLUR1BUS_CHROMIUM_BIN, the native acceptance runner supplies it"]
fn renders_pdf_png_and_closes_a_private_chromium_profile() {
    let binary = PathBuf::from(std::env::var_os("PLUR1BUS_CHROMIUM_BIN").unwrap());
    let work = tempfile::tempdir().unwrap();
    let browser = Chromium::new(&binary, work.path());
    let document = Document {
        title: "Synthetic PDF fixture",
        subtitle: "Native Chromium",
        markdown: "## First page\n\nA short paragraph with **emphasis** and Unicode.",
        meta: Meta::default(),
        kit: Kit::default(),
    };
    let fonts = FontDirectory::new(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/documents/assets/fonts"),
    );
    let html = assemble_html(Template::Report, &document, &fonts).unwrap();
    let control = || Control {
        deadline: Instant::now() + Duration::from_secs(30),
        cancelled: &|| false,
    };
    let pdf = browser.print_pdf(&html, control()).unwrap();
    assert!(pdf.starts_with(b"%PDF-"));
    let contains = |word: &[u8]| pdf.windows(word.len()).any(|part| part == word);
    assert!(
        contains(b"Inter") && contains(b"%%EOF") && pdf.len() > 1000,
        "PDF length {}, embedded face {}, font descriptor {}",
        pdf.len(),
        contains(b"Inter"),
        contains(b"/FontFile")
    );
    let png = browser.screenshot_full(&html, control()).unwrap();
    assert!(png.starts_with(b"\x89PNG\r\n\x1a\n"));
    let recorded: serde_json::Value = serde_json::from_str(include_str!(
        "../../../fixtures/parity/documents/checks.json"
    ))
    .unwrap();
    let layout = browser
        .layout_check(recorded["input"]["layoutHtml"].as_str().unwrap(), control())
        .unwrap();
    assert!(layout.is_array());
    assert_eq!(std::fs::read_dir(work.path()).unwrap().count(), 0);
    assert_eq!(
        browser.print_pdf(
            &html,
            Control {
                cancelled: &|| true,
                ..control()
            }
        ),
        Err(Error::Cancelled)
    );
    assert_eq!(std::fs::read_dir(work.path()).unwrap().count(), 0);
}

#[test]
#[ignore = "requires PLUR1BUS_CHROMIUM_BIN and the frozen workspace install"]
fn renders_with_the_shipped_paged_js_asset() {
    let binary = PathBuf::from(std::env::var_os("PLUR1BUS_CHROMIUM_BIN").unwrap());
    let asset = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/documents/node_modules/pagedjs/dist/paged.polyfill.js");
    let work = tempfile::tempdir().unwrap();
    let browser = Chromium::new(&binary, work.path()).with_paged_js(&asset);
    let pdf = browser.print_pdf("<!doctype html><style>@page { size: A4 }</style><p>First page</p><p style=\"break-before:page\">Second page</p>", Control {
        deadline: Instant::now() + Duration::from_secs(30),
        cancelled: &|| false,
    }).unwrap();
    assert!(pdf.starts_with(b"%PDF-"));
    assert_eq!(std::fs::read_dir(work.path()).unwrap().count(), 0);
}
