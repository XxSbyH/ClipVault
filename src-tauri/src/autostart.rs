pub const AUTOSTART_ARG: &str = "--clipvault-autostart";
#[cfg(all(target_os = "windows", not(test)))]
const APP_NAME: &str = "ClipVault";

pub fn should_show_main_window_for_env_args() -> bool {
    should_show_main_window_for_args(std::env::args())
}

pub fn should_show_main_window_for_args<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    !args.into_iter().any(|arg| arg.as_ref() == AUTOSTART_ARG)
}

pub fn autostart_command_for_exe_path(exe_path: &str) -> String {
    format!("\"{exe_path}\" {AUTOSTART_ARG}")
}

pub fn sync_launch_on_startup(enabled: bool) -> Result<(), String> {
    platform::sync_launch_on_startup(enabled)
}

#[cfg(all(target_os = "windows", not(test)))]
mod platform {
    use std::{env, ffi::OsStr, os::windows::ffi::OsStrExt};

    use windows::{
        core::PCWSTR,
        Win32::{
            Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS, WIN32_ERROR},
            System::Registry::{
                RegCloseKey, RegCreateKeyW, RegDeleteValueW, RegSetValueExW, HKEY,
                HKEY_CURRENT_USER, REG_BINARY, REG_SZ,
            },
        },
    };

    use super::{autostart_command_for_exe_path, APP_NAME};

    const RUN_REGKEY: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Run";
    const TASK_MANAGER_OVERRIDE_REGKEY: &str =
        r"SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
    const TASK_MANAGER_OVERRIDE_ENABLED_VALUE: [u8; 12] = [
        0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ];

    pub fn sync_launch_on_startup(enabled: bool) -> Result<(), String> {
        if enabled {
            enable()
        } else {
            disable()
        }
    }

    fn enable() -> Result<(), String> {
        let exe_path =
            env::current_exe().map_err(|error| format!("failed to read current exe: {error}"))?;
        let command = autostart_command_for_exe_path(&exe_path.to_string_lossy());
        set_string_value(RUN_REGKEY, APP_NAME, &command)?;
        set_binary_value(
            TASK_MANAGER_OVERRIDE_REGKEY,
            APP_NAME,
            &TASK_MANAGER_OVERRIDE_ENABLED_VALUE,
        )?;
        Ok(())
    }

    fn disable() -> Result<(), String> {
        delete_value(RUN_REGKEY, APP_NAME)?;
        Ok(())
    }

    fn set_string_value(subkey: &str, name: &str, value: &str) -> Result<(), String> {
        let key = create_key(subkey)?;
        let name = wide_null(name);
        let data = wide_bytes_null(value);
        let status =
            unsafe { RegSetValueExW(key.raw(), PCWSTR(name.as_ptr()), 0, REG_SZ, Some(&data)) };
        win32_result(status, "failed to set startup registry value")
    }

    fn set_binary_value(subkey: &str, name: &str, value: &[u8]) -> Result<(), String> {
        let key = create_key(subkey)?;
        let name = wide_null(name);
        let status =
            unsafe { RegSetValueExW(key.raw(), PCWSTR(name.as_ptr()), 0, REG_BINARY, Some(value)) };
        win32_result(status, "failed to set startup approval registry value")
    }

    fn delete_value(subkey: &str, name: &str) -> Result<(), String> {
        let key = create_key(subkey)?;
        let name = wide_null(name);
        let status = unsafe { RegDeleteValueW(key.raw(), PCWSTR(name.as_ptr())) };
        if status == ERROR_SUCCESS || status == ERROR_FILE_NOT_FOUND {
            Ok(())
        } else {
            Err(format!(
                "failed to delete startup registry value: Windows error {}",
                status.0
            ))
        }
    }

    fn create_key(subkey: &str) -> Result<RegistryKey, String> {
        let subkey = wide_null(subkey);
        let mut key = HKEY::default();
        let status = unsafe { RegCreateKeyW(HKEY_CURRENT_USER, PCWSTR(subkey.as_ptr()), &mut key) };
        win32_result(status, "failed to open startup registry key")?;
        Ok(RegistryKey(key))
    }

    fn win32_result(status: WIN32_ERROR, message: &str) -> Result<(), String> {
        if status == ERROR_SUCCESS {
            Ok(())
        } else {
            Err(format!("{message}: Windows error {}", status.0))
        }
    }

    fn wide_null(value: &str) -> Vec<u16> {
        OsStr::new(value).encode_wide().chain([0]).collect()
    }

    fn wide_bytes_null(value: &str) -> Vec<u8> {
        wide_null(value)
            .into_iter()
            .flat_map(u16::to_le_bytes)
            .collect()
    }

    struct RegistryKey(HKEY);

    impl RegistryKey {
        fn raw(&self) -> HKEY {
            self.0
        }
    }

    impl Drop for RegistryKey {
        fn drop(&mut self) {
            let _ = unsafe { RegCloseKey(self.0) };
        }
    }
}

#[cfg(any(not(target_os = "windows"), test))]
mod platform {
    pub fn sync_launch_on_startup(enabled: bool) -> Result<(), String> {
        if cfg!(test) {
            Ok(())
        } else if enabled {
            Err("autostart is only supported on Windows".to_string())
        } else {
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn autostart_command_quotes_exe_path_and_appends_background_arg() {
        assert_eq!(
            autostart_command_for_exe_path(r"C:\Program Files\ClipVault\ClipVault.exe"),
            r#""C:\Program Files\ClipVault\ClipVault.exe" --clipvault-autostart"#
        );
    }

    #[test]
    fn autostart_command_uses_current_exe_path_without_hardcoded_install_location() {
        assert_eq!(
            autostart_command_for_exe_path(r"D:\apps\ClipVault\ClipVault.exe"),
            r#""D:\apps\ClipVault\ClipVault.exe" --clipvault-autostart"#
        );
    }

    #[test]
    fn autostart_launch_does_not_show_main_window() {
        assert!(!should_show_main_window_for_args([
            "ClipVault.exe",
            AUTOSTART_ARG
        ]));
    }

    #[test]
    fn normal_launch_shows_main_window() {
        assert!(should_show_main_window_for_args(["ClipVault.exe"]));
    }
}
