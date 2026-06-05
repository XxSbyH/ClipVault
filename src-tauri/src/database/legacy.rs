use std::{
    fs::OpenOptions,
    io::ErrorKind,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::{Connection, DatabaseName};

use crate::errors::AppResult;

use super::migrations::init_database;

pub fn migrate_legacy_database(
    old_path: impl AsRef<Path>,
    new_path: impl AsRef<Path>,
) -> AppResult<()> {
    let old_path = old_path.as_ref();
    let new_path = new_path.as_ref();

    if new_path.exists() || !old_path.exists() {
        return Ok(());
    }

    if let Some(parent) = new_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let source = Connection::open(old_path)?;
    source.busy_timeout(std::time::Duration::from_secs(5))?;

    let backup_path = reserve_unique_backup_path(old_path)?;
    if let Err(error) = backup_sqlite_database(&source, &backup_path) {
        let _ = std::fs::remove_file(&backup_path);
        return Err(error);
    }

    let temp_new_path = reserve_unique_temp_path(new_path)?;
    let migration = (|| -> AppResult<()> {
        backup_sqlite_database(&source, &temp_new_path)?;
        init_database(&temp_new_path)?;
        Ok(())
    })();

    if let Err(error) = migration {
        let _ = std::fs::remove_file(&temp_new_path);
        return Err(error);
    }

    std::fs::rename(&temp_new_path, new_path)?;
    Ok(())
}

fn backup_sqlite_database(source: &Connection, destination: &Path) -> AppResult<()> {
    source.backup(DatabaseName::Main, destination, None)?;
    Ok(())
}

fn reserve_unique_backup_path(path: &Path) -> AppResult<PathBuf> {
    reserve_unique_sidecar_path(path, "bak")
}

fn reserve_unique_temp_path(path: &Path) -> AppResult<PathBuf> {
    reserve_unique_sidecar_path(path, "tmp")
}

fn reserve_unique_sidecar_path(path: &Path, extension: &str) -> AppResult<PathBuf> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let pid = std::process::id();
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("clipboard.db");

    for attempt in 0..1000 {
        let candidate = path.with_file_name(format!(
            "{file_name}.{timestamp}.{pid}.{attempt}.{extension}"
        ));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(_) => return Ok(candidate),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.into()),
        }
    }

    Err(format!(
        "unable to reserve unique {extension} path for {}",
        path.display()
    )
    .into())
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;
    use tempfile::tempdir;

    use crate::database::{migrations::init_database, repository::Repository};

    use super::{migrate_legacy_database, reserve_unique_backup_path};

    fn create_old_database(path: &std::path::Path) {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(
            r#"
CREATE TABLE IF NOT EXISTS clipboard_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT,
  content_type TEXT NOT NULL,
  content_hash TEXT UNIQUE NOT NULL,
  preview TEXT NOT NULL,
  metadata TEXT,
  file_path TEXT,
  image_data BLOB,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  use_count INTEGER DEFAULT 0,
  is_pinned INTEGER DEFAULT 0,
  is_favorite INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS app_blacklist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_name TEXT NOT NULL,
  app_path TEXT,
  is_builtin INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_created_at ON clipboard_items(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_content_type ON clipboard_items(content_type);
CREATE INDEX IF NOT EXISTS idx_is_pinned ON clipboard_items(is_pinned);
CREATE INDEX IF NOT EXISTS idx_is_favorite ON clipboard_items(is_favorite);
CREATE INDEX IF NOT EXISTS idx_content_hash ON clipboard_items(content_hash);
CREATE UNIQUE INDEX IF NOT EXISTS idx_blacklist_unique ON app_blacklist(app_name, is_builtin);

CREATE VIRTUAL TABLE IF NOT EXISTS clipboard_fts USING fts5(
  content,
  preview,
  tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS clipboard_items_ai AFTER INSERT ON clipboard_items BEGIN
  INSERT INTO clipboard_fts(rowid, content, preview)
  VALUES (new.id, coalesce(new.content, ''), coalesce(new.preview, ''));
END;

CREATE TRIGGER IF NOT EXISTS clipboard_items_ad AFTER DELETE ON clipboard_items BEGIN
  DELETE FROM clipboard_fts WHERE rowid = old.id;
END;

CREATE TRIGGER IF NOT EXISTS clipboard_items_au AFTER UPDATE ON clipboard_items BEGIN
  DELETE FROM clipboard_fts WHERE rowid = old.id;
  INSERT INTO clipboard_fts(rowid, content, preview)
  VALUES (new.id, coalesce(new.content, ''), coalesce(new.preview, ''));
END;
"#,
        )
        .unwrap();
        conn.execute(
            "INSERT INTO clipboard_items (content, content_type, content_hash, preview, metadata, created_at, is_pinned, is_favorite)
             VALUES ('pinned', 'text', 'hash-pinned', 'pinned', '{}', 1, 1, 0),
                    ('favorite', 'text', 'hash-favorite', 'favorite', '{}', 2, 0, 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO settings (key, value, updated_at)
             VALUES ('retentionDays', '30', 3),
                    ('hotkey_openPanel', '\"Alt+Space\"', 3)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO app_blacklist (app_name, app_path, is_builtin, created_at) VALUES ('LegacyApp', 'legacy.exe', 1, 4)",
            [],
        )
        .unwrap();
    }

    #[test]
    fn new_database_exists_is_noop() {
        let dir = tempdir().unwrap();
        let old_path = dir.path().join("old.db");
        let new_path = dir.path().join("new.db");
        create_old_database(&old_path);
        init_database(&new_path).unwrap();
        let marker = Connection::open(&new_path).unwrap();
        marker
            .execute(
                "INSERT INTO settings (key, value, updated_at) VALUES ('marker', 'keep', 1)",
                [],
            )
            .unwrap();
        drop(marker);

        migrate_legacy_database(&old_path, &new_path).unwrap();

        let conn = Connection::open(&new_path).unwrap();
        let value: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'marker'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(value, "keep");
    }

    #[test]
    fn old_database_is_copied_backed_up_and_migrated() {
        let dir = tempdir().unwrap();
        let old_path = dir.path().join("clipboard.db");
        let new_path = dir.path().join("new-clipboard.db");
        create_old_database(&old_path);

        migrate_legacy_database(&old_path, &new_path).unwrap();

        assert!(old_path.exists());
        let backups: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with("clipboard.db.") && name.ends_with(".bak"))
            .collect();
        assert_eq!(backups.len(), 1);
        assert!(new_path.exists());

        let conn = Connection::open(&new_path).unwrap();
        let pinned: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM clipboard_items WHERE is_pinned = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let favorite: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM clipboard_items WHERE is_favorite = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let setting: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'retentionDays'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let blacklist: i64 = conn
            .query_row("SELECT COUNT(*) FROM app_blacklist", [], |row| row.get(0))
            .unwrap();

        assert_eq!(pinned, 1);
        assert_eq!(favorite, 1);
        assert_eq!(setting, "30");
        assert_eq!(blacklist, 1);
        drop(conn);

        let repo = Repository::open(&new_path).unwrap();
        assert_eq!(repo.get_settings().unwrap().retention_days, 30);
        assert_eq!(repo.get_hotkey_settings().unwrap().open_panel, "Alt+Space");
    }

    #[test]
    fn migration_captures_committed_wal_rows() {
        let dir = tempdir().unwrap();
        let old_path = dir.path().join("clipboard.db");
        let new_path = dir.path().join("new-clipboard.db");
        create_old_database(&old_path);

        let conn = Connection::open(&old_path).unwrap();
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        conn.pragma_update(None, "wal_autocheckpoint", 0).unwrap();
        conn.execute(
            "INSERT INTO clipboard_items
             (content, content_type, content_hash, preview, metadata, created_at)
             VALUES ('wal-only', 'text', 'hash-wal-only', 'wal-only', '{}', 5)",
            [],
        )
        .unwrap();

        migrate_legacy_database(&old_path, &new_path).unwrap();

        let migrated = Connection::open(&new_path).unwrap();
        let count: i64 = migrated
            .query_row(
                "SELECT COUNT(*) FROM clipboard_items WHERE content_hash = 'hash-wal-only'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
        drop(conn);
    }

    #[test]
    fn backup_path_reservation_never_overwrites_existing_backup() {
        let dir = tempdir().unwrap();
        let old_path = dir.path().join("clipboard.db");

        let first = reserve_unique_backup_path(&old_path).unwrap();
        std::fs::write(&first, b"first backup").unwrap();
        let second = reserve_unique_backup_path(&old_path).unwrap();

        assert_ne!(first, second);
        assert_eq!(std::fs::read(&first).unwrap(), b"first backup");
        assert!(second.exists());
    }

    #[test]
    fn failed_migration_does_not_leave_final_new_database() {
        let dir = tempdir().unwrap();
        let old_path = dir.path().join("clipboard.db");
        let new_path = dir.path().join("new-clipboard.db");
        std::fs::write(&old_path, b"not a sqlite database").unwrap();

        assert!(migrate_legacy_database(&old_path, &new_path).is_err());
        assert!(!new_path.exists());
    }
}
