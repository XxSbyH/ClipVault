use std::path::Path;

use rusqlite::Connection;

use crate::errors::AppResult;

use super::schema::CREATE_SCHEMA_SQL;

pub fn init_database(path: impl AsRef<Path>) -> AppResult<()> {
    let conn = Connection::open(path)?;
    conn.execute_batch(CREATE_SCHEMA_SQL)?;
    rebuild_fts(&conn)?;
    Ok(())
}

fn rebuild_fts(conn: &Connection) -> AppResult<()> {
    let triggers = {
        let mut stmt = conn.prepare(
            "SELECT name FROM sqlite_master
             WHERE type = 'trigger' AND name LIKE 'clipboard_items_%'",
        )?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    conn.execute_batch("BEGIN IMMEDIATE")?;
    let result = (|| -> AppResult<()> {
        for trigger in triggers {
            let escaped = trigger.replace('"', "\"\"");
            conn.execute_batch(&format!("DROP TRIGGER IF EXISTS \"{escaped}\";"))?;
        }

        conn.execute_batch(
            r#"
DROP TABLE IF EXISTS clipboard_fts;

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
}
