use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ClipboardContentType {
    #[default]
    Text,
    Image,
    File,
    Url,
    Code,
    Color,
    Email,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardMetadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color_hex: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_ext: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compressed_size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exists: Option<bool>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardItem {
    pub id: i64,
    pub content: Option<String>,
    pub content_type: ClipboardContentType,
    pub content_hash: String,
    pub preview: String,
    pub metadata: ClipboardMetadata,
    pub file_path: Option<String>,
    pub image_data: Option<Vec<u8>>,
    pub created_at: i64,
    pub last_used_at: Option<i64>,
    pub use_count: i64,
    pub is_pinned: bool,
    pub is_favorite: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardInsertInput {
    pub content: Option<String>,
    pub content_type: ClipboardContentType,
    pub content_hash: String,
    pub preview: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<ClipboardMetadata>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_data: Option<Vec<u8>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImageCompression {
    Original,
    High,
    Medium,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WheelShortcutModifier {
    Ctrl,
    Alt,
    Shift,
    #[serde(rename = "ctrl+alt")]
    CtrlAlt,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WheelShortcutScope {
    Global,
    PanelOnly,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub retention_days: u32,
    pub max_items: u32,
    pub enable_sensitive_filter: bool,
    pub enable_blacklist: bool,
    pub text_limit_kb: u32,
    pub image_compression: ImageCompression,
    pub launch_on_startup: bool,
    pub wheel_shortcut_enabled: bool,
    pub wheel_shortcut_modifier: WheelShortcutModifier,
    pub wheel_shortcut_scope: WheelShortcutScope,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            retention_days: 7,
            max_items: 1000,
            enable_sensitive_filter: true,
            enable_blacklist: true,
            text_limit_kb: 100,
            image_compression: ImageCompression::High,
            launch_on_startup: false,
            wheel_shortcut_enabled: true,
            wheel_shortcut_modifier: WheelShortcutModifier::Ctrl,
            wheel_shortcut_scope: WheelShortcutScope::Global,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeySettings {
    pub open_panel: String,
    pub search: String,
    pub pause: String,
    pub clear: String,
    pub quick_paste_prev: String,
    pub quick_paste_next: String,
}

impl Default for HotkeySettings {
    fn default() -> Self {
        Self {
            open_panel: "CommandOrControl+Shift+V".to_string(),
            search: "CommandOrControl+Shift+F".to_string(),
            pause: "CommandOrControl+Shift+P".to_string(),
            clear: "CommandOrControl+Shift+C".to_string(),
            quick_paste_prev: "Ctrl+Alt+Left".to_string(),
            quick_paste_next: "Ctrl+Alt+Right".to_string(),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeySettingsPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub open_panel: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub search: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pause: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clear: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quick_paste_prev: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quick_paste_next: Option<String>,
}

impl From<&HotkeySettings> for HotkeySettingsPatch {
    fn from(value: &HotkeySettings) -> Self {
        Self {
            open_panel: Some(value.open_panel.clone()),
            search: Some(value.search.clone()),
            pause: Some(value.pause.clone()),
            clear: Some(value.clear.clone()),
            quick_paste_prev: Some(value.quick_paste_prev.clone()),
            quick_paste_next: Some(value.quick_paste_next.clone()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlacklistApp {
    pub id: i64,
    pub app_name: String,
    pub app_path: Option<String>,
    pub is_builtin: bool,
    pub created_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HudDirection {
    Prev,
    Next,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HudPayload {
    pub direction: HudDirection,
    #[serde(rename = "type")]
    pub content_type: ClipboardContentType,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitoringStatus {
    pub monitor_enabled: bool,
    pub monitor_started: bool,
    pub has_timer: bool,
    pub is_running: bool,
    pub last_hash_prefix: String,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn serializes_content_type_as_lowercase_values() {
        assert_eq!(
            serde_json::to_value(ClipboardContentType::Url).unwrap(),
            json!("url")
        );
    }

    #[test]
    fn serializes_clipboard_item_fields_as_camel_case() {
        let item = ClipboardItem {
            id: 1,
            content: Some("hello".to_string()),
            content_type: ClipboardContentType::Text,
            content_hash: "hash".to_string(),
            preview: "hello".to_string(),
            metadata: ClipboardMetadata::default(),
            file_path: None,
            image_data: None,
            created_at: 1_700_000_000,
            last_used_at: None,
            use_count: 0,
            is_pinned: false,
            is_favorite: false,
        };

        let value = serde_json::to_value(item).unwrap();

        assert_eq!(value["contentType"], json!("text"));
        assert_eq!(value["contentHash"], json!("hash"));
        assert_eq!(value["filePath"], json!(null));
        assert_eq!(value["createdAt"], json!(1_700_000_000));
        assert_eq!(value["lastUsedAt"], json!(null));
        assert_eq!(value["useCount"], json!(0));
        assert_eq!(value["isPinned"], json!(false));
        assert_eq!(value["isFavorite"], json!(false));
        assert!(value.get("content_type").is_none());
    }

    #[test]
    fn default_app_settings_match_shared_types() {
        let settings = AppSettings::default();

        assert_eq!(settings.retention_days, 7);
        assert_eq!(settings.max_items, 1000);
        assert!(settings.enable_sensitive_filter);
        assert!(settings.enable_blacklist);
        assert_eq!(settings.text_limit_kb, 100);
        assert_eq!(settings.image_compression, ImageCompression::High);
        assert!(!settings.launch_on_startup);
        assert!(settings.wheel_shortcut_enabled);
        assert_eq!(
            settings.wheel_shortcut_modifier,
            WheelShortcutModifier::Ctrl
        );
        assert_eq!(settings.wheel_shortcut_scope, WheelShortcutScope::Global);
    }

    #[test]
    fn default_hotkeys_match_shared_types() {
        let hotkeys = HotkeySettings::default();

        assert_eq!(hotkeys.open_panel, "CommandOrControl+Shift+V");
        assert_eq!(hotkeys.search, "CommandOrControl+Shift+F");
        assert_eq!(hotkeys.pause, "CommandOrControl+Shift+P");
        assert_eq!(hotkeys.clear, "CommandOrControl+Shift+C");
        assert_eq!(hotkeys.quick_paste_prev, "Ctrl+Alt+Left");
        assert_eq!(hotkeys.quick_paste_next, "Ctrl+Alt+Right");
    }
}
