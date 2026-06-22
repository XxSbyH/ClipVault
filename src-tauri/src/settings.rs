use serde_json::Value;

use crate::{cleanup, database::repository::Repository, errors::AppResult, models::AppSettings};

pub fn update_setting_with_side_effects(
    repo: &Repository,
    key: &str,
    value: Value,
) -> AppResult<AppSettings> {
    let settings = repo.update_setting(key, value)?;

    match key {
        "retentionDays" => {
            cleanup::run_cleanup_now(repo, &settings)?;
        }
        "maxItems" => {
            repo.enforce_max_items(i64::from(settings.max_items))?;
        }
        _ => {}
    }

    Ok(settings)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use rusqlite::Connection;
    use serde_json::json;
    use tempfile::tempdir;
    use tempfile::TempDir;

    use crate::{
        database::repository::Repository,
        models::{ClipboardContentType, ClipboardInsertInput},
    };

    fn repo() -> (TempDir, PathBuf, Repository) {
        let dir = tempdir().unwrap();
        let path = dir.path().join("clipboard.db");
        let repo = Repository::open(&path).unwrap();
        (dir, path, repo)
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
    fn settings_update_retention_days_runs_cleanup_side_effect() {
        let (_dir, path, repo) = repo();
        let expired = repo
            .insert_clipboard_item(text_input("expired", "hash-expired"))
            .unwrap();
        repo.insert_clipboard_item(text_input("fresh", "hash-fresh"))
            .unwrap();
        {
            let conn = Connection::open(path).unwrap();
            conn.execute(
                "UPDATE clipboard_items SET created_at = 1 WHERE id = ?1",
                rusqlite::params![expired.id],
            )
            .unwrap();
        }

        let settings =
            super::update_setting_with_side_effects(&repo, "retentionDays", json!(7)).unwrap();

        assert_eq!(settings.retention_days, 7);
        assert_eq!(repo.count_items().unwrap(), 1);
    }

    #[test]
    fn settings_update_max_items_does_not_delete_expired_items_within_limit() {
        let (_dir, path, repo) = repo();
        let expired = repo
            .insert_clipboard_item(text_input("expired", "hash-expired"))
            .unwrap();
        repo.insert_clipboard_item(text_input("fresh", "hash-fresh"))
            .unwrap();
        {
            let conn = Connection::open(path).unwrap();
            conn.execute(
                "UPDATE clipboard_items SET created_at = 1 WHERE id = ?1",
                rusqlite::params![expired.id],
            )
            .unwrap();
        }

        let settings =
            super::update_setting_with_side_effects(&repo, "maxItems", json!(10_000)).unwrap();

        assert_eq!(settings.max_items, 10_000);
        assert_eq!(repo.count_items().unwrap(), 2);
    }

    #[test]
    fn settings_update_max_items_rejects_zero_without_deleting_history() {
        let (_dir, _path, repo) = repo();
        repo.insert_clipboard_item(text_input("one", "hash-one"))
            .unwrap();
        repo.insert_clipboard_item(text_input("two", "hash-two"))
            .unwrap();

        let result = super::update_setting_with_side_effects(&repo, "maxItems", json!(0));

        assert!(result.unwrap_err().to_string().contains("maxItems"));
        assert_eq!(repo.count_items().unwrap(), 2);
        assert_eq!(repo.get_settings().unwrap().max_items, 10_000);
    }

    #[test]
    fn settings_update_max_items_allows_one_million_without_deleting_history() {
        let (_dir, _path, repo) = repo();
        repo.insert_clipboard_item(text_input("one", "hash-one"))
            .unwrap();
        repo.insert_clipboard_item(text_input("two", "hash-two"))
            .unwrap();

        let settings =
            super::update_setting_with_side_effects(&repo, "maxItems", json!(1_000_000)).unwrap();

        assert_eq!(settings.max_items, 1_000_000);
        assert_eq!(repo.count_items().unwrap(), 2);
    }
}
