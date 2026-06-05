use std::path::Path;

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

    let backup_path = old_path.with_extension(format!(
        "{}.bak",
        old_path
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or("db")
    ));
    std::fs::copy(old_path, backup_path)?;
    std::fs::copy(old_path, new_path)?;
    init_database(new_path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;
    use tempfile::tempdir;

    use crate::database::migrations::init_database;

    use super::migrate_legacy_database;

    fn create_old_database(path: &std::path::Path) {
        init_database(path).unwrap();
        let conn = Connection::open(path).unwrap();
        conn.execute(
            "INSERT INTO clipboard_items (content, content_type, content_hash, preview, metadata, created_at, is_pinned, is_favorite)
             VALUES ('pinned', 'text', 'hash-pinned', 'pinned', '{}', 1, 1, 0),
                    ('favorite', 'text', 'hash-favorite', 'favorite', '{}', 2, 0, 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO settings (key, value, updated_at) VALUES ('retention_days', '30', 3)",
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
        assert!(old_path.with_extension("db.bak").exists());
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
                "SELECT value FROM settings WHERE key = 'retention_days'",
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
    }
}
