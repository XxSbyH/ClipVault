use std::{
    path::Path,
    sync::{Arc, Mutex, MutexGuard},
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::{params, Connection, OptionalExtension};
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::database::migrations::{configure_connection, init_database};
use crate::{
    errors::AppResult,
    models::{
        AppSettings, BlacklistApp, ClipboardContentType, ClipboardFormatEncoding,
        ClipboardFormatInput, ClipboardFormatPayload, ClipboardInsertInput, ClipboardItem,
        ClipboardMetadata, FixedContent, FixedContentInput, HotkeySettings, HotkeySettingsPatch,
        ImageCompression, ThemeMode, WheelShortcutModifier, WheelShortcutScope,
    },
};

const CLIPBOARD_ITEM_SUMMARY_COLUMNS: &str = "id, content, content_type, content_hash, preview, metadata, file_path, NULL AS image_data, created_at, last_used_at, use_count, is_pinned, is_favorite";
const CLIPBOARD_ITEM_SUMMARY_COLUMNS_QUALIFIED: &str = "clipboard_items.id, clipboard_items.content, clipboard_items.content_type, clipboard_items.content_hash, clipboard_items.preview, clipboard_items.metadata, clipboard_items.file_path, NULL AS image_data, clipboard_items.created_at, clipboard_items.last_used_at, clipboard_items.use_count, clipboard_items.is_pinned, clipboard_items.is_favorite";
const MIN_MAX_ITEMS: u32 = 100;
const MAX_MAX_ITEMS: u32 = 1_000_000;

pub struct Repository {
    conn: Arc<Mutex<Connection>>,
}

impl Repository {
    pub fn open(path: impl AsRef<Path>) -> AppResult<Self> {
        init_database(&path)?;
        let conn = Connection::open(path)?;
        configure_connection(&conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    pub fn insert_item(&self, input: ClipboardInsertInput) -> AppResult<ClipboardItem> {
        self.insert_clipboard_item(input)
    }

    pub fn insert_clipboard_item(&self, input: ClipboardInsertInput) -> AppResult<ClipboardItem> {
        let conn = self.conn()?;
        if let Some(existing) = self.get_item_by_hash_locked(&conn, &input.content_hash)? {
            conn.execute(
                "UPDATE clipboard_items SET created_at = ?1 WHERE id = ?2",
                params![now_timestamp(), existing.id],
            )?;
            return self.get_item_locked(&conn, existing.id);
        }

        let metadata = serde_json::to_string(&input.metadata.unwrap_or_default())?;
        let created_at = now_timestamp();
        conn.execute(
            "INSERT INTO clipboard_items
             (content, content_type, content_hash, preview, metadata, file_path, image_data, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                input.content,
                content_type_to_db(input.content_type),
                input.content_hash,
                input.preview,
                metadata,
                input.file_path,
                input.image_data,
                created_at,
            ],
        )?;

        let id = conn.last_insert_rowid();
        self.get_item_locked(&conn, id)
    }

    pub fn insert_clipboard_format(
        &self,
        item_id: i64,
        input: &ClipboardFormatInput,
    ) -> AppResult<ClipboardFormatPayload> {
        {
            let mut conn = self.conn()?;
            let tx = conn.transaction()?;
            let format_id = input.format_id.map(i64::from);
            tx.execute(
                "INSERT OR IGNORE INTO clipboard_formats
                 (item_id, format_name, format_id, mime_type, encoding, data, byte_len, data_hash, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    item_id,
                    input.format_name.as_str(),
                    format_id,
                    input.mime_type.as_deref(),
                    format_encoding_to_db(input.encoding),
                    input.data.as_slice(),
                    input.data.len() as i64,
                    input.data_hash.as_str(),
                    now_timestamp(),
                ],
            )?;
            sync_rich_format_metadata(&tx, item_id)?;
            tx.commit()?;
        }

        self.list_clipboard_formats(item_id)?
            .into_iter()
            .find(|payload| {
                payload.format_name == input.format_name && payload.data_hash == input.data_hash
            })
            .ok_or_else(|| "inserted clipboard format was not found".into())
    }

    pub fn list_clipboard_formats(&self, item_id: i64) -> AppResult<Vec<ClipboardFormatPayload>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, item_id, format_name, format_id, mime_type, encoding, data, byte_len, data_hash, created_at
             FROM clipboard_formats
             WHERE item_id = ?1
             ORDER BY id ASC",
        )?;
        let rows = stmt.query_map(params![item_id], map_clipboard_format)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn get_item_by_id(&self, id: i64) -> AppResult<Option<ClipboardItem>> {
        let conn = self.conn()?;
        Ok(conn
            .query_row(
                "SELECT * FROM clipboard_items WHERE id = ?1",
                params![id],
                map_clipboard_item,
            )
            .optional()?)
    }

    pub fn get_history(&self, limit: i64) -> AppResult<Vec<ClipboardItem>> {
        let conn = self.conn()?;
        let sql = format!(
            "SELECT {CLIPBOARD_ITEM_SUMMARY_COLUMNS} FROM clipboard_items
             ORDER BY is_pinned DESC, created_at DESC, id DESC
             LIMIT ?1"
        );
        query_items(&conn, &sql, params![limit])
    }

    pub fn get_history_page(&self, limit: i64, offset: i64) -> AppResult<Vec<ClipboardItem>> {
        let conn = self.conn()?;
        let sql = format!(
            "SELECT {CLIPBOARD_ITEM_SUMMARY_COLUMNS} FROM clipboard_items
             ORDER BY is_pinned DESC, created_at DESC, id DESC
             LIMIT ?1 OFFSET ?2"
        );
        query_items(&conn, &sql, params![limit, offset])
    }

    pub fn get_history_by_offset(&self, offset: i64) -> AppResult<Option<ClipboardItem>> {
        let conn = self.conn()?;
        Ok(conn
            .query_row(
                "SELECT * FROM clipboard_items
                 ORDER BY is_pinned DESC, created_at DESC, id DESC
                 LIMIT 1 OFFSET ?1",
                params![offset],
                map_clipboard_item,
            )
            .optional()?)
    }

    pub fn count_items(&self) -> AppResult<i64> {
        let conn = self.conn()?;
        Ok(conn.query_row("SELECT COUNT(*) FROM clipboard_items", [], |row| row.get(0))?)
    }

    pub fn toggle_pin(&self, id: i64) -> AppResult<ClipboardItem> {
        let conn = self.conn()?;
        conn.execute(
            "UPDATE clipboard_items
             SET is_pinned = CASE is_pinned WHEN 1 THEN 0 ELSE 1 END
             WHERE id = ?1",
            params![id],
        )?;
        self.get_item_locked(&conn, id)
    }

    pub fn toggle_favorite(&self, id: i64) -> AppResult<ClipboardItem> {
        let conn = self.conn()?;
        conn.execute(
            "UPDATE clipboard_items
             SET is_favorite = CASE is_favorite WHEN 1 THEN 0 ELSE 1 END
             WHERE id = ?1",
            params![id],
        )?;
        self.get_item_locked(&conn, id)
    }

    pub fn delete_item(&self, id: i64) -> AppResult<()> {
        let conn = self.conn()?;
        conn.execute("DELETE FROM clipboard_items WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn clear_history(&self, include_favorites: bool) -> AppResult<usize> {
        let conn = self.conn()?;
        let deleted = if include_favorites {
            conn.execute("DELETE FROM clipboard_items", [])?
        } else {
            conn.execute("DELETE FROM clipboard_items WHERE is_favorite = 0", [])?
        };
        Ok(deleted)
    }

    pub fn increment_use_stats(&self, id: i64) -> AppResult<ClipboardItem> {
        let conn = self.conn()?;
        conn.execute(
            "UPDATE clipboard_items
             SET use_count = use_count + 1, last_used_at = ?1
             WHERE id = ?2",
            params![now_timestamp(), id],
        )?;
        self.get_item_locked(&conn, id)
    }

    pub fn update_text_item(
        &self,
        id: i64,
        content: &str,
        content_type: ClipboardContentType,
        content_hash: &str,
        preview: &str,
        metadata: ClipboardMetadata,
    ) -> AppResult<Option<ClipboardItem>> {
        let conn = self.conn()?;
        if let Some(existing) = self.get_item_by_hash_locked(&conn, content_hash)? {
            if existing.id != id {
                return Err(format!(
                    "clipboard item with content hash already exists: {content_hash}"
                )
                .into());
            }
        }

        let metadata = serde_json::to_string(&metadata)?;
        let updated = conn.execute(
            "UPDATE clipboard_items
             SET content = ?1,
                 content_type = ?2,
                 content_hash = ?3,
                 preview = ?4,
                 metadata = ?5,
                 file_path = NULL,
                 image_data = NULL
             WHERE id = ?6
               AND content_type IN ('text', 'url', 'code', 'color', 'email')",
            params![
                content,
                content_type_to_db(content_type),
                content_hash,
                preview,
                metadata,
                id,
            ],
        )?;

        if updated == 0 {
            return Ok(None);
        }

        Ok(Some(self.get_item_locked(&conn, id)?))
    }

    pub fn enforce_max_items(&self, max_items: i64) -> AppResult<()> {
        let conn = self.conn()?;
        conn.execute(
            "DELETE FROM clipboard_items
             WHERE id IN (
               SELECT id FROM clipboard_items
               WHERE is_favorite = 0
               ORDER BY created_at ASC, id ASC
               LIMIT MAX((SELECT COUNT(*) FROM clipboard_items) - ?1, 0)
             )",
            params![max_items],
        )?;
        Ok(())
    }

    pub fn delete_old_items(&self, days: u32) -> AppResult<usize> {
        if days == 0 {
            return Ok(0);
        }

        let threshold = now_timestamp() - i64::from(days) * 24 * 60 * 60 * 1000;
        let conn = self.conn()?;
        Ok(conn.execute(
            "DELETE FROM clipboard_items
             WHERE created_at < ?1 AND COALESCE(is_favorite, 0) = 0",
            params![threshold],
        )?)
    }

    pub fn search_items(&self, query: &str, limit: i64) -> AppResult<Vec<ClipboardItem>> {
        let conn = self.conn()?;
        let fts_query = query.replace('"', "\"\"");
        let like = format!("%{query}%");
        let like_search = || {
            let sql = format!(
                "SELECT {CLIPBOARD_ITEM_SUMMARY_COLUMNS} FROM clipboard_items
                 WHERE content LIKE ?1 OR preview LIKE ?1
                 ORDER BY is_pinned DESC, created_at DESC, id DESC
                 LIMIT ?2"
            );
            query_items(&conn, &sql, params![like, limit])
        };
        let sql = format!(
            "SELECT {CLIPBOARD_ITEM_SUMMARY_COLUMNS_QUALIFIED} FROM clipboard_items
             JOIN clipboard_fts ON clipboard_fts.rowid = clipboard_items.id
             WHERE clipboard_fts MATCH ?1
             ORDER BY is_pinned DESC, created_at DESC, id DESC
             LIMIT ?2"
        );
        let fts = query_items(&conn, &sql, params![fts_query, limit]);

        match fts {
            Ok(items) if !items.is_empty() => Ok(items),
            _ => like_search(),
        }
    }

    pub fn get_settings(&self) -> AppResult<AppSettings> {
        let conn = self.conn()?;
        let mut settings = self
            .get_json_setting_locked::<AppSettings>(&conn, "app_settings")?
            .unwrap_or_default();

        let mut stmt = conn.prepare("SELECT key, value FROM settings")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;

        for row in rows {
            let (key, value) = row?;
            apply_setting_row(&mut settings, &key, &value);
        }
        normalize_app_settings(&mut settings);

        Ok(settings)
    }

    pub fn update_settings(&self, settings: &AppSettings) -> AppResult<()> {
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        let now = now_timestamp();
        upsert_setting_locked(&tx, "retentionDays", &settings.retention_days, now)?;
        upsert_setting_locked(&tx, "maxItems", &settings.max_items, now)?;
        upsert_setting_locked(
            &tx,
            "enableSensitiveFilter",
            &settings.enable_sensitive_filter,
            now,
        )?;
        upsert_setting_locked(&tx, "enableBlacklist", &settings.enable_blacklist, now)?;
        upsert_setting_locked(&tx, "textLimitKb", &settings.text_limit_kb, now)?;
        upsert_setting_locked(&tx, "imageCompression", &settings.image_compression, now)?;
        upsert_setting_locked(&tx, "themeMode", &settings.theme_mode, now)?;
        upsert_setting_locked(&tx, "launchOnStartup", &settings.launch_on_startup, now)?;
        upsert_setting_locked(
            &tx,
            "wheelShortcutEnabled",
            &settings.wheel_shortcut_enabled,
            now,
        )?;
        upsert_setting_locked(
            &tx,
            "wheelShortcutModifier",
            &settings.wheel_shortcut_modifier,
            now,
        )?;
        upsert_setting_locked(
            &tx,
            "wheelShortcutScope",
            &settings.wheel_shortcut_scope,
            now,
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn update_setting(&self, key: &str, value: Value) -> AppResult<AppSettings> {
        let serialized = serialize_setting_value(key, value)?;

        {
            let conn = self.conn()?;
            conn.execute(
                "INSERT INTO settings (key, value, updated_at)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                params![key, serialized, now_timestamp()],
            )?;
        }

        self.get_settings()
    }

    pub fn get_hotkey_settings(&self) -> AppResult<HotkeySettings> {
        let conn = self.conn()?;
        let mut hotkeys = self
            .get_json_setting_locked::<HotkeySettings>(&conn, "hotkey_settings")?
            .unwrap_or_default();

        let mut stmt = conn.prepare("SELECT key, value FROM settings WHERE key LIKE 'hotkey_%'")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;

        for row in rows {
            let (key, value) = row?;
            let Some(value) = parse_hotkey_value(&value) else {
                continue;
            };

            match key.strip_prefix("hotkey_") {
                Some("openPanel") => hotkeys.open_panel = value,
                Some("search") => hotkeys.search = value,
                Some("pause") => hotkeys.pause = value,
                Some("clear") => hotkeys.clear = value,
                Some("quickPastePrev") => hotkeys.quick_paste_prev = value,
                Some("quickPasteNext") => hotkeys.quick_paste_next = value,
                _ => {}
            }
        }

        Ok(hotkeys)
    }

    pub fn update_hotkey_settings(&self, patch: &HotkeySettingsPatch) -> AppResult<HotkeySettings> {
        let values = hotkey_patch_values(patch)?;

        {
            let mut conn = self.conn()?;
            let tx = conn.transaction()?;
            let now = now_timestamp();
            for (key, value) in values {
                upsert_hotkey_locked(&tx, key, &value, now)?;
            }
            tx.commit()?;
        }

        self.get_hotkey_settings()
    }

    pub fn list_fixed_contents(&self) -> AppResult<Vec<FixedContent>> {
        let conn = self.conn()?;
        query_fixed_contents(
            &conn,
            "SELECT id, title, content, hotkey, enabled, created_at, updated_at, last_used_at, use_count
             FROM fixed_contents
             ORDER BY updated_at DESC, id DESC",
            [],
        )
    }

    pub fn get_fixed_content_by_id(&self, id: i64) -> AppResult<Option<FixedContent>> {
        let conn = self.conn()?;
        Ok(conn
            .query_row(
                "SELECT id, title, content, hotkey, enabled, created_at, updated_at, last_used_at, use_count
                 FROM fixed_contents
                 WHERE id = ?1",
                params![id],
                map_fixed_content,
            )
            .optional()?)
    }

    pub fn create_fixed_content(&self, input: &FixedContentInput) -> AppResult<FixedContent> {
        let conn = self.conn()?;
        let now = now_timestamp();
        conn.execute(
            "INSERT INTO fixed_contents
             (title, content, hotkey, enabled, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                input.title.as_str(),
                input.content.as_str(),
                input.hotkey.as_str(),
                bool_to_db(input.enabled),
                now,
                now,
            ],
        )?;

        let id = conn.last_insert_rowid();
        self.get_fixed_content_locked(&conn, id)
    }

    pub fn update_fixed_content(
        &self,
        id: i64,
        input: &FixedContentInput,
    ) -> AppResult<Option<FixedContent>> {
        let conn = self.conn()?;
        let updated = conn.execute(
            "UPDATE fixed_contents
             SET title = ?1, content = ?2, hotkey = ?3, enabled = ?4, updated_at = ?5
             WHERE id = ?6",
            params![
                input.title.as_str(),
                input.content.as_str(),
                input.hotkey.as_str(),
                bool_to_db(input.enabled),
                now_timestamp(),
                id,
            ],
        )?;

        if updated == 0 {
            return Ok(None);
        }

        Ok(Some(self.get_fixed_content_locked(&conn, id)?))
    }

    pub fn delete_fixed_content(&self, id: i64) -> AppResult<bool> {
        let conn = self.conn()?;
        Ok(conn.execute("DELETE FROM fixed_contents WHERE id = ?1", params![id])? > 0)
    }

    pub fn increment_fixed_content_use_stats(&self, id: i64) -> AppResult<Option<FixedContent>> {
        let conn = self.conn()?;
        let updated = conn.execute(
            "UPDATE fixed_contents
             SET use_count = use_count + 1, last_used_at = ?1, updated_at = ?1
             WHERE id = ?2",
            params![now_timestamp(), id],
        )?;

        if updated == 0 {
            return Ok(None);
        }

        Ok(Some(self.get_fixed_content_locked(&conn, id)?))
    }

    pub fn list_blacklist(&self) -> AppResult<Vec<BlacklistApp>> {
        self.list_blacklist_apps()
    }

    pub fn list_blacklist_apps(&self) -> AppResult<Vec<BlacklistApp>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, app_name, app_path, is_builtin, created_at
             FROM app_blacklist
             ORDER BY is_builtin DESC, app_name ASC",
        )?;
        let rows = stmt.query_map([], map_blacklist_app)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn add_blacklist_app(
        &self,
        app_name: &str,
        app_path: Option<&str>,
    ) -> AppResult<BlacklistApp> {
        let conn = self.conn()?;
        conn.execute(
            "INSERT INTO app_blacklist (app_name, app_path, is_builtin, created_at)
             VALUES (?1, ?2, 0, ?3)",
            params![app_name, app_path, now_timestamp()],
        )?;
        let id = conn.last_insert_rowid();
        Ok(conn.query_row(
            "SELECT id, app_name, app_path, is_builtin, created_at
             FROM app_blacklist
             WHERE id = ?1",
            params![id],
            map_blacklist_app,
        )?)
    }

    pub fn remove_blacklist_app(&self, id: i64) -> AppResult<bool> {
        let conn = self.conn()?;
        let is_builtin = conn
            .query_row(
                "SELECT is_builtin FROM app_blacklist WHERE id = ?1",
                params![id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?;

        if is_builtin == Some(1) {
            return Ok(false);
        }

        Ok(conn.execute("DELETE FROM app_blacklist WHERE id = ?1", params![id])? > 0)
    }

    fn conn(&self) -> AppResult<MutexGuard<'_, Connection>> {
        self.conn
            .lock()
            .map_err(|_| "database connection lock poisoned".into())
    }

    fn get_item_by_hash_locked(
        &self,
        conn: &Connection,
        content_hash: &str,
    ) -> AppResult<Option<ClipboardItem>> {
        Ok(conn
            .query_row(
                "SELECT * FROM clipboard_items WHERE content_hash = ?1",
                params![content_hash],
                map_clipboard_item,
            )
            .optional()?)
    }

    fn get_item_locked(&self, conn: &Connection, id: i64) -> AppResult<ClipboardItem> {
        Ok(conn.query_row(
            "SELECT * FROM clipboard_items WHERE id = ?1",
            params![id],
            map_clipboard_item,
        )?)
    }

    fn get_fixed_content_locked(&self, conn: &Connection, id: i64) -> AppResult<FixedContent> {
        Ok(conn.query_row(
            "SELECT id, title, content, hotkey, enabled, created_at, updated_at, last_used_at, use_count
             FROM fixed_contents
             WHERE id = ?1",
            params![id],
            map_fixed_content,
        )?)
    }

    fn get_json_setting_locked<T>(&self, conn: &Connection, key: &str) -> AppResult<Option<T>>
    where
        T: DeserializeOwned,
    {
        let value = conn
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                params![key],
                |row| row.get::<_, String>(0),
            )
            .optional()?;

        value
            .map(|value| serde_json::from_str(&value))
            .transpose()
            .map_err(Into::into)
    }

    #[cfg(test)]
    fn mark_blacklist_builtin_for_test(&self, id: i64) -> AppResult<()> {
        let conn = self.conn()?;
        conn.execute(
            "UPDATE app_blacklist SET is_builtin = 1 WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    }
}

fn query_items<P>(conn: &Connection, sql: &str, params: P) -> AppResult<Vec<ClipboardItem>>
where
    P: rusqlite::Params,
{
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map(params, map_clipboard_item)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn query_fixed_contents<P>(conn: &Connection, sql: &str, params: P) -> AppResult<Vec<FixedContent>>
where
    P: rusqlite::Params,
{
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map(params, map_fixed_content)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn sync_rich_format_metadata(tx: &rusqlite::Transaction<'_>, item_id: i64) -> AppResult<()> {
    let metadata_json = tx
        .query_row(
            "SELECT metadata FROM clipboard_items WHERE id = ?1",
            params![item_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten()
        .unwrap_or_else(|| "{}".to_string());
    let mut metadata =
        serde_json::from_str::<ClipboardMetadata>(&metadata_json).unwrap_or_default();
    let format_names = {
        let mut stmt = tx.prepare(
            "SELECT format_name
             FROM clipboard_formats
             WHERE item_id = ?1
             GROUP BY format_name
             ORDER BY MIN(id) ASC",
        )?;
        let rows = stmt.query_map(params![item_id], |row| row.get::<_, String>(0))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    if format_names.is_empty() {
        return Ok(());
    }

    let format_count = format_names.len();
    metadata
        .extra
        .insert("hasRichFormats".to_string(), serde_json::json!(true));
    metadata
        .extra
        .insert("formatNames".to_string(), serde_json::json!(format_names));
    metadata
        .extra
        .insert("formatCount".to_string(), serde_json::json!(format_count));

    let serialized = serde_json::to_string(&metadata)?;
    tx.execute(
        "UPDATE clipboard_items SET metadata = ?2 WHERE id = ?1",
        params![item_id, serialized],
    )?;
    Ok(())
}

fn serialize_setting_value(key: &str, value: Value) -> AppResult<String> {
    match key {
        "retentionDays" => serialize_typed_setting::<u32>(key, value),
        "maxItems" => serialize_bounded_u32_setting(key, value, MIN_MAX_ITEMS, MAX_MAX_ITEMS),
        "enableSensitiveFilter" => serialize_typed_setting::<bool>(key, value),
        "enableBlacklist" => serialize_typed_setting::<bool>(key, value),
        "textLimitKb" => serialize_typed_setting::<u32>(key, value),
        "imageCompression" => serialize_typed_setting::<ImageCompression>(key, value),
        "themeMode" => serialize_typed_setting::<ThemeMode>(key, value),
        "launchOnStartup" => serialize_typed_setting::<bool>(key, value),
        "wheelShortcutEnabled" => serialize_typed_setting::<bool>(key, value),
        "wheelShortcutModifier" => serialize_typed_setting::<WheelShortcutModifier>(key, value),
        "wheelShortcutScope" => serialize_typed_setting::<WheelShortcutScope>(key, value),
        _ => Err(format!("unknown setting key: {key}").into()),
    }
}

fn serialize_bounded_u32_setting(key: &str, value: Value, min: u32, max: u32) -> AppResult<String> {
    let typed = serde_json::from_value::<u32>(value)
        .map_err(|_| format!("invalid value for setting {key}"))?;
    if !(min..=max).contains(&typed) {
        return Err(format!("invalid value for setting {key}: expected {min}..={max}").into());
    }
    Ok(serde_json::to_string(&typed)?)
}

fn serialize_typed_setting<T>(key: &str, value: Value) -> AppResult<String>
where
    T: DeserializeOwned + serde::Serialize,
{
    let typed = serde_json::from_value::<T>(value)
        .map_err(|_| format!("invalid value for setting {key}"))?;
    Ok(serde_json::to_string(&typed)?)
}

fn apply_setting_row(settings: &mut AppSettings, key: &str, value: &str) {
    match key {
        "retentionDays" => apply_json(value, &mut settings.retention_days),
        "maxItems" => apply_json(value, &mut settings.max_items),
        "enableSensitiveFilter" => apply_json(value, &mut settings.enable_sensitive_filter),
        "enableBlacklist" => apply_json(value, &mut settings.enable_blacklist),
        "textLimitKb" => apply_json(value, &mut settings.text_limit_kb),
        "imageCompression" => {
            apply_json::<ImageCompression>(value, &mut settings.image_compression)
        }
        "themeMode" => apply_json::<ThemeMode>(value, &mut settings.theme_mode),
        "launchOnStartup" => apply_json(value, &mut settings.launch_on_startup),
        "wheelShortcutEnabled" => apply_json(value, &mut settings.wheel_shortcut_enabled),
        "wheelShortcutModifier" => {
            apply_json::<WheelShortcutModifier>(value, &mut settings.wheel_shortcut_modifier)
        }
        "wheelShortcutScope" => {
            apply_json::<WheelShortcutScope>(value, &mut settings.wheel_shortcut_scope)
        }
        _ => {}
    }
}

fn normalize_app_settings(settings: &mut AppSettings) {
    if !(MIN_MAX_ITEMS..=MAX_MAX_ITEMS).contains(&settings.max_items) {
        settings.max_items = AppSettings::default().max_items;
    }
}

fn apply_json<T>(raw: &str, target: &mut T)
where
    T: DeserializeOwned,
{
    if let Ok(value) = serde_json::from_str(raw) {
        *target = value;
    }
}

fn upsert_setting_locked<T>(
    conn: &Connection,
    key: &str,
    value: &T,
    updated_at: i64,
) -> AppResult<()>
where
    T: serde::Serialize,
{
    conn.execute(
        "INSERT INTO settings (key, value, updated_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![key, serde_json::to_string(value)?, updated_at],
    )?;
    Ok(())
}

fn upsert_hotkey_locked(
    conn: &Connection,
    key: &str,
    value: &str,
    updated_at: i64,
) -> AppResult<()> {
    upsert_setting_locked(conn, &format!("hotkey_{key}"), &value, updated_at)
}

fn hotkey_patch_values(patch: &HotkeySettingsPatch) -> AppResult<Vec<(&'static str, String)>> {
    let mut values = Vec::new();
    if let Some(value) = patch.open_panel.as_deref() {
        values.push(("openPanel", validate_hotkey_value("openPanel", value)?));
    }
    if let Some(value) = patch.search.as_deref() {
        values.push(("search", validate_hotkey_value("search", value)?));
    }
    if let Some(value) = patch.pause.as_deref() {
        values.push(("pause", validate_hotkey_value("pause", value)?));
    }
    if let Some(value) = patch.clear.as_deref() {
        values.push(("clear", validate_hotkey_value("clear", value)?));
    }
    if let Some(value) = patch.quick_paste_prev.as_deref() {
        values.push((
            "quickPastePrev",
            validate_hotkey_value("quickPastePrev", value)?,
        ));
    }
    if let Some(value) = patch.quick_paste_next.as_deref() {
        values.push((
            "quickPasteNext",
            validate_hotkey_value("quickPasteNext", value)?,
        ));
    }
    Ok(values)
}

fn validate_hotkey_value(key: &str, value: &str) -> AppResult<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("invalid hotkey_{key}: empty value").into());
    }
    Ok(trimmed.to_string())
}

fn parse_hotkey_value(raw: &str) -> Option<String> {
    let parsed = serde_json::from_str::<String>(raw).unwrap_or_else(|_| raw.to_string());
    let trimmed = parsed.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn map_clipboard_item(row: &rusqlite::Row<'_>) -> rusqlite::Result<ClipboardItem> {
    let id: i64 = row.get("id")?;
    let content: Option<String> = row.get("content")?;
    let metadata_json = row
        .get::<_, Option<String>>("metadata")?
        .unwrap_or_else(|| "{}".to_string());
    let metadata = serde_json::from_str(&metadata_json).unwrap_or_default();
    let content_type = row
        .get::<_, Option<String>>("content_type")?
        .unwrap_or_else(|| "text".to_string());
    let preview = row
        .get::<_, Option<String>>("preview")?
        .unwrap_or_else(|| content.clone().unwrap_or_default());

    Ok(ClipboardItem {
        id,
        content,
        content_type: content_type_from_db(&content_type),
        content_hash: row
            .get::<_, Option<String>>("content_hash")?
            .unwrap_or_default(),
        preview,
        metadata,
        file_path: row.get("file_path")?,
        image_data: row.get("image_data")?,
        created_at: row.get::<_, Option<i64>>("created_at")?.unwrap_or_default(),
        last_used_at: row.get("last_used_at")?,
        use_count: row.get::<_, Option<i64>>("use_count")?.unwrap_or_default(),
        is_pinned: row.get::<_, Option<i64>>("is_pinned")?.unwrap_or_default() == 1,
        is_favorite: row
            .get::<_, Option<i64>>("is_favorite")?
            .unwrap_or_default()
            == 1,
    })
}

fn map_clipboard_format(row: &rusqlite::Row<'_>) -> rusqlite::Result<ClipboardFormatPayload> {
    let encoding: String = row.get("encoding")?;
    let format_id = row
        .get::<_, Option<i64>>("format_id")?
        .and_then(|value| u32::try_from(value).ok());

    Ok(ClipboardFormatPayload {
        id: row.get("id")?,
        item_id: row.get("item_id")?,
        format_name: row.get("format_name")?,
        format_id,
        mime_type: row.get("mime_type")?,
        encoding: format_encoding_from_db(&encoding),
        data: row.get("data")?,
        byte_len: row.get("byte_len")?,
        data_hash: row.get("data_hash")?,
        created_at: row.get("created_at")?,
    })
}

fn map_fixed_content(row: &rusqlite::Row<'_>) -> rusqlite::Result<FixedContent> {
    Ok(FixedContent {
        id: row.get("id")?,
        title: row.get("title")?,
        content: row.get("content")?,
        hotkey: row.get("hotkey")?,
        enabled: row.get::<_, i64>("enabled")? != 0,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        last_used_at: row.get("last_used_at")?,
        use_count: row.get::<_, Option<i64>>("use_count")?.unwrap_or_default(),
    })
}

fn map_blacklist_app(row: &rusqlite::Row<'_>) -> rusqlite::Result<BlacklistApp> {
    Ok(BlacklistApp {
        id: row.get("id")?,
        app_name: row
            .get::<_, Option<String>>("app_name")?
            .unwrap_or_default(),
        app_path: row.get("app_path")?,
        is_builtin: row.get::<_, Option<i64>>("is_builtin")?.unwrap_or_default() == 1,
        created_at: row.get::<_, Option<i64>>("created_at")?.unwrap_or_default(),
    })
}

fn bool_to_db(value: bool) -> i64 {
    if value {
        1
    } else {
        0
    }
}

fn format_encoding_to_db(encoding: ClipboardFormatEncoding) -> &'static str {
    match encoding {
        ClipboardFormatEncoding::Utf8 => "utf8",
        ClipboardFormatEncoding::Utf16Le => "utf16le",
        ClipboardFormatEncoding::Binary => "binary",
    }
}

fn format_encoding_from_db(value: &str) -> ClipboardFormatEncoding {
    match value {
        "utf8" => ClipboardFormatEncoding::Utf8,
        "utf16le" => ClipboardFormatEncoding::Utf16Le,
        _ => ClipboardFormatEncoding::Binary,
    }
}

fn content_type_to_db(content_type: ClipboardContentType) -> &'static str {
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

fn content_type_from_db(value: &str) -> ClipboardContentType {
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

fn now_timestamp() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use serde_json::json;

    use crate::models::{
        AppSettings, ClipboardContentType, ClipboardFormatEncoding, ClipboardFormatInput,
        ClipboardInsertInput, ClipboardMetadata, FixedContentInput, HotkeySettingsPatch,
        ImageCompression, ThemeMode,
    };

    use super::Repository;

    fn repo() -> Repository {
        let dir = tempdir().unwrap();
        let path = dir.path().join("clipboard.db");
        Repository::open(path).unwrap()
    }

    fn text_input(content: &str, hash: &str) -> ClipboardInsertInput {
        ClipboardInsertInput {
            content: Some(content.to_string()),
            content_type: ClipboardContentType::Text,
            content_hash: hash.to_string(),
            preview: content.to_string(),
            metadata: None,
            file_path: None,
            image_data: None,
        }
    }

    fn image_input(content: &str, hash: &str, image_data: Vec<u8>) -> ClipboardInsertInput {
        ClipboardInsertInput {
            content: Some(content.to_string()),
            content_type: ClipboardContentType::Image,
            content_hash: hash.to_string(),
            preview: content.to_string(),
            metadata: None,
            file_path: None,
            image_data: Some(image_data),
        }
    }

    fn fixed_input(title: &str, content: &str, hotkey: &str, enabled: bool) -> FixedContentInput {
        FixedContentInput {
            title: title.to_string(),
            content: content.to_string(),
            hotkey: hotkey.to_string(),
            enabled,
        }
    }

    #[test]
    fn insert_clipboard_item_and_return_existing_duplicate() {
        let repo = repo();

        let first = repo
            .insert_clipboard_item(text_input("hello", "hash-1"))
            .unwrap();
        repo.conn()
            .unwrap()
            .execute(
                "UPDATE clipboard_items SET created_at = 100 WHERE id = ?1",
                rusqlite::params![first.id],
            )
            .unwrap();
        let duplicate = repo
            .insert_clipboard_item(text_input("changed", "hash-1"))
            .unwrap();

        assert_eq!(first.id, duplicate.id);
        assert_eq!(duplicate.content.as_deref(), Some("hello"));
        assert!(
            duplicate.created_at > 100,
            "duplicate captures should refresh the existing item timestamp"
        );
        assert_eq!(repo.get_item_by_id(first.id).unwrap().unwrap().id, first.id);
        assert_eq!(repo.count_items().unwrap(), 1);
    }

    #[test]
    fn update_text_item_clears_file_and_image_data_and_updates_search_index() {
        let repo = repo();
        let item = repo
            .insert_clipboard_item(ClipboardInsertInput {
                content: Some("old needle".to_string()),
                content_type: ClipboardContentType::Text,
                content_hash: "hash-old".to_string(),
                preview: "old needle".to_string(),
                metadata: None,
                file_path: Some(r"C:\Users\xxsby\old.txt".to_string()),
                image_data: Some(vec![1, 2, 3]),
            })
            .unwrap();

        let updated = repo
            .update_text_item(
                item.id,
                "new needle",
                ClipboardContentType::Text,
                "hash-new",
                "new needle",
                ClipboardMetadata::default(),
            )
            .unwrap()
            .unwrap();
        let search_results = repo.search_items("new needle", 10).unwrap();

        assert_eq!(updated.file_path, None);
        assert_eq!(updated.image_data, None);
        assert!(search_results.iter().any(|item| item.id == updated.id));
    }

    #[test]
    fn repository_connection_uses_busy_timeout() {
        let repo = repo();
        let timeout: i64 = repo
            .conn()
            .unwrap()
            .query_row("PRAGMA busy_timeout", [], |row| row.get(0))
            .unwrap();

        assert!(timeout >= 5_000);
    }

    #[test]
    fn get_history_sorts_pinned_first_then_newest() {
        let repo = repo();

        let older = repo
            .insert_clipboard_item(text_input("older", "hash-older"))
            .unwrap();
        let newer = repo
            .insert_clipboard_item(text_input("newer", "hash-newer"))
            .unwrap();
        repo.toggle_pin(older.id).unwrap();

        let history = repo.get_history(10).unwrap();

        assert_eq!(history[0].id, older.id);
        assert_eq!(history[1].id, newer.id);
    }

    #[test]
    fn get_history_returns_image_summaries_without_image_data() {
        let repo = repo();
        let item = repo
            .insert_clipboard_item(image_input("clip.png", "hash-image-summary", vec![1, 2, 3]))
            .unwrap();

        let history = repo.get_history(10).unwrap();
        let summary = history
            .iter()
            .find(|current| current.id == item.id)
            .unwrap();
        let detail = repo.get_item_by_id(item.id).unwrap().unwrap();

        assert_eq!(summary.image_data, None);
        assert_eq!(detail.image_data, Some(vec![1, 2, 3]));
    }

    #[test]
    fn history_summary_does_not_load_clipboard_format_blobs() {
        let repo = repo();
        let item = repo
            .insert_clipboard_item(text_input("hello", "hash-hello"))
            .unwrap();
        repo.insert_clipboard_format(
            item.id,
            &ClipboardFormatInput {
                format_name: "HTML Format".to_string(),
                format_id: Some(49323),
                mime_type: Some("text/html".to_string()),
                encoding: ClipboardFormatEncoding::Binary,
                data: vec![1; 1024],
                data_hash: "format-hash".to_string(),
            },
        )
        .unwrap();

        let history = repo.get_history(10).unwrap();

        assert_eq!(history.len(), 1);
        assert_eq!(
            history[0].metadata.extra.get("hasRichFormats"),
            Some(&json!(true))
        );
        assert_eq!(history[0].image_data, None);

        let formats = repo.list_clipboard_formats(item.id).unwrap();
        assert_eq!(formats.len(), 1);
        assert_eq!(formats[0].data.len(), 1024);
    }

    #[test]
    fn toggles_pin_and_favorite() {
        let repo = repo();
        let item = repo
            .insert_clipboard_item(text_input("item", "hash"))
            .unwrap();

        let pinned = repo.toggle_pin(item.id).unwrap();
        let favorite = repo.toggle_favorite(item.id).unwrap();

        assert!(pinned.is_pinned);
        assert!(favorite.is_favorite);
    }

    #[test]
    fn delete_and_clear_history_respect_favorites() {
        let repo = repo();
        let deleted = repo
            .insert_clipboard_item(text_input("deleted", "hash-deleted"))
            .unwrap();
        let normal = repo
            .insert_clipboard_item(text_input("normal", "hash-normal"))
            .unwrap();
        let favorite = repo
            .insert_clipboard_item(text_input("favorite", "hash-fav"))
            .unwrap();
        repo.toggle_favorite(favorite.id).unwrap();

        repo.delete_item(deleted.id).unwrap();
        let deleted_count = repo.clear_history(false).unwrap();

        let history = repo.get_history(10).unwrap();
        assert_eq!(deleted_count, 1);
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].id, favorite.id);
        assert!(!history.iter().any(|item| item.id == normal.id));
    }

    #[test]
    fn increment_use_stats_updates_count_and_timestamp() {
        let repo = repo();
        let item = repo
            .insert_clipboard_item(text_input("used", "hash-used"))
            .unwrap();

        let used = repo.increment_use_stats(item.id).unwrap();

        assert_eq!(used.use_count, 1);
        assert!(used.last_used_at.is_some());
    }

    #[test]
    fn fixed_contents_round_trip_and_track_usage() {
        let repo = repo();

        let created = repo
            .create_fixed_content(&fixed_input("Topic A", "A", "Ctrl+1", true))
            .unwrap();
        assert_eq!(created.title, "Topic A");
        assert_eq!(created.content, "A");
        assert_eq!(created.hotkey, "Ctrl+1");
        assert!(created.enabled);
        assert_eq!(created.use_count, 0);

        let listed = repo.list_fixed_contents().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, created.id);

        let fetched = repo.get_fixed_content_by_id(created.id).unwrap().unwrap();
        assert_eq!(fetched.id, created.id);

        let updated = repo
            .update_fixed_content(created.id, &fixed_input("Topic B", "B", "Ctrl+2", false))
            .unwrap()
            .unwrap();
        assert_eq!(updated.title, "Topic B");
        assert_eq!(updated.content, "B");
        assert_eq!(updated.hotkey, "Ctrl+2");
        assert!(!updated.enabled);

        let used = repo
            .increment_fixed_content_use_stats(created.id)
            .unwrap()
            .unwrap();
        assert_eq!(used.use_count, 1);
        assert!(used.last_used_at.is_some());

        assert!(repo.delete_fixed_content(created.id).unwrap());
        assert!(repo.list_fixed_contents().unwrap().is_empty());
    }

    #[test]
    fn fixed_content_enabled_hotkeys_are_unique() {
        let repo = repo();
        repo.create_fixed_content(&fixed_input("A", "A", "Ctrl+1", true))
            .unwrap();

        let duplicate = repo
            .create_fixed_content(&fixed_input("B", "B", "Ctrl+1", true))
            .is_err();
        assert!(duplicate);

        let disabled_duplicate = repo
            .create_fixed_content(&fixed_input("C", "C", "Ctrl+1", false))
            .unwrap();
        assert!(!disabled_duplicate.enabled);

        let enabled_duplicate = repo
            .update_fixed_content(
                disabled_duplicate.id,
                &fixed_input("C", "C", "Ctrl+1", true),
            )
            .is_err();
        assert!(enabled_duplicate);
    }

    #[test]
    fn enforce_max_items_deletes_oldest_non_favorite() {
        let repo = repo();
        let oldest = repo
            .insert_clipboard_item(text_input("oldest", "hash-oldest"))
            .unwrap();
        let favorite = repo
            .insert_clipboard_item(text_input("favorite", "hash-favorite"))
            .unwrap();
        repo.toggle_favorite(favorite.id).unwrap();
        let newest = repo
            .insert_clipboard_item(text_input("newest", "hash-newest"))
            .unwrap();

        repo.enforce_max_items(2).unwrap();

        let ids: Vec<i64> = repo
            .get_history(10)
            .unwrap()
            .into_iter()
            .map(|item| item.id)
            .collect();
        assert_eq!(ids.len(), 2);
        assert!(!ids.contains(&oldest.id));
        assert!(ids.contains(&favorite.id));
        assert!(ids.contains(&newest.id));
    }

    #[test]
    fn search_items_finds_content_and_preview() {
        let repo = repo();
        repo.insert_clipboard_item(text_input("alpha needle", "hash-alpha"))
            .unwrap();
        repo.insert_clipboard_item(text_input("beta", "hash-beta"))
            .unwrap();

        let results = repo.search_items("needle", 10).unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].content.as_deref(), Some("alpha needle"));
    }

    #[test]
    fn search_items_falls_back_to_like_for_partial_text() {
        let repo = repo();
        repo.insert_clipboard_item(text_input("alpha needle", "hash-alpha"))
            .unwrap();
        repo.insert_clipboard_item(text_input("beta", "hash-beta"))
            .unwrap();

        let results = repo.search_items("lpha nee", 10).unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].content.as_deref(), Some("alpha needle"));
    }

    #[test]
    fn get_history_tolerates_legacy_rows_with_null_display_fields() {
        let repo = repo();
        {
            let conn = repo.conn().unwrap();
            conn.execute(
                "INSERT INTO clipboard_items
                 (content, content_type, content_hash, preview, metadata, created_at)
                 VALUES (NULL, NULL, NULL, NULL, NULL, 1)",
                [],
            )
            .unwrap();
        }

        let history = repo.get_history(10).unwrap();

        assert_eq!(history.len(), 1);
        assert_eq!(history[0].content_type, ClipboardContentType::Text);
        assert_eq!(history[0].content_hash, "");
        assert_eq!(history[0].preview, "");
    }

    #[test]
    fn settings_round_trip_with_legacy_per_key_rows() {
        let repo = repo();
        assert_eq!(repo.get_settings().unwrap(), AppSettings::default());

        {
            let conn = repo.conn().unwrap();
            conn.execute(
                "INSERT INTO settings (key, value, updated_at)
                 VALUES ('retentionDays', '30', 1),
                        ('imageCompression', '\"medium\"', 1),
                        ('themeMode', '\"dark\"', 1),
                        ('enableSensitiveFilter', 'false', 1)",
                [],
            )
            .unwrap();
        }

        let settings = repo.get_settings().unwrap();
        assert_eq!(settings.retention_days, 30);
        assert_eq!(settings.image_compression, ImageCompression::Medium);
        assert_eq!(settings.theme_mode, ThemeMode::Dark);
        assert!(!settings.enable_sensitive_filter);

        let updated = repo.update_setting("retentionDays", json!(45)).unwrap();
        assert_eq!(updated.retention_days, 45);

        let stored: String = repo
            .conn()
            .unwrap()
            .query_row(
                "SELECT value FROM settings WHERE key = 'retentionDays'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored, "45");
    }

    #[test]
    fn update_setting_rejects_invalid_value_without_storing_it() {
        let repo = repo();

        let error = repo
            .update_setting("retentionDays", json!("not-a-number"))
            .unwrap_err();
        assert!(error.to_string().contains("retentionDays"));
        assert_eq!(repo.get_settings().unwrap().retention_days, 0);

        let max_items_error = repo.update_setting("maxItems", json!(0)).unwrap_err();
        assert!(max_items_error.to_string().contains("maxItems"));
        assert_eq!(repo.get_settings().unwrap().max_items, 10_000);

        let max_items = repo.update_setting("maxItems", json!(1_000_000)).unwrap();
        assert_eq!(max_items.max_items, 1_000_000);

        let image_error = repo
            .update_setting("imageCompression", json!("lossless"))
            .unwrap_err();
        assert!(image_error.to_string().contains("imageCompression"));
        assert_eq!(
            repo.get_settings().unwrap().image_compression,
            ImageCompression::High
        );

        let theme_error = repo
            .update_setting("themeMode", json!("sepia"))
            .unwrap_err();
        assert!(theme_error.to_string().contains("themeMode"));
        assert_eq!(repo.get_settings().unwrap().theme_mode, ThemeMode::System);

        let stored_count: i64 = repo
            .conn()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM settings WHERE key IN ('retentionDays', 'maxItems', 'imageCompression', 'themeMode')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored_count, 1);
    }

    #[test]
    fn hotkeys_round_trip_with_legacy_partial_rows() {
        let repo = repo();
        assert_eq!(
            repo.get_hotkey_settings().unwrap().open_panel,
            "CommandOrControl+Shift+V"
        );

        {
            let conn = repo.conn().unwrap();
            conn.execute(
                "INSERT INTO settings (key, value, updated_at)
                 VALUES ('hotkey_openPanel', 'Alt+Space', 1),
                        ('hotkey_search', '\"Ctrl+F\"', 1)",
                [],
            )
            .unwrap();
        }

        let hotkeys = repo.get_hotkey_settings().unwrap();
        assert_eq!(hotkeys.open_panel, "Alt+Space");
        assert_eq!(hotkeys.search, "Ctrl+F");
        assert_eq!(hotkeys.pause, "CommandOrControl+Shift+P");

        let updated = repo
            .update_hotkey_settings(&HotkeySettingsPatch {
                pause: Some("Alt+P".to_string()),
                ..HotkeySettingsPatch::default()
            })
            .unwrap();
        assert_eq!(updated.open_panel, "Alt+Space");
        assert_eq!(updated.pause, "Alt+P");

        let stored: String = repo
            .conn()
            .unwrap()
            .query_row(
                "SELECT value FROM settings WHERE key = 'hotkey_pause'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored, "\"Alt+P\"");
    }

    #[test]
    fn update_hotkey_settings_rejects_empty_values_without_partial_write() {
        let repo = repo();

        let result = repo.update_hotkey_settings(&HotkeySettingsPatch {
            open_panel: Some("Alt+Space".to_string()),
            pause: Some("   ".to_string()),
            ..HotkeySettingsPatch::default()
        });

        assert!(result.unwrap_err().to_string().contains("hotkey_pause"));
        assert_eq!(
            repo.get_hotkey_settings().unwrap().open_panel,
            "CommandOrControl+Shift+V"
        );

        let stored_count: i64 = repo
            .conn()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM settings WHERE key LIKE 'hotkey_%'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored_count, 0);
    }

    #[test]
    fn blacklist_add_list_remove_and_protect_builtin() {
        let repo = repo();
        let custom = repo
            .add_blacklist_app("Custom", Some("custom.exe"))
            .unwrap();
        let builtin = repo.add_blacklist_app("Builtin", None).unwrap();
        repo.mark_blacklist_builtin_for_test(builtin.id).unwrap();

        let list = repo.list_blacklist_apps().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].app_name, "Builtin");

        assert!(repo.remove_blacklist_app(custom.id).unwrap());
        assert!(!repo.remove_blacklist_app(builtin.id).unwrap());

        let remaining = repo.list_blacklist_apps().unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, builtin.id);
    }

    #[test]
    fn get_history_by_offset_returns_single_item_and_count_items() {
        let repo = repo();
        repo.insert_clipboard_item(text_input("one", "hash-one"))
            .unwrap();
        let two = repo
            .insert_clipboard_item(text_input("two", "hash-two"))
            .unwrap();
        repo.insert_clipboard_item(text_input("three", "hash-three"))
            .unwrap();

        let item = repo.get_history_by_offset(1).unwrap().unwrap();

        assert_eq!(repo.count_items().unwrap(), 3);
        assert_eq!(item.id, two.id);
    }

    #[test]
    fn delete_old_items_removes_only_expired_non_favorites() {
        let repo = repo();
        let old = repo
            .insert_clipboard_item(text_input("old", "hash-old"))
            .unwrap();
        let old_favorite = repo
            .insert_clipboard_item(text_input("old favorite", "hash-old-fav"))
            .unwrap();
        let fresh = repo
            .insert_clipboard_item(text_input("fresh", "hash-fresh"))
            .unwrap();
        repo.toggle_favorite(old_favorite.id).unwrap();

        {
            let conn = repo.conn().unwrap();
            conn.execute(
                "UPDATE clipboard_items SET created_at = ?1 WHERE id IN (?2, ?3)",
                rusqlite::params![1, old.id, old_favorite.id],
            )
            .unwrap();
        }

        let deleted = repo.delete_old_items(7).unwrap();
        let ids: Vec<i64> = repo
            .get_history(10)
            .unwrap()
            .into_iter()
            .map(|item| item.id)
            .collect();

        assert_eq!(deleted, 1);
        assert!(!ids.contains(&old.id));
        assert!(ids.contains(&old_favorite.id));
        assert!(ids.contains(&fresh.id));
    }
}
