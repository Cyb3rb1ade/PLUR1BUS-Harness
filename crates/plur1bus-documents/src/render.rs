//! Assemble a self-contained document using the shipped fonts.

use std::{
    fmt::Write as _,
    fs::File,
    io::{self, Read as _},
    path::PathBuf,
};

use base64::{engine::general_purpose::STANDARD, Engine as _};

use crate::templates::{self, Document, Template};

const MAX_FONT_BYTES: usize = 4 * 1024 * 1024;
const FAMILIES: [(Font, &str, &str); 3] = [
    (Font::Inter, "Inter", "100 900"),
    (Font::SourceSerif, "Source Serif 4", "200 900"),
    (Font::JetBrainsMono, "JetBrains Mono", "100 800"),
];

#[derive(Clone, Copy)]
pub enum Font {
    Inter,
    SourceSerif,
    JetBrainsMono,
}

impl Font {
    pub const fn filename(self) -> &'static str {
        match self {
            Self::Inter => "Inter.ttf",
            Self::SourceSerif => "SourceSerif4.ttf",
            Self::JetBrainsMono => "JetBrainsMono.ttf",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    FontUnavailable,
    TooLarge,
}

pub trait FontAssets {
    /// Read a shipped font to the supplied bound. An absent font selects the
    /// template's local system fallback.
    fn read_face(&self, font: Font, limit: usize) -> Result<Option<Vec<u8>>, Error>;
}

pub struct FontDirectory {
    root: PathBuf,
}

impl FontDirectory {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }
}

impl FontAssets for FontDirectory {
    fn read_face(&self, font: Font, limit: usize) -> Result<Option<Vec<u8>>, Error> {
        let path = self.root.join(font.filename());
        let metadata = match path.metadata() {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(Error::FontUnavailable),
        };
        if !metadata.is_file() {
            return Err(Error::FontUnavailable);
        }
        if metadata.len() > limit as u64 {
            return Err(Error::TooLarge);
        }
        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        File::open(path)
            .and_then(|file| {
                file.take((limit as u64).saturating_add(1))
                    .read_to_end(&mut bytes)
            })
            .map_err(|_| Error::FontUnavailable)?;
        if bytes.len() > limit {
            return Err(Error::TooLarge);
        }
        Ok(Some(bytes))
    }
}

pub fn assemble_html(
    template: Template,
    document: &Document<'_>,
    assets: &impl FontAssets,
) -> Result<String, Error> {
    let mut html = templates::assemble(template, document);
    let mut styles = String::from("\n");
    for (font, family, weight) in FAMILIES {
        let Some(bytes) = assets.read_face(font, MAX_FONT_BYTES)? else {
            continue;
        };
        if bytes.len() > MAX_FONT_BYTES {
            return Err(Error::TooLarge);
        }
        if styles.len() > 1 {
            styles.push('\n');
        }
        write!(styles, "@font-face {{ font-family: \"{family}\"; font-style: normal; font-weight: {weight}; src: url(data:font/ttf;base64,")
            .map_err(|_| Error::FontUnavailable)?;
        STANDARD.encode_string(bytes, &mut styles);
        styles.push_str(") format(\"truetype\"); font-display: block; }");
    }
    if let Some(start) = html.find("<style>") {
        styles.push('\n');
        html.insert_str(start + "<style>".len(), &styles);
    }
    Ok(html)
}
