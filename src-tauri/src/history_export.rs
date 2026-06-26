use std::{fs::File, io::Write, path::Path};

use serde::{Deserialize, Serialize};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

use crate::{
    database::repository::Repository,
    errors::{AppError, AppResult},
    models::{
        ClipboardContentType, ClipboardFormatEncoding, ClipboardFormatPayload, ClipboardItem,
    },
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExportManifest {
    pub app: String,
    #[serde(rename = "type")]
    pub export_type: String,
    pub export_version: u32,
    pub created_at: i64,
    pub item_count: usize,
}

impl ExportManifest {
    pub fn new(item_count: usize) -> Self {
        Self {
            app: "ClipVault".to_string(),
            export_type: "history".to_string(),
            export_version: 1,
            created_at: now_millis(),
            item_count,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExportHistoryItem {
    pub export_id: String,
    pub content: Option<String>,
    pub preview: String,
    pub content_type: String,
    pub content_hash: String,
    pub created_at: i64,
    pub last_used_at: Option<i64>,
    pub use_count: i64,
    pub is_pinned: bool,
    pub is_favorite: bool,
    pub metadata: serde_json::Value,
    pub formats: Vec<ExportFormatRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExportFormatRef {
    pub format_name: String,
    pub mime_type: Option<String>,
    pub encoding: String,
    pub byte_len: i64,
    pub hash: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryExportResult {
    pub exported: usize,
    pub path: String,
}

impl ExportHistoryItem {
    fn from_item(
        item: &ClipboardItem,
        export_id: String,
        formats: Vec<ExportFormatRef>,
    ) -> AppResult<Self> {
        Ok(Self {
            export_id,
            content: item.content.clone(),
            preview: item.preview.clone(),
            content_type: content_type_to_export(item.content_type).to_string(),
            content_hash: item.content_hash.clone(),
            created_at: item.created_at,
            last_used_at: item.last_used_at,
            use_count: item.use_count,
            is_pinned: item.is_pinned,
            is_favorite: item.is_favorite,
            metadata: serde_json::to_value(&item.metadata)?,
            formats,
        })
    }
}

pub fn export_history(repo: &Repository, path: &Path) -> AppResult<HistoryExportResult> {
    let file = File::create(path)?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    let item_count = usize::try_from(repo.count_items()?).unwrap_or_default();
    let manifest = ExportManifest::new(item_count);
    let mut item_lines = Vec::with_capacity(item_count);
    let mut exported = 0usize;
    let mut offset = 0i64;
    const PAGE_SIZE: i64 = 500;

    start_zip_file(&mut zip, "manifest.json", options)?;
    serde_json::to_writer(&mut zip, &manifest)?;

    loop {
        let items = repo.get_history_page(PAGE_SIZE, offset)?;
        if items.is_empty() {
            break;
        }
        offset += items.len() as i64;

        for item in items {
            exported += 1;
            let export_id = format!("{exported:06}");
            let formats = repo.list_clipboard_formats(item.id)?;
            let refs = write_format_payloads(&mut zip, options, &export_id, &formats)?;
            let export_item = ExportHistoryItem::from_item(&item, export_id, refs)?;
            item_lines.push(serde_json::to_string(&export_item)?);
        }
    }

    start_zip_file(&mut zip, "items.jsonl", options)?;
    for line in item_lines {
        zip.write_all(line.as_bytes())?;
        zip.write_all(b"\n")?;
    }

    zip.finish()
        .map_err(|error| zip_error("failed to finish history export package", error))?;
    Ok(HistoryExportResult {
        exported,
        path: path.display().to_string(),
    })
}

fn write_format_payloads(
    zip: &mut ZipWriter<File>,
    options: SimpleFileOptions,
    export_id: &str,
    formats: &[ClipboardFormatPayload],
) -> AppResult<Vec<ExportFormatRef>> {
    let mut refs = Vec::with_capacity(formats.len());
    for (index, format) in formats.iter().enumerate() {
        if format.data.is_empty() {
            continue;
        }
        let path = format!(
            "formats/{export_id}-{:02}-{}.bin",
            index + 1,
            format_slug(&format.format_name)
        );
        start_zip_file(zip, &path, options)?;
        zip.write_all(&format.data)?;
        refs.push(ExportFormatRef {
            format_name: format.format_name.clone(),
            mime_type: format.mime_type.clone(),
            encoding: format_encoding_to_export(format.encoding).to_string(),
            byte_len: format.byte_len,
            hash: format.data_hash.clone(),
            path,
        });
    }
    Ok(refs)
}

fn start_zip_file(
    zip: &mut ZipWriter<File>,
    path: &str,
    options: SimpleFileOptions,
) -> AppResult<()> {
    zip.start_file(path, options)
        .map_err(|error| zip_error("failed to write history export package entry", error))
}

fn content_type_to_export(content_type: ClipboardContentType) -> &'static str {
    match content_type {
        ClipboardContentType::Text => "text",
        ClipboardContentType::Image => "image",
        ClipboardContentType::File => "file",
        ClipboardContentType::Url => "url",
        ClipboardContentType::Code => "code",
        ClipboardContentType::Color => "color",
        ClipboardContentType::Email => "email",
    }
}

fn format_encoding_to_export(encoding: ClipboardFormatEncoding) -> &'static str {
    match encoding {
        ClipboardFormatEncoding::Utf8 => "utf8",
        ClipboardFormatEncoding::Utf16Le => "utf16le",
        ClipboardFormatEncoding::Binary => "binary",
    }
}

fn format_slug(format_name: &str) -> String {
    let mut slug = String::new();
    let mut last_dash = false;
    for ch in format_name.chars().flat_map(char::to_lowercase) {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch);
            last_dash = false;
        } else if !last_dash && !slug.is_empty() {
            slug.push('-');
            last_dash = true;
        }
    }
    if slug.ends_with('-') {
        slug.pop();
    }
    if slug.is_empty() {
        "format".to_string()
    } else {
        slug
    }
}

fn zip_error(context: &str, error: zip::result::ZipError) -> AppError {
    AppError::from(format!("{context}: {error}"))
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use std::io::Read;

    use serde_json::Value;

    use crate::{
        database::repository::Repository,
        models::{
            ClipboardContentType, ClipboardFormatEncoding, ClipboardFormatInput,
            ClipboardInsertInput,
        },
    };

    use super::{ExportFormatRef, ExportHistoryItem, ExportManifest};

    #[test]
    fn manifest_identifies_history_only_export() {
        let manifest = ExportManifest::new(2);
        let value = serde_json::to_value(manifest).unwrap();

        assert_eq!(value["app"], "ClipVault");
        assert_eq!(value["type"], "history");
        assert_eq!(value["exportVersion"], 1);
        assert_eq!(value["itemCount"], 2);
    }

    #[test]
    fn item_jsonl_references_external_format_payloads() {
        let item = ExportHistoryItem {
            export_id: "000001".to_string(),
            content: Some("hello".to_string()),
            preview: "hello".to_string(),
            content_type: "text".to_string(),
            content_hash: "hash".to_string(),
            created_at: 1,
            last_used_at: Some(2),
            use_count: 3,
            is_pinned: false,
            is_favorite: true,
            metadata: serde_json::json!({"hasRichFormats": true}),
            formats: vec![ExportFormatRef {
                format_name: "HTML Format".to_string(),
                mime_type: Some("text/html".to_string()),
                encoding: "binary".to_string(),
                byte_len: 5,
                hash: "format-hash".to_string(),
                path: "formats/000001-html.bin".to_string(),
            }],
        };

        let line = serde_json::to_string(&item).unwrap();
        let value: Value = serde_json::from_str(&line).unwrap();

        assert_eq!(value["formats"][0]["path"], "formats/000001-html.bin");
        assert!(line.ends_with('}'));
    }

    #[test]
    fn export_history_writes_manifest_items_and_format_payloads() {
        let dir = tempfile::tempdir().unwrap();
        let repo = Repository::open(dir.path().join("clipboard.db")).unwrap();
        let item = repo
            .insert_clipboard_item(ClipboardInsertInput {
                content: Some("hello".to_string()),
                content_type: ClipboardContentType::Text,
                content_hash: "hash-hello".to_string(),
                preview: "hello".to_string(),
                metadata: None,
                file_path: None,
                image_data: None,
            })
            .unwrap();
        repo.insert_clipboard_format(
            item.id,
            &ClipboardFormatInput {
                format_name: "HTML Format".to_string(),
                format_id: Some(49323),
                mime_type: Some("text/html".to_string()),
                encoding: ClipboardFormatEncoding::Binary,
                data: b"<b>hello</b>".to_vec(),
                data_hash: "format-hash".to_string(),
            },
        )
        .unwrap();
        let export_path = dir.path().join("history.clipvault");

        let result = super::export_history(&repo, &export_path).unwrap();

        assert_eq!(result.exported, 1);
        let file = std::fs::File::open(export_path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let manifest: ExportManifest =
            serde_json::from_reader(archive.by_name("manifest.json").unwrap()).unwrap();
        assert_eq!(manifest.item_count, 1);

        let mut items = String::new();
        archive
            .by_name("items.jsonl")
            .unwrap()
            .read_to_string(&mut items)
            .unwrap();
        let line: Value = serde_json::from_str(items.lines().next().unwrap()).unwrap();
        let format_path = line["formats"][0]["path"].as_str().unwrap();
        assert!(format_path.starts_with("formats/000001-"));

        let mut payload = Vec::new();
        archive
            .by_name(format_path)
            .unwrap()
            .read_to_end(&mut payload)
            .unwrap();
        assert_eq!(payload, b"<b>hello</b>");
    }
}
