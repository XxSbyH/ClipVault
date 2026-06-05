use std::path::Path;

use crate::models::BlacklistApp;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForegroundApp {
    pub app_name: String,
    pub app_path: Option<String>,
}

pub fn is_blacklisted_foreground_app(blacklist: &[BlacklistApp]) -> bool {
    let Some(foreground) = foreground_app() else {
        return false;
    };
    matches_blacklisted_app(&foreground, blacklist)
}

pub fn matches_blacklisted_app(foreground: &ForegroundApp, blacklist: &[BlacklistApp]) -> bool {
    let foreground_name = normalize_name(&foreground.app_name);
    let foreground_path = foreground.app_path.as_deref().map(normalize_path);

    blacklist.iter().any(|entry| {
        if let Some(entry_path) = entry.app_path.as_deref() {
            if let Some(path) = foreground_path.as_deref() {
                return path == normalize_path(entry_path);
            }
        }
        !entry.app_name.trim().is_empty() && foreground_name == normalize_name(&entry.app_name)
    })
}

#[cfg(target_os = "windows")]
pub fn foreground_app() -> Option<ForegroundApp> {
    use windows::Win32::{
        Foundation::{CloseHandle, MAX_PATH},
        System::Threading::{
            OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT,
            PROCESS_QUERY_LIMITED_INFORMATION,
        },
        UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId},
    };

    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0 == std::ptr::null_mut() {
            return None;
        }

        let mut process_id = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut process_id));
        if process_id == 0 {
            return None;
        }

        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id).ok()?;
        let mut buffer = vec![0u16; MAX_PATH as usize * 4];
        let mut size = buffer.len() as u32;
        let result = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_FORMAT(0),
            windows::core::PWSTR(buffer.as_mut_ptr()),
            &mut size,
        );
        let _ = CloseHandle(handle);
        if result.is_err() || size == 0 {
            return None;
        }

        let path = String::from_utf16_lossy(&buffer[..size as usize]);
        let app_name = Path::new(&path)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(&path)
            .to_string();
        Some(ForegroundApp {
            app_name,
            app_path: Some(path),
        })
    }
}

#[cfg(not(target_os = "windows"))]
pub fn foreground_app() -> Option<ForegroundApp> {
    None
}

fn normalize_name(value: &str) -> String {
    value.trim().to_ascii_lowercase()
}

fn normalize_path(value: &str) -> String {
    value.trim().replace('/', "\\").to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: i64, app_name: &str, app_path: Option<&str>) -> BlacklistApp {
        BlacklistApp {
            id,
            app_name: app_name.to_string(),
            app_path: app_path.map(str::to_string),
            is_builtin: false,
            created_at: 0,
        }
    }

    #[test]
    fn matches_foreground_by_case_insensitive_name() {
        let foreground = ForegroundApp {
            app_name: "Chrome.EXE".to_string(),
            app_path: None,
        };

        assert!(matches_blacklisted_app(
            &foreground,
            &[entry(1, "chrome.exe", None)]
        ));
    }

    #[test]
    fn matches_foreground_by_normalized_path() {
        let foreground = ForegroundApp {
            app_name: "chrome.exe".to_string(),
            app_path: Some("C:/Program Files/Google/Chrome/Application/chrome.exe".to_string()),
        };

        assert!(matches_blacklisted_app(
            &foreground,
            &[entry(
                1,
                "other.exe",
                Some("c:\\program files\\google\\chrome\\application\\chrome.exe")
            )]
        ));
    }

    #[test]
    fn does_not_match_different_app() {
        let foreground = ForegroundApp {
            app_name: "code.exe".to_string(),
            app_path: None,
        };

        assert!(!matches_blacklisted_app(
            &foreground,
            &[entry(1, "chrome.exe", None)]
        ));
    }
}
