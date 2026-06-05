use std::path::PathBuf;
use std::sync::OnceLock;

use crate::models::ClipboardContentType;
use regex::Regex;

pub fn detect_content_type(text: &str) -> ClipboardContentType {
    let trimmed = text.trim();

    if trimmed.is_empty() {
        return ClipboardContentType::Text;
    }

    if is_url_text(trimmed) {
        return ClipboardContentType::Url;
    }

    if color_regex().is_match(trimmed) {
        return ClipboardContentType::Color;
    }

    if email_regex().is_match(trimmed) {
        return ClipboardContentType::Email;
    }

    if is_file_path_text(trimmed) {
        return ClipboardContentType::File;
    }

    if code_regex().is_match(trimmed) {
        return ClipboardContentType::Code;
    }

    ClipboardContentType::Text
}

pub fn create_preview(content: &str, max_len: usize) -> String {
    if max_len == 0 {
        return String::new();
    }

    let compact = content.split_whitespace().collect::<Vec<_>>().join(" ");
    let compact_len = compact.chars().count();

    if compact_len <= max_len {
        return compact;
    }

    if max_len <= 3 {
        return ".".repeat(max_len);
    }

    let prefix: String = compact.chars().take(max_len - 3).collect();
    format!("{prefix}...")
}

pub fn is_file_path_text(content: &str) -> bool {
    parse_single_file_path(content).is_some()
}

pub fn parse_single_file_path(content: &str) -> Option<PathBuf> {
    let trimmed = content.trim();

    if trimmed.is_empty() || trimmed.lines().count() != 1 || trimmed.contains('\0') {
        return None;
    }

    let path = strip_matching_quotes(trimmed).trim();

    if path.is_empty() || path.chars().any(|ch| ch.is_control()) {
        return None;
    }

    if looks_like_windows_absolute_path(path)
        || looks_like_unc_path(path)
        || looks_like_posix_path(path)
    {
        Some(PathBuf::from(path))
    } else {
        None
    }
}

fn is_url_text(text: &str) -> bool {
    let rest = text
        .strip_prefix("https://")
        .or_else(|| text.strip_prefix("http://"));
    let Some(rest) = rest else {
        return false;
    };

    if rest.is_empty() || rest.chars().any(char::is_whitespace) {
        return false;
    }

    let host = rest.split(['/', '?', '#']).next().unwrap_or_default();
    !host.is_empty()
}

fn strip_matching_quotes(input: &str) -> &str {
    let bytes = input.as_bytes();

    if bytes.len() >= 2
        && ((bytes[0] == b'"' && bytes[bytes.len() - 1] == b'"')
            || (bytes[0] == b'\'' && bytes[bytes.len() - 1] == b'\''))
    {
        &input[1..input.len() - 1]
    } else {
        input
    }
}

fn looks_like_windows_absolute_path(path: &str) -> bool {
    let bytes = path.as_bytes();

    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
}

fn looks_like_unc_path(path: &str) -> bool {
    let Some(rest) = path.strip_prefix(r"\\") else {
        return false;
    };

    let mut segments = rest
        .split(['\\', '/'])
        .filter(|segment| !segment.is_empty());
    segments.next().is_some() && segments.next().is_some()
}

fn looks_like_posix_path(path: &str) -> bool {
    path.starts_with('/') && path.len() > 1
}

fn color_regex() -> &'static Regex {
    static COLOR_REGEX: OnceLock<Regex> = OnceLock::new();
    COLOR_REGEX.get_or_init(|| Regex::new(r"^#[0-9A-Fa-f]{6}$").expect("valid color regex"))
}

fn email_regex() -> &'static Regex {
    static EMAIL_REGEX: OnceLock<Regex> = OnceLock::new();
    EMAIL_REGEX.get_or_init(|| {
        Regex::new(r"(?i)^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$").expect("valid email regex")
    })
}

fn code_regex() -> &'static Regex {
    static CODE_REGEX: OnceLock<Regex> = OnceLock::new();
    CODE_REGEX.get_or_init(|| {
        Regex::new(
            r#"(?m)\b(import\s+.+\s+from\s+['"][^'"]+['"];?|function\s+\w+\s*\(|const\s+\w+\s*=|let\s+\w+\s*=|class\s+\w+|<[a-zA-Z][^>]*>)"#,
        )
        .expect("valid code regex")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_url_content() {
        assert_eq!(
            detect_content_type("https://github.com/xxsby/ClipVault"),
            ClipboardContentType::Url
        );
    }

    #[test]
    fn detects_color_content() {
        assert_eq!(detect_content_type("#0D9488"), ClipboardContentType::Color);
    }

    #[test]
    fn detects_email_content() {
        assert_eq!(
            detect_content_type("xxsby@example.com"),
            ClipboardContentType::Email
        );
    }

    #[test]
    fn detects_file_path_content() {
        let path = r"D:\phpstudy_pro\WWW\HistoClip\README.md";

        assert!(is_file_path_text(path));
        assert_eq!(detect_content_type(path), ClipboardContentType::File);
        assert_eq!(parse_single_file_path(path), Some(PathBuf::from(path)));
    }

    #[test]
    fn detects_code_content() {
        assert_eq!(
            detect_content_type("import React from 'react'"),
            ClipboardContentType::Code
        );
    }

    #[test]
    fn detects_ordinary_text_content() {
        assert_eq!(
            detect_content_type("just a normal clipboard sentence"),
            ClipboardContentType::Text
        );
    }

    #[test]
    fn creates_preview_with_collapsed_whitespace_and_ascii_ellipsis() {
        let content = format!("{}\n\t{}", "a".repeat(150), "b".repeat(100));
        let preview = create_preview(&content, 200);

        assert_eq!(preview.chars().count(), 200);
        assert!(preview.ends_with("..."));
        assert!(!preview.contains('\n'));
        assert!(!preview.contains('\t'));
    }
}
