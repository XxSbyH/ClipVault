use std::{
    fs::File,
    io::{BufRead, BufReader, Read, Write},
    path::Path,
};

use serde::{Deserialize, Serialize};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

use crate::{
    database::repository::Repository,
    errors::{AppError, AppResult},
    models::{
        ClipboardContentType, ClipboardFormatEncoding, ClipboardFormatInput,
        ClipboardFormatPayload, ClipboardInsertInput, ClipboardItem, ClipboardMetadata,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    pub created_at: i64,
    pub last_used_at: Option<i64>,
    pub use_count: i64,
    pub is_pinned: bool,
    pub is_favorite: bool,
    pub metadata: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<ExportFormatRef>,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryImportResult {
    pub inserted: usize,
    pub skipped_duplicates: usize,
    pub merged_state: usize,
    pub skipped_unsupported_formats: usize,
    pub failed: usize,
}

impl ExportHistoryItem {
    fn from_item(
        item: &ClipboardItem,
        export_id: String,
        image: Option<ExportFormatRef>,
        formats: Vec<ExportFormatRef>,
    ) -> AppResult<Self> {
        Ok(Self {
            export_id,
            content: item.content.clone(),
            preview: item.preview.clone(),
            content_type: content_type_to_export(item.content_type).to_string(),
            content_hash: item.content_hash.clone(),
            file_path: item.file_path.clone(),
            created_at: item.created_at,
            last_used_at: item.last_used_at,
            use_count: item.use_count,
            is_pinned: item.is_pinned,
            is_favorite: item.is_favorite,
            metadata: serde_json::to_value(&item.metadata)?,
            image,
            formats,
        })
    }

    fn to_insert_input(&self, image_data: Option<Vec<u8>>) -> AppResult<ClipboardInsertInput> {
        self.validate_for_import()?;
        Ok(ClipboardInsertInput {
            content: self.content.clone(),
            content_type: content_type_from_export(&self.content_type),
            content_hash: self.content_hash.clone(),
            preview: self.preview.clone(),
            metadata: Some(
                serde_json::from_value::<ClipboardMetadata>(self.metadata.clone())
                    .unwrap_or_default(),
            ),
            file_path: self.file_path.clone(),
            image_data,
        })
    }

    fn validate_for_import(&self) -> AppResult<()> {
        if self.content_hash.trim().is_empty() {
            return Err("history import item is missing contentHash".into());
        }
        Ok(())
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
            let item_id = item.id;
            let detail = repo.get_item_by_id(item_id)?.unwrap_or(item);
            let image = write_image_payload(&mut zip, options, &export_id, &detail)?;
            let formats = repo.list_clipboard_formats(item_id)?;
            let refs = write_format_payloads(&mut zip, options, &export_id, &formats)?;
            let export_item = ExportHistoryItem::from_item(&detail, export_id, image, refs)?;
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

pub fn import_history(repo: &Repository, path: &Path) -> AppResult<HistoryImportResult> {
    let file = File::open(path)?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|error| zip_error("failed to open history import package", error))?;
    let manifest = read_manifest(&mut archive)?;
    validate_manifest(&manifest)?;
    let items = read_items_jsonl(&mut archive)?;
    for item in &items {
        item.validate_for_import()?;
    }

    let mut result = HistoryImportResult {
        inserted: 0,
        skipped_duplicates: 0,
        merged_state: 0,
        skipped_unsupported_formats: 0,
        failed: 0,
    };

    for item in items {
        if let Some(existing) = repo.find_by_content_hash(&item.content_hash)? {
            let merged = repo.merge_imported_duplicate_state(
                existing.id,
                item.is_favorite,
                item.is_pinned,
                item.last_used_at,
                item.use_count,
            )?;
            result.skipped_duplicates += 1;
            if merged.is_favorite != existing.is_favorite
                || merged.is_pinned != existing.is_pinned
                || merged.last_used_at != existing.last_used_at
                || merged.use_count != existing.use_count
            {
                result.merged_state += 1;
            }
            if repo.list_clipboard_formats(existing.id)?.is_empty() {
                import_item_formats(repo, &mut archive, existing.id, &item, &mut result)?;
            }
            continue;
        }

        let image_data = match read_image_payload(&mut archive, &item, &mut result)? {
            ImagePayloadRead::None => None,
            ImagePayloadRead::Data(data) => Some(data),
            ImagePayloadRead::FailedRequired => continue,
        };
        let inserted = repo.insert_imported_clipboard_item(
            item.to_insert_input(image_data)?,
            item.created_at,
            item.last_used_at,
            item.use_count,
            item.is_pinned,
            item.is_favorite,
        )?;
        import_item_formats(repo, &mut archive, inserted.id, &item, &mut result)?;
        result.inserted += 1;
    }

    Ok(result)
}

enum ImagePayloadRead {
    None,
    Data(Vec<u8>),
    FailedRequired,
}

fn read_manifest(archive: &mut zip::ZipArchive<File>) -> AppResult<ExportManifest> {
    let file = archive
        .by_name("manifest.json")
        .map_err(|error| zip_error("history import package is missing manifest.json", error))?;
    Ok(serde_json::from_reader(file)?)
}

fn validate_manifest(manifest: &ExportManifest) -> AppResult<()> {
    if manifest.app != "ClipVault" {
        return Err("history import package is not a ClipVault export".into());
    }
    if manifest.export_type != "history" {
        return Err("history import package must have type history".into());
    }
    if manifest.export_version != 1 {
        return Err(format!(
            "unsupported history import version: {}",
            manifest.export_version
        )
        .into());
    }
    Ok(())
}

fn read_items_jsonl(archive: &mut zip::ZipArchive<File>) -> AppResult<Vec<ExportHistoryItem>> {
    let file = archive
        .by_name("items.jsonl")
        .map_err(|error| zip_error("history import package is missing items.jsonl", error))?;
    let reader = BufReader::new(file);
    let mut items = Vec::new();
    for line in reader.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        items.push(serde_json::from_str::<ExportHistoryItem>(&line)?);
    }
    Ok(items)
}

fn import_item_formats(
    repo: &Repository,
    archive: &mut zip::ZipArchive<File>,
    item_id: i64,
    item: &ExportHistoryItem,
    result: &mut HistoryImportResult,
) -> AppResult<()> {
    for format in &item.formats {
        if !crate::clipboard::formats::is_supported_format_name(&format.format_name) {
            result.skipped_unsupported_formats += 1;
            continue;
        }
        if !valid_payload_path(&format.path) {
            result.failed += 1;
            continue;
        }

        let mut file = match archive.by_name(&format.path) {
            Ok(file) => file,
            Err(error) => {
                tracing::warn!(
                    target: "history_export",
                    area = "history_import",
                    direction = "read rich format payload",
                    path = format.path,
                    "skipping missing history import payload: {error}"
                );
                result.failed += 1;
                continue;
            }
        };
        let mut data = Vec::new();
        file.read_to_end(&mut data)?;
        if data.len() != format.byte_len as usize {
            result.failed += 1;
            continue;
        }
        if crate::clipboard::formats::data_hash(&data) != format.hash {
            result.failed += 1;
            continue;
        }

        repo.insert_clipboard_format(
            item_id,
            &ClipboardFormatInput {
                format_name: format.format_name.clone(),
                format_id: None,
                mime_type: format.mime_type.clone(),
                encoding: format_encoding_from_export(&format.encoding),
                data,
                data_hash: format.hash.clone(),
            },
        )?;
    }
    Ok(())
}

fn read_image_payload(
    archive: &mut zip::ZipArchive<File>,
    item: &ExportHistoryItem,
    result: &mut HistoryImportResult,
) -> AppResult<ImagePayloadRead> {
    let Some(image) = &item.image else {
        if item.content_type == "image" {
            result.failed += 1;
            return Ok(ImagePayloadRead::FailedRequired);
        }
        return Ok(ImagePayloadRead::None);
    };
    if !valid_payload_path(&image.path) {
        return Ok(failed_image_payload(item, result));
    }
    let mut file = match archive.by_name(&image.path) {
        Ok(file) => file,
        Err(error) => {
            tracing::warn!(
                target: "history_export",
                area = "history_import",
                direction = "read image payload",
                path = image.path,
                "skipping missing history import image payload: {error}"
            );
            return Ok(failed_image_payload(item, result));
        }
    };
    let mut data = Vec::new();
    file.read_to_end(&mut data)?;
    if data.len() != image.byte_len as usize {
        return Ok(failed_image_payload(item, result));
    }
    if crate::clipboard::formats::data_hash(&data) != image.hash {
        return Ok(failed_image_payload(item, result));
    }
    Ok(ImagePayloadRead::Data(data))
}

fn failed_image_payload(
    item: &ExportHistoryItem,
    result: &mut HistoryImportResult,
) -> ImagePayloadRead {
    result.failed += 1;
    if item.content_type == "image" {
        ImagePayloadRead::FailedRequired
    } else {
        ImagePayloadRead::None
    }
}

fn write_image_payload(
    zip: &mut ZipWriter<File>,
    options: SimpleFileOptions,
    export_id: &str,
    item: &ClipboardItem,
) -> AppResult<Option<ExportFormatRef>> {
    let Some(data) = item.image_data.as_deref() else {
        return Ok(None);
    };
    if data.is_empty() {
        return Ok(None);
    }
    let path = format!("formats/{export_id}-00-image.bin");
    start_zip_file(zip, &path, options)?;
    zip.write_all(data)?;
    let mime_type = item
        .metadata
        .extra
        .get("mimeType")
        .and_then(|value| value.as_str())
        .map(str::to_string);
    Ok(Some(ExportFormatRef {
        format_name: "PNG".to_string(),
        mime_type,
        encoding: "binary".to_string(),
        byte_len: data.len() as i64,
        hash: crate::clipboard::formats::data_hash(data),
        path,
    }))
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

fn content_type_from_export(value: &str) -> ClipboardContentType {
    match value {
        "image" => ClipboardContentType::Image,
        "file" => ClipboardContentType::File,
        "url" => ClipboardContentType::Url,
        "code" => ClipboardContentType::Code,
        "color" => ClipboardContentType::Color,
        "email" => ClipboardContentType::Email,
        _ => ClipboardContentType::Text,
    }
}

fn format_encoding_to_export(encoding: ClipboardFormatEncoding) -> &'static str {
    match encoding {
        ClipboardFormatEncoding::Utf8 => "utf8",
        ClipboardFormatEncoding::Utf16Le => "utf16le",
        ClipboardFormatEncoding::Binary => "binary",
    }
}

fn format_encoding_from_export(value: &str) -> ClipboardFormatEncoding {
    match value {
        "utf8" => ClipboardFormatEncoding::Utf8,
        "utf16le" => ClipboardFormatEncoding::Utf16Le,
        _ => ClipboardFormatEncoding::Binary,
    }
}

fn valid_payload_path(path: &str) -> bool {
    path.starts_with("formats/")
        && !path.contains("..")
        && !path.contains('\\')
        && !path.ends_with('/')
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
    use std::io::{Read, Write};

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
            file_path: None,
            created_at: 1,
            last_used_at: Some(2),
            use_count: 3,
            is_pinned: false,
            is_favorite: true,
            metadata: serde_json::json!({"hasRichFormats": true}),
            image: None,
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

    #[test]
    fn import_rejects_non_history_manifest() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bad.clipvault");
        write_test_zip(
            &path,
            r#"{"app":"ClipVault","type":"settings","exportVersion":1,"createdAt":1,"itemCount":0}"#,
            "",
        );

        let repo = Repository::open(dir.path().join("clipboard.db")).unwrap();
        let error = super::import_history(&repo, &path).unwrap_err().to_string();

        assert!(error.contains("history"));
    }

    #[test]
    fn import_rejects_invalid_items_before_writing_any_history() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("invalid-item.clipvault");
        let valid = serde_json::json!({
            "exportId": "000001",
            "content": "hello",
            "preview": "hello",
            "contentType": "text",
            "contentHash": "hash-valid",
            "createdAt": 10,
            "lastUsedAt": null,
            "useCount": 0,
            "isPinned": false,
            "isFavorite": false,
            "metadata": {},
            "formats": []
        });
        let invalid = serde_json::json!({
            "exportId": "000002",
            "content": "bad",
            "preview": "bad",
            "contentType": "text",
            "contentHash": "",
            "createdAt": 11,
            "lastUsedAt": null,
            "useCount": 0,
            "isPinned": false,
            "isFavorite": false,
            "metadata": {},
            "formats": []
        });
        write_test_zip(
            &path,
            r#"{"app":"ClipVault","type":"history","exportVersion":1,"createdAt":1,"itemCount":2}"#,
            &format!("{valid}\n{invalid}\n"),
        );
        let repo = Repository::open(dir.path().join("clipboard.db")).unwrap();

        let error = super::import_history(&repo, &path).unwrap_err().to_string();

        assert!(error.contains("contentHash"));
        assert_eq!(repo.count_items().unwrap(), 0);
    }

    #[test]
    fn import_history_inserts_items_and_format_payloads() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("history.clipvault");
        let payload = b"<b>hello</b>".as_slice();
        let payload_hash = crate::clipboard::formats::data_hash(payload);
        let item = serde_json::json!({
            "exportId": "000001",
            "content": "hello",
            "preview": "hello",
            "contentType": "text",
            "contentHash": "hash-import",
            "createdAt": 10,
            "lastUsedAt": 20,
            "useCount": 3,
            "isPinned": true,
            "isFavorite": true,
            "metadata": {"hasRichFormats": true},
            "formats": [{
                "formatName": "HTML Format",
                "mimeType": "text/html",
                "encoding": "binary",
                "byteLen": 12,
                "hash": payload_hash,
                "path": "formats/000001-html.bin"
            }]
        });
        write_test_zip_with_payloads(
            &path,
            r#"{"app":"ClipVault","type":"history","exportVersion":1,"createdAt":1,"itemCount":1}"#,
            &format!("{item}\n"),
            &[("formats/000001-html.bin", payload)],
        );
        let repo = Repository::open(dir.path().join("clipboard.db")).unwrap();

        let result = super::import_history(&repo, &path).unwrap();

        assert_eq!(result.inserted, 1);
        let history = repo.get_history(10).unwrap();
        assert_eq!(history.len(), 1);
        assert!(history[0].is_favorite);
        assert!(history[0].is_pinned);
        assert_eq!(history[0].last_used_at, Some(20));
        assert_eq!(history[0].use_count, 3);

        let formats = repo.list_clipboard_formats(history[0].id).unwrap();
        assert_eq!(formats.len(), 1);
        assert_eq!(formats[0].data, b"<b>hello</b>");
    }

    #[test]
    fn import_skips_image_item_when_image_payload_is_corrupt() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bad-image.clipvault");
        let item = serde_json::json!({
            "exportId": "000001",
            "content": null,
            "preview": "Image",
            "contentType": "image",
            "contentHash": "hash-image",
            "createdAt": 10,
            "lastUsedAt": null,
            "useCount": 0,
            "isPinned": false,
            "isFavorite": false,
            "metadata": {},
            "image": {
                "formatName": "PNG",
                "mimeType": "image/png",
                "encoding": "binary",
                "byteLen": 3,
                "hash": "wrong-hash",
                "path": "formats/000001-image.bin"
            },
            "formats": []
        });
        write_test_zip_with_payloads(
            &path,
            r#"{"app":"ClipVault","type":"history","exportVersion":1,"createdAt":1,"itemCount":1}"#,
            &format!("{item}\n"),
            &[("formats/000001-image.bin", &[1, 2, 3])],
        );
        let repo = Repository::open(dir.path().join("clipboard.db")).unwrap();

        let result = super::import_history(&repo, &path).unwrap();

        assert_eq!(result.inserted, 0);
        assert_eq!(result.failed, 1);
        assert_eq!(repo.count_items().unwrap(), 0);
    }

    fn write_test_zip(path: &std::path::Path, manifest: &str, items: &str) {
        write_test_zip_with_payloads(path, manifest, items, &[]);
    }

    fn write_test_zip_with_payloads(
        path: &std::path::Path,
        manifest: &str,
        items: &str,
        payloads: &[(&str, &[u8])],
    ) {
        let file = std::fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        zip.start_file("manifest.json", options).unwrap();
        zip.write_all(manifest.as_bytes()).unwrap();
        zip.start_file("items.jsonl", options).unwrap();
        zip.write_all(items.as_bytes()).unwrap();
        for (path, data) in payloads {
            zip.start_file(path, options).unwrap();
            zip.write_all(data).unwrap();
        }
        zip.finish().unwrap();
    }
}
