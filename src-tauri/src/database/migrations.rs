use std::{path::Path, time::Duration};

use rusqlite::Connection;

use crate::errors::AppResult;

use super::schema::CREATE_SCHEMA_SQL;

pub fn init_database(path: impl AsRef<Path>) -> AppResult<()> {
    let conn = Connection::open(path)?;
    configure_connection(&conn)?;
    conn.execute_batch(CREATE_SCHEMA_SQL)?;
    ensure_fts(&conn)?;
    Ok(())
}

pub(crate) fn configure_connection(conn: &Connection) -> AppResult<()> {
    conn.busy_timeout(Duration::from_secs(5))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    Ok(())
}

fn ensure_fts(conn: &Connection) -> AppResult<()> {
    if fts_needs_repair(conn)? {
        rebuild_fts(conn)?;
    }
    Ok(())
}

const FTS_TRIGGERS: [&str; 3] = [
    "clipboard_items_ai",
    "clipboard_items_ad",
    "clipboard_items_au",
];

fn fts_needs_repair(conn: &Connection) -> AppResult<bool> {
    if !object_exists(conn, "clipboard_fts", "table")? {
        return Ok(true);
    }

    for trigger in FTS_TRIGGERS {
        if !object_exists(conn, trigger, "trigger")? {
            return Ok(true);
        }
    }

    let item_count: i64 =
        conn.query_row("SELECT COUNT(*) FROM clipboard_items", [], |row| row.get(0))?;
    match conn.query_row("SELECT COUNT(*) FROM clipboard_fts", [], |row| {
        row.get::<_, i64>(0)
    }) {
        Ok(fts_count) => Ok(fts_count != item_count),
        Err(_) => Ok(true),
    }
}

fn object_exists(conn: &Connection, name: &str, object_type: &str) -> AppResult<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name = ?1 AND type = ?2)",
        (name, object_type),
        |row| row.get::<_, i64>(0),
    )? == 1)
}

fn rebuild_fts(conn: &Connection) -> AppResult<()> {
    conn.execute_batch("BEGIN IMMEDIATE")?;
    let result = (|| -> AppResult<()> {
        for trigger in FTS_TRIGGERS {
            conn.execute_batch(&format!(
                "DROP TRIGGER IF EXISTS {};",
                quote_identifier(trigger)
            ))?;
        }

        conn.execute_batch("DROP TABLE IF EXISTS clipboard_fts;")?;
        let stale_fts_tables = collect_schema_names(
            conn,
            "SELECT name FROM sqlite_master
             WHERE type = 'table' AND name LIKE 'clipboard_fts_%'",
        )?;
        for table in stale_fts_tables {
            conn.execute_batch(&format!(
                "DROP TABLE IF EXISTS {};",
                quote_identifier(&table)
            ))?;
        }

        conn.execute_batch(
            r#"
CREATE VIRTUAL TABLE clipboard_fts USING fts5(
  content,
  preview,
  tokenize='unicode61'
);

CREATE TRIGGER clipboard_items_ai AFTER INSERT ON clipboard_items BEGIN
  INSERT INTO clipboard_fts(rowid, content, preview)
  VALUES (new.id, COALESCE(new.content, ''), COALESCE(new.preview, ''));
END;

CREATE TRIGGER clipboard_items_ad AFTER DELETE ON clipboard_items BEGIN
  DELETE FROM clipboard_fts WHERE rowid = old.id;
END;

CREATE TRIGGER clipboard_items_au AFTER UPDATE ON clipboard_items BEGIN
  DELETE FROM clipboard_fts WHERE rowid = old.id;
  INSERT INTO clipboard_fts(rowid, content, preview)
  VALUES (new.id, COALESCE(new.content, ''), COALESCE(new.preview, ''));
END;

INSERT INTO clipboard_fts(rowid, content, preview)
SELECT id, COALESCE(content, ''), COALESCE(preview, '')
FROM clipboard_items;
"#,
        )?;
        Ok(())
    })();

    match result {
        Ok(()) => conn.execute_batch("COMMIT")?,
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(error);
        }
    }
    Ok(())
}

fn collect_schema_names(conn: &Connection, sql: &str) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

fn quote_identifier(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;
    use tempfile::tempdir;

    use super::init_database;

    fn object_exists(conn: &Connection, name: &str, object_type: &str) -> bool {
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name = ?1 AND type = ?2)",
            (name, object_type),
            |row| row.get::<_, i64>(0),
        )
        .unwrap()
            == 1
    }

    #[test]
    fn init_database_creates_legacy_compatible_schema() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("clipboard.db");

        init_database(&db_path).unwrap();

        let conn = Connection::open(&db_path).unwrap();
        for table in [
            "clipboard_items",
            "settings",
            "app_blacklist",
            "fixed_contents",
            "clipboard_fts",
        ] {
            assert!(
                object_exists(&conn, table, "table"),
                "missing table {table}"
            );
        }

        let columns: Vec<(String, String, i64, Option<String>, i64)> = conn
            .prepare("PRAGMA table_info(clipboard_items)")
            .unwrap()
            .query_map([], |row| {
                Ok((
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();

        assert_eq!(
            columns,
            vec![
                ("id".into(), "INTEGER".into(), 0, None, 1),
                ("content".into(), "TEXT".into(), 0, None, 0),
                ("content_type".into(), "TEXT".into(), 0, None, 0),
                ("content_hash".into(), "TEXT".into(), 0, None, 0),
                ("preview".into(), "TEXT".into(), 0, None, 0),
                ("metadata".into(), "TEXT".into(), 0, None, 0),
                ("file_path".into(), "TEXT".into(), 0, None, 0),
                ("image_data".into(), "BLOB".into(), 0, None, 0),
                ("created_at".into(), "INTEGER".into(), 1, None, 0),
                ("last_used_at".into(), "INTEGER".into(), 0, None, 0),
                ("use_count".into(), "INTEGER".into(), 0, Some("0".into()), 0),
                ("is_pinned".into(), "INTEGER".into(), 0, Some("0".into()), 0),
                (
                    "is_favorite".into(),
                    "INTEGER".into(),
                    0,
                    Some("0".into()),
                    0
                ),
            ]
        );

        for index in [
            "idx_created_at",
            "idx_content_type",
            "idx_is_pinned",
            "idx_is_favorite",
            "idx_blacklist_unique",
            "idx_fixed_contents_hotkey_enabled",
        ] {
            assert!(
                object_exists(&conn, index, "index"),
                "missing index {index}"
            );
        }

        let unique_indexes: Vec<String> = conn
            .prepare("PRAGMA index_list(clipboard_items)")
            .unwrap()
            .query_map([], |row| {
                let is_unique: i64 = row.get(2)?;
                let name: String = row.get(1)?;
                Ok((name, is_unique))
            })
            .unwrap()
            .filter_map(|row| match row.unwrap() {
                (name, 1) => Some(name),
                _ => None,
            })
            .collect();
        assert!(
            unique_indexes
                .iter()
                .any(|name| name.contains("content_hash")),
            "content_hash should be unique"
        );

        let invalid_enabled = conn.execute(
            "INSERT INTO fixed_contents
             (title, content, hotkey, enabled, created_at, updated_at)
             VALUES ('invalid', 'invalid', 'Ctrl+9', 2, 1, 1)",
            [],
        );
        assert!(
            invalid_enabled.is_err(),
            "fixed_contents.enabled should reject values outside 0/1"
        );

        let null_enabled = conn.execute(
            "INSERT INTO fixed_contents
             (title, content, hotkey, enabled, created_at, updated_at)
             VALUES ('null', 'null', 'Ctrl+0', NULL, 1, 1)",
            [],
        );
        assert!(
            null_enabled.is_err(),
            "fixed_contents.enabled should reject NULL"
        );

        for trigger in [
            "clipboard_items_ai",
            "clipboard_items_ad",
            "clipboard_items_au",
        ] {
            assert!(
                object_exists(&conn, trigger, "trigger"),
                "missing trigger {trigger}"
            );
        }
    }

    #[test]
    fn init_database_repairs_stale_fts_artifacts_and_backfills_rows() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("clipboard.db");
        init_database(&db_path).unwrap();

        let conn = Connection::open(&db_path).unwrap();
        conn.execute(
            "INSERT INTO clipboard_items
             (content, content_type, content_hash, preview, metadata, created_at)
             VALUES ('needle content', 'text', 'hash-needle', 'needle preview', '{}', 1)",
            [],
        )
        .unwrap();
        conn.execute_batch(
            r#"
DROP TRIGGER IF EXISTS clipboard_items_ai;
DROP TRIGGER IF EXISTS clipboard_items_ad;
DROP TRIGGER IF EXISTS clipboard_items_au;
DROP TABLE IF EXISTS clipboard_fts;
CREATE VIRTUAL TABLE clipboard_fts USING fts5(content);
"#,
        )
        .unwrap();
        drop(conn);

        init_database(&db_path).unwrap();

        let conn = Connection::open(&db_path).unwrap();
        for trigger in [
            "clipboard_items_ai",
            "clipboard_items_ad",
            "clipboard_items_au",
        ] {
            assert!(
                object_exists(&conn, trigger, "trigger"),
                "missing repaired trigger {trigger}"
            );
        }

        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM clipboard_fts WHERE clipboard_fts MATCH 'needle'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn init_database_repairs_orphaned_fts_shadow_tables_before_creating_fts() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("clipboard.db");

        let conn = Connection::open(&db_path).unwrap();
        conn.execute_batch(
            r#"
CREATE TABLE clipboard_items (
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

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at INTEGER
);

CREATE TABLE app_blacklist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_name TEXT NOT NULL,
  app_path TEXT,
  is_builtin INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE clipboard_fts_data (
  id INTEGER PRIMARY KEY,
  block BLOB
);

INSERT INTO clipboard_items
  (content, content_type, content_hash, preview, metadata, created_at)
VALUES
  ('orphan needle', 'text', 'hash-orphan', 'orphan needle', '{}', 1);
"#,
        )
        .unwrap();
        drop(conn);

        init_database(&db_path).unwrap();

        let conn = Connection::open(&db_path).unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM clipboard_fts WHERE clipboard_fts MATCH 'orphan'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn init_database_preserves_non_fts_clipboard_item_triggers() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("clipboard.db");

        let conn = Connection::open(&db_path).unwrap();
        conn.execute_batch(
            r#"
CREATE TABLE clipboard_items (
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
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER);
CREATE TABLE app_blacklist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_name TEXT NOT NULL,
  app_path TEXT,
  is_builtin INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE clipboard_item_audit (item_id INTEGER);
CREATE TRIGGER clipboard_items_audit AFTER INSERT ON clipboard_items BEGIN
  INSERT INTO clipboard_item_audit(item_id) VALUES (new.id);
END;
"#,
        )
        .unwrap();
        drop(conn);

        init_database(&db_path).unwrap();

        let conn = Connection::open(&db_path).unwrap();
        assert!(object_exists(&conn, "clipboard_items_audit", "trigger"));
        conn.execute(
            "INSERT INTO clipboard_items
             (content, content_type, content_hash, preview, metadata, created_at)
             VALUES ('audit', 'text', 'hash-audit', 'audit', '{}', 1)",
            [],
        )
        .unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM clipboard_item_audit", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 1);
    }
}
