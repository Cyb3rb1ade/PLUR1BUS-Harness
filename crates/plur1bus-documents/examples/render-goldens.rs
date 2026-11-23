//! Native acceptance driver for the TypeScript golden samples.

use plur1bus_documents::{
    browser::Chromium,
    chromium::Control,
    render::{assemble_html, FontDirectory},
    templates::{Document, Kit, LineItem, Meta, Template},
};
use serde::Deserialize;
use std::{
    env, fs,
    io::{self, Read},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

#[derive(Deserialize)]
struct Sample {
    template: String,
    title: String,
    subtitle: String,
    content: String,
    meta: Metadata,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Metadata {
    title: Option<String>,
    author: String,
    date: String,
    from: String,
    to: String,
    subject: String,
    salutation: String,
    closing: String,
    role: String,
    total: String,
    line_items: Vec<Item>,
}

#[derive(Deserialize)]
struct Item {
    label: String,
    amount: String,
}

const MAX_REQUESTS: u64 = 65536;

fn main() -> io::Result<()> {
    let paths: Vec<_> = env::args_os().skip(1).map(PathBuf::from).collect();
    let [binary, fonts, output] = paths.as_slice() else {
        return Err(io::Error::other("expected browser, fonts and output paths"));
    };
    let mut data = Vec::new();
    io::stdin().take(MAX_REQUESTS + 1).read_to_end(&mut data)?;
    if data.len() as u64 > MAX_REQUESTS {
        return Err(io::Error::other("golden requests exceed 64 KiB"));
    }
    let samples: Vec<Sample> = serde_json::from_slice(&data)?;
    let browser = Chromium::new(binary, output);
    let fonts = FontDirectory::new(fonts.clone());
    for sample in &samples {
        render(sample, &browser, &fonts, output)?;
    }
    Ok(())
}

fn render(
    sample: &Sample,
    browser: &Chromium<'_>,
    fonts: &FontDirectory,
    output: &Path,
) -> io::Result<()> {
    let template = sample
        .template
        .parse::<Template>()
        .map_err(|e| io::Error::other(format!("{e:?}")))?;
    let fields = &sample.meta;
    let lines: Vec<_> = fields
        .line_items
        .iter()
        .map(|item| LineItem {
            label: &item.label,
            amount: &item.amount,
        })
        .collect();
    let html = assemble_html(
        template,
        &Document {
            title: &sample.title,
            subtitle: &sample.subtitle,
            markdown: &sample.content,
            kit: Kit::default(),
            meta: Meta {
                title: fields.title.as_deref(),
                author: &fields.author,
                date: &fields.date,
                from: &fields.from,
                to: &fields.to,
                subject: &fields.subject,
                salutation: &fields.salutation,
                closing: &fields.closing,
                role: &fields.role,
                total: &fields.total,
                line_items: &lines,
            },
        },
        fonts,
    )
    .map_err(|e| io::Error::other(format!("{} HTML {e:?}", sample.template)))?;
    let rendered = browser
        .render(
            &html,
            Control {
                deadline: Instant::now() + Duration::from_secs(30),
                cancelled: &|| false,
            },
        )
        .map_err(|e| io::Error::other(format!("{} Chromium {e:?}", sample.template)))?;
    fs::write(
        output.join(format!("{}.pdf", sample.template)),
        rendered.pdf,
    )?;
    fs::write(
        output.join(format!("{}.png", sample.template)),
        rendered.screenshot,
    )
}
