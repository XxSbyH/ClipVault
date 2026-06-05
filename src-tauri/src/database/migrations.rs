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
    conn.execute(
        "INSERT INTO clipboard_fts(clipboard_fts) VALUES('rebuild')",
        [],
    )?;
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
}
