use crate::{
    errors::AppResult,
    models::{ClipboardFormatEncoding, ClipboardFormatInput, ClipboardFormatPayload},
};

pub const FORMAT_CF_UNICODETEXT: &str = "CF_UNICODETEXT";
pub const FORMAT_CF_TEXT: &str = "CF_TEXT";
pub const FORMAT_HTML: &str = "HTML Format";
pub const FORMAT_RTF: &str = "Rich Text Format";
pub const FORMAT_PNG: &str = "PNG";
pub const FORMAT_DIB: &str = "CF_DIB";
pub const FORMAT_HDROP: &str = "CF_HDROP";

const CF_TEXT_ID: u32 = 1;
const CF_DIB_ID: u32 = 8;
const CF_HDROP_ID: u32 = 15;
const CF_UNICODETEXT_ID: u32 = 13;
const MAX_FORMAT_BYTES: usize = 8 * 1024 * 1024;
const MAX_TOTAL_FORMAT_BYTES: usize = 24 * 1024 * 1024;

pub fn normalize_format_name(name: &str) -> &'static str {
    match name.trim().to_ascii_lowercase().as_str() {
        "cf_unicodetext" => FORMAT_CF_UNICODETEXT,
        "cf_text" => FORMAT_CF_TEXT,
        "html format" => FORMAT_HTML,
        "rich text format" => FORMAT_RTF,
        "png" => FORMAT_PNG,
        "cf_dib" => FORMAT_DIB,
        "cf_hdrop" => FORMAT_HDROP,
        _ => "",
    }
}

pub fn is_supported_format_name(name: &str) -> bool {
    !normalize_format_name(name).is_empty()
}

pub fn mime_type_for_format(name: &str) -> Option<&'static str> {
    match normalize_format_name(name) {
        FORMAT_HTML => Some("text/html"),
        FORMAT_RTF => Some("text/rtf"),
        FORMAT_PNG => Some("image/png"),
        FORMAT_DIB => Some("image/bmp"),
        FORMAT_HDROP => Some("application/x-cf-hdrop"),
        FORMAT_CF_UNICODETEXT | FORMAT_CF_TEXT => Some("text/plain"),
        _ => None,
    }
}

pub fn supported_format_priority(name: &str) -> u8 {
    match normalize_format_name(name) {
        FORMAT_HTML => 10,
        FORMAT_RTF => 20,
        FORMAT_CF_UNICODETEXT => 30,
        FORMAT_CF_TEXT => 40,
        FORMAT_PNG => 50,
        FORMAT_DIB => 60,
        FORMAT_HDROP => 70,
        _ => u8::MAX,
    }
}

pub fn data_hash(data: &[u8]) -> String {
    format!("{:x}", md5::compute(data))
}

fn should_store_payload_format(name: &str) -> bool {
    matches!(
        normalize_format_name(name),
        FORMAT_HTML | FORMAT_RTF | FORMAT_PNG | FORMAT_DIB | FORMAT_HDROP
    )
}

#[cfg(target_os = "windows")]
pub fn read_supported_formats() -> AppResult<Vec<ClipboardFormatInput>> {
    windows_clipboard::read_supported_formats()
}

#[cfg(not(target_os = "windows"))]
pub fn read_supported_formats() -> AppResult<Vec<ClipboardFormatInput>> {
    Ok(Vec::new())
}

#[cfg(target_os = "windows")]
pub fn write_supported_formats(
    formats: &[ClipboardFormatPayload],
    plain_text: Option<&str>,
) -> AppResult<bool> {
    windows_clipboard::write_supported_formats(formats, plain_text)
}

#[cfg(not(target_os = "windows"))]
pub fn write_supported_formats(
    _formats: &[ClipboardFormatPayload],
    _plain_text: Option<&str>,
) -> AppResult<bool> {
    Ok(false)
}

#[cfg(target_os = "windows")]
mod windows_clipboard {
    use std::{mem, ptr, slice};

    use windows::{
        core::{Error as WindowsError, HSTRING},
        Win32::{
            Foundation::{GlobalFree, HANDLE, HGLOBAL, HWND},
            System::{
                DataExchange::{
                    CloseClipboard, EmptyClipboard, EnumClipboardFormats, GetClipboardData,
                    GetClipboardFormatNameW, OpenClipboard, RegisterClipboardFormatW,
                    SetClipboardData,
                },
                Memory::{
                    GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE, GMEM_ZEROINIT,
                },
            },
        },
    };

    use super::*;

    struct ClipboardGuard;

    impl ClipboardGuard {
        fn open() -> AppResult<Self> {
            unsafe { OpenClipboard(HWND(ptr::null_mut())) }
                .map_err(|error| windows_error("failed to open Windows clipboard", error))?;
            Ok(Self)
        }
    }

    impl Drop for ClipboardGuard {
        fn drop(&mut self) {
            let _ = unsafe { CloseClipboard() };
        }
    }

    pub fn read_supported_formats() -> AppResult<Vec<ClipboardFormatInput>> {
        let _guard = ClipboardGuard::open()?;
        let mut result = Vec::new();
        let mut total_bytes = 0usize;
        let mut current = 0u32;

        loop {
            current = unsafe { EnumClipboardFormats(current) };
            if current == 0 {
                break;
            }

            let Some(name) = format_name_from_id(current) else {
                continue;
            };
            if !should_store_payload_format(name) {
                continue;
            }

            let data = match read_global_data(current) {
                Ok(data) => data,
                Err(error) => {
                    tracing::warn!(
                        target: "clipboard",
                        area = "clipboard",
                        direction = "read supported rich clipboard format",
                        format_name = name,
                        "skipping clipboard format: {error}"
                    );
                    continue;
                }
            };
            if data.is_empty() || data.len() > MAX_FORMAT_BYTES {
                continue;
            }
            if total_bytes.saturating_add(data.len()) > MAX_TOTAL_FORMAT_BYTES {
                break;
            }
            total_bytes += data.len();

            result.push(ClipboardFormatInput {
                format_name: name.to_string(),
                format_id: Some(current),
                mime_type: mime_type_for_format(name).map(str::to_string),
                encoding: ClipboardFormatEncoding::Binary,
                data_hash: data_hash(&data),
                data,
            });
        }

        result.sort_by_key(|format| supported_format_priority(&format.format_name));
        Ok(result)
    }

    pub fn write_supported_formats(
        formats: &[ClipboardFormatPayload],
        plain_text: Option<&str>,
    ) -> AppResult<bool> {
        let _guard = ClipboardGuard::open()?;
        unsafe { EmptyClipboard() }
            .map_err(|error| windows_error("failed to empty Windows clipboard", error))?;

        let mut wrote = false;
        let mut sorted = formats.to_vec();
        sorted.sort_by_key(|format| supported_format_priority(&format.format_name));

        for format in &sorted {
            let name = normalize_format_name(&format.format_name);
            if !should_store_payload_format(name) {
                continue;
            }
            let Some(format_id) = format_id_for_name(name) else {
                continue;
            };
            if format.data.is_empty() || format.data.len() > MAX_FORMAT_BYTES {
                continue;
            }
            if set_clipboard_bytes(format_id, &format.data).is_ok() {
                wrote = true;
            }
        }

        if let Some(text) = plain_text.filter(|text| !text.is_empty()) {
            let unicode = encode_windows_unicode_text(text);
            if set_clipboard_bytes(CF_UNICODETEXT_ID, &unicode).is_ok() {
                wrote = true;
            }
            let text_bytes = encode_windows_ansi_text(text);
            let _ = set_clipboard_bytes(CF_TEXT_ID, &text_bytes);
        }

        Ok(wrote)
    }

    fn read_global_data(format_id: u32) -> AppResult<Vec<u8>> {
        let handle = unsafe { GetClipboardData(format_id) }
            .map_err(|error| windows_error("failed to get Windows clipboard data", error))?;
        let hglobal = HGLOBAL(handle.0);
        let size = unsafe { GlobalSize(hglobal) };
        if size == 0 || size > MAX_FORMAT_BYTES {
            return Ok(Vec::new());
        }

        let ptr = unsafe { GlobalLock(hglobal) };
        if ptr.is_null() {
            return Err("failed to lock clipboard global memory".into());
        }

        let data = unsafe { slice::from_raw_parts(ptr.cast::<u8>(), size).to_vec() };
        let _ = unsafe { GlobalUnlock(hglobal) };
        Ok(data)
    }

    fn set_clipboard_bytes(format_id: u32, data: &[u8]) -> AppResult<()> {
        if data.is_empty() {
            return Ok(());
        }

        let hglobal = unsafe { GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, data.len()) }
            .map_err(|error| windows_error("failed to allocate Windows clipboard memory", error))?;
        let ptr = unsafe { GlobalLock(hglobal) };
        if ptr.is_null() {
            let _ = unsafe { GlobalFree(hglobal) };
            return Err("failed to lock allocated clipboard global memory".into());
        }

        unsafe {
            ptr::copy_nonoverlapping(data.as_ptr(), ptr.cast::<u8>(), data.len());
        }
        let _ = unsafe { GlobalUnlock(hglobal) };

        match unsafe { SetClipboardData(format_id, HANDLE(hglobal.0)) } {
            Ok(_) => Ok(()),
            Err(error) => {
                let _ = unsafe { GlobalFree(hglobal) };
                Err(windows_error("failed to set Windows clipboard data", error))
            }
        }
    }

    fn format_id_for_name(name: &str) -> Option<u32> {
        match normalize_format_name(name) {
            FORMAT_CF_UNICODETEXT => Some(CF_UNICODETEXT_ID),
            FORMAT_CF_TEXT => Some(CF_TEXT_ID),
            FORMAT_DIB => Some(CF_DIB_ID),
            FORMAT_HDROP => Some(CF_HDROP_ID),
            FORMAT_HTML | FORMAT_RTF | FORMAT_PNG => {
                let wide = HSTRING::from(name);
                let id = unsafe { RegisterClipboardFormatW(&wide) };
                (id != 0).then_some(id)
            }
            _ => None,
        }
    }

    fn format_name_from_id(format_id: u32) -> Option<&'static str> {
        match format_id {
            CF_UNICODETEXT_ID => Some(FORMAT_CF_UNICODETEXT),
            CF_TEXT_ID => Some(FORMAT_CF_TEXT),
            CF_DIB_ID => Some(FORMAT_DIB),
            CF_HDROP_ID => Some(FORMAT_HDROP),
            _ => custom_format_name(format_id),
        }
    }

    fn custom_format_name(format_id: u32) -> Option<&'static str> {
        let mut buffer = [0u16; 128];
        let len = unsafe { GetClipboardFormatNameW(format_id, &mut buffer) };
        if len <= 0 {
            return None;
        }
        let name = String::from_utf16_lossy(&buffer[..len as usize]);
        match normalize_format_name(&name) {
            "" => None,
            normalized => Some(normalized),
        }
    }

    fn encode_windows_unicode_text(text: &str) -> Vec<u8> {
        text.encode_utf16()
            .chain(std::iter::once(0))
            .flat_map(u16::to_le_bytes)
            .collect()
    }

    fn encode_windows_ansi_text(text: &str) -> Vec<u8> {
        let mut bytes = text
            .chars()
            .map(|ch| if ch.is_ascii() { ch as u8 } else { b'?' })
            .collect::<Vec<_>>();
        bytes.push(0);
        bytes
    }

    fn windows_error(context: &str, error: WindowsError) -> crate::errors::AppError {
        format!("{context}: {error}").into()
    }

    #[allow(dead_code)]
    fn _dropfiles_header_size() -> usize {
        mem::size_of::<windows::Win32::UI::Shell::DROPFILES>()
    }
}

#[cfg(test)]
mod tests {
    use super::{
        is_supported_format_name, mime_type_for_format, normalize_format_name,
        supported_format_priority,
    };

    #[test]
    fn supports_only_mainstream_formats() {
        for name in [
            "CF_UNICODETEXT",
            "CF_TEXT",
            "HTML Format",
            "Rich Text Format",
            "PNG",
            "CF_DIB",
            "CF_HDROP",
        ] {
            assert!(is_supported_format_name(name), "{name}");
        }
        assert!(!is_supported_format_name(
            "Chrome Web Custom MIME Data Format"
        ));
    }

    #[test]
    fn normalizes_common_format_names() {
        assert_eq!(normalize_format_name("html format"), "HTML Format");
        assert_eq!(
            normalize_format_name("Rich Text Format"),
            "Rich Text Format"
        );
        assert_eq!(normalize_format_name("png"), "PNG");
    }

    #[test]
    fn assigns_mime_types_and_priorities() {
        assert_eq!(mime_type_for_format("HTML Format"), Some("text/html"));
        assert_eq!(mime_type_for_format("Rich Text Format"), Some("text/rtf"));
        assert_eq!(mime_type_for_format("PNG"), Some("image/png"));
        assert!(supported_format_priority("HTML Format") < supported_format_priority("CF_TEXT"));
    }
}
