use std::{
    path::Path,
    sync::{Arc, Mutex, MutexGuard},
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::{params, Connection, OptionalExtension};

use crate::database::migrations::init_database;
use crate::{
    errors::AppResult,
    models::{
        AppSettings, BlacklistApp, ClipboardContentType, ClipboardInsertInput, ClipboardItem,
        HotkeySettings,
    },
};

pub struct Repository {
    conn: Arc<Mutex<Connection>>,
}

impl Repository {
    pub fn open(path: impl AsRef<Path>) -> AppResult<Self> {
        init_database(&path)?;
        let conn = Connection::open(path)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    pub fn insert_item(&self, input: ClipboardInsertInput) -> AppResult<ClipboardItem> {
        let conn = self.conn()?;
        if let Some(existing) = self.get_item_by_hash_locked(&conn, &input.content_hash)? {
            return Ok(existing);
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

    pub fn get_history(&self, limit: i64) -> AppResult<Vec<ClipboardItem>> {
        let conn = self.conn()?;
        query_items(
            &conn,
            "SELECT * FROM clipboard_items
             ORDER BY is_pinned DESC, created_at DESC, id DESC
             LIMIT ?1",
            params![limit],
        )
    }

    pub fn get_history_by_offset(&self, limit: i64, offset: i64) -> AppResult<Vec<ClipboardItem>> {
        let conn = self.conn()?;
        query_items(
            &conn,
            "SELECT * FROM clipboard_items
             ORDER BY is_pinned DESC, created_at DESC, id DESC
             LIMIT ?1 OFFSET ?2",
            params![limit, offset],
        )
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

    pub fn clear_history(&self, include_favorites: bool) -> AppResult<()> {
        let conn = self.conn()?;
        if include_favorites {
            conn.execute("DELETE FROM clipboard_items", [])?;
        } else {
            conn.execute("DELETE FROM clipboard_items WHERE is_favorite = 0", [])?;
        }
        Ok(())
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

    pub fn search_items(&self, query: &str, limit: i64) -> AppResult<Vec<ClipboardItem>> {
        let conn = self.conn()?;
        let fts_query = query.replace('"', "\"\"");
        let fts = query_items(
            &conn,
            "SELECT clipboard_items.* FROM clipboard_items
             JOIN clipboard_fts ON clipboard_fts.rowid = clipboard_items.id
             WHERE clipboard_fts MATCH ?1
             ORDER BY is_pinned DESC, created_at DESC, id DESC
             LIMIT ?2",
            params![fts_query, limit],
        );

        match fts {
            Ok(items) => Ok(items),
            Err(_) => {
                let like = format!("%{query}%");
                query_items(
                    &conn,
                    "SELECT * FROM clipboard_items
                     WHERE content LIKE ?1 OR preview LIKE ?1
                     ORDER BY is_pinned DESC, created_at DESC, id DESC
                     LIMIT ?2",
                    params![like, limit],
                )
            }
        }
    }

    pub fn get_settings(&self) -> AppResult<AppSettings> {
        self.get_json_setting("app_settings")
    }

    pub fn update_settings(&self, settings: &AppSettings) -> AppResult<()> {
        self.update_json_setting("app_settings", settings)
    }

    pub fn get_hotkey_settings(&self) -> AppResult<HotkeySettings> {
        self.get_json_setting("hotkey_settings")
    }

    pub fn update_hotkey_settings(&self, settings: &HotkeySettings) -> AppResult<()> {
        self.update_json_setting("hotkey_settings", settings)
    }

    pub fn list_blacklist(&self) -> AppResult<Vec<BlacklistApp>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, app_name, app_path, is_builtin, created_at
             FROM app_blacklist
             ORDER BY id ASC",
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

    fn get_json_setting<T>(&self, key: &str) -> AppResult<T>
    where
        T: Default + serde::de::DeserializeOwned,
    {
        let conn = self.conn()?;
        let value = conn
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                params![key],
                |row| row.get::<_, String>(0),
            )
            .optional()?;

        match value {
            Some(value) => Ok(serde_json::from_str(&value)?),
            None => Ok(T::default()),
        }
    }

    fn update_json_setting<T>(&self, key: &str, value: &T) -> AppResult<()>
    where
        T: serde::Serialize,
    {
        let conn = self.conn()?;
        conn.execute(
            "INSERT INTO settings (key, value, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![key, serde_json::to_string(value)?, now_timestamp()],
        )?;
        Ok(())
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

fn map_clipboard_item(row: &rusqlite::Row<'_>) -> rusqlite::Result<ClipboardItem> {
    let metadata_json = row
        .get::<_, Option<String>>("metadata")?
        .unwrap_or_else(|| "{}".to_string());
    let metadata = serde_json::from_str(&metadata_json).unwrap_or_default();
    let content_type: String = row.get("content_type")?;

    Ok(ClipboardItem {
        id: row.get("id")?,
        content: row.get("content")?,
        content_type: content_type_from_db(&content_type),
        content_hash: row.get("content_hash")?,
        preview: row.get("preview")?,
        metadata,
        file_path: row.get("file_path")?,
        image_data: row.get("image_data")?,
        created_at: row.get("created_at")?,
        last_used_at: row.get("last_used_at")?,
        use_count: row.get("use_count")?,
        is_pinned: row.get::<_, i64>("is_pinned")? == 1,
        is_favorite: row.get::<_, i64>("is_favorite")? == 1,
    })
}

fn map_blacklist_app(row: &rusqlite::Row<'_>) -> rusqlite::Result<BlacklistApp> {
    Ok(BlacklistApp {
        id: row.get("id")?,
        app_name: row.get("app_name")?,
        app_path: row.get("app_path")?,
        is_builtin: row.get::<_, i64>("is_builtin")? == 1,
        created_at: row.get("created_at")?,
    })
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

    use crate::models::{
        AppSettings, ClipboardContentType, ClipboardInsertInput, HotkeySettings, ImageCompression,
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

    #[test]
    fn insert_text_item_and_return_existing_duplicate() {
        let repo = repo();

        let first = repo.insert_item(text_input("hello", "hash-1")).unwrap();
        let duplicate = repo.insert_item(text_input("changed", "hash-1")).unwrap();

        assert_eq!(first.id, duplicate.id);
        assert_eq!(duplicate.content.as_deref(), Some("hello"));
        assert_eq!(repo.count_items().unwrap(), 1);
    }

    #[test]
    fn get_history_sorts_pinned_first_then_newest() {
        let repo = repo();

        let older = repo.insert_item(text_input("older", "hash-older")).unwrap();
        let newer = repo.insert_item(text_input("newer", "hash-newer")).unwrap();
        repo.toggle_pin(older.id).unwrap();

        let history = repo.get_history(10).unwrap();

        assert_eq!(history[0].id, older.id);
        assert_eq!(history[1].id, newer.id);
    }

    #[test]
    fn toggles_pin_and_favorite() {
        let repo = repo();
        let item = repo.insert_item(text_input("item", "hash")).unwrap();

        let pinned = repo.toggle_pin(item.id).unwrap();
        let favorite = repo.toggle_favorite(item.id).unwrap();

        assert!(pinned.is_pinned);
        assert!(favorite.is_favorite);
    }

    #[test]
    fn delete_and_clear_history_respect_favorites() {
        let repo = repo();
        let deleted = repo
            .insert_item(text_input("deleted", "hash-deleted"))
            .unwrap();
        let normal = repo
            .insert_item(text_input("normal", "hash-normal"))
            .unwrap();
        let favorite = repo
            .insert_item(text_input("favorite", "hash-fav"))
            .unwrap();
        repo.toggle_favorite(favorite.id).unwrap();

        repo.delete_item(deleted.id).unwrap();
        repo.clear_history(false).unwrap();

        let history = repo.get_history(10).unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].id, favorite.id);
        assert!(!history.iter().any(|item| item.id == normal.id));
    }

    #[test]
    fn increment_use_stats_updates_count_and_timestamp() {
        let repo = repo();
        let item = repo.insert_item(text_input("used", "hash-used")).unwrap();

        let used = repo.increment_use_stats(item.id).unwrap();

        assert_eq!(used.use_count, 1);
        assert!(used.last_used_at.is_some());
    }

    #[test]
    fn enforce_max_items_deletes_oldest_non_favorite() {
        let repo = repo();
        let oldest = repo
            .insert_item(text_input("oldest", "hash-oldest"))
            .unwrap();
        let favorite = repo
            .insert_item(text_input("favorite", "hash-favorite"))
            .unwrap();
        repo.toggle_favorite(favorite.id).unwrap();
        let newest = repo
            .insert_item(text_input("newest", "hash-newest"))
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
        repo.insert_item(text_input("alpha needle", "hash-alpha"))
            .unwrap();
        repo.insert_item(text_input("beta", "hash-beta")).unwrap();

        let results = repo.search_items("needle", 10).unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].content.as_deref(), Some("alpha needle"));
    }

    #[test]
    fn settings_and_hotkeys_round_trip_with_defaults() {
        let repo = repo();
        assert_eq!(repo.get_settings().unwrap(), AppSettings::default());
        assert_eq!(
            repo.get_hotkey_settings().unwrap(),
            HotkeySettings::default()
        );

        let mut settings = AppSettings::default();
        settings.retention_days = 30;
        settings.image_compression = ImageCompression::Medium;
        repo.update_settings(&settings).unwrap();

        let mut hotkeys = HotkeySettings::default();
        hotkeys.open_panel = "Alt+Space".to_string();
        repo.update_hotkey_settings(&hotkeys).unwrap();

        assert_eq!(repo.get_settings().unwrap(), settings);
        assert_eq!(repo.get_hotkey_settings().unwrap(), hotkeys);
    }

    #[test]
    fn blacklist_add_list_remove_and_protect_builtin() {
        let repo = repo();
        let custom = repo
            .add_blacklist_app("Custom", Some("custom.exe"))
            .unwrap();
        let builtin = repo.add_blacklist_app("Builtin", None).unwrap();
        repo.mark_blacklist_builtin_for_test(builtin.id).unwrap();

        let list = repo.list_blacklist().unwrap();
        assert_eq!(list.len(), 2);

        assert!(repo.remove_blacklist_app(custom.id).unwrap());
        assert!(!repo.remove_blacklist_app(builtin.id).unwrap());

        let remaining = repo.list_blacklist().unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, builtin.id);
    }

    #[test]
    fn get_history_by_offset_and_count_items() {
        let repo = repo();
        repo.insert_item(text_input("one", "hash-one")).unwrap();
        let two = repo.insert_item(text_input("two", "hash-two")).unwrap();
        repo.insert_item(text_input("three", "hash-three")).unwrap();

        let page = repo.get_history_by_offset(1, 1).unwrap();

        assert_eq!(repo.count_items().unwrap(), 3);
        assert_eq!(page.len(), 1);
        assert_eq!(page[0].id, two.id);
    }
}
