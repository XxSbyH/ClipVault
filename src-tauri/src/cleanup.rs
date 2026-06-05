use serde::{Deserialize, Serialize};

use crate::{database::repository::Repository, errors::AppResult, models::AppSettings};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupReport {
    pub retention_days: u32,
    pub max_items: u32,
    pub deleted_old_items: usize,
    pub before_count: i64,
    pub after_count: i64,
}

pub fn run_cleanup_now(repo: &Repository, settings: &AppSettings) -> AppResult<CleanupReport> {
    let before_count = repo.count_items()?;
    let deleted_old_items = repo.delete_old_items(settings.retention_days)?;
    repo.enforce_max_items(i64::from(settings.max_items))?;
    let after_count = repo.count_items()?;

    Ok(CleanupReport {
        retention_days: settings.retention_days,
        max_items: settings.max_items,
        deleted_old_items,
        before_count,
        after_count,
    })
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use rusqlite::Connection;
    use tempfile::tempdir;
    use tempfile::TempDir;

    use crate::{
        database::repository::Repository,
        models::{AppSettings, ClipboardContentType, ClipboardInsertInput},
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
    fn cleanup_deletes_expired_items_and_enforces_max_items() {
        let (_dir, path, repo) = repo();
        let old = repo
            .insert_clipboard_item(text_input("old", "hash-old"))
            .unwrap();
        let kept = repo
            .insert_clipboard_item(text_input("kept", "hash-kept"))
            .unwrap();
        let overflow = repo
            .insert_clipboard_item(text_input("overflow", "hash-overflow"))
            .unwrap();
        {
            let conn = Connection::open(path).unwrap();
            conn.execute(
                "UPDATE clipboard_items SET created_at = 1 WHERE id = ?1",
                rusqlite::params![old.id],
            )
            .unwrap();
        }

        let report = super::run_cleanup_now(
            &repo,
            &AppSettings {
                retention_days: 7,
                max_items: 1,
                ..AppSettings::default()
            },
        )
        .unwrap();
        let ids: Vec<i64> = repo
            .get_history(10)
            .unwrap()
            .into_iter()
            .map(|item| item.id)
            .collect();

        assert_eq!(report.deleted_old_items, 1);
        assert_eq!(ids, vec![overflow.id]);
        assert!(!ids.contains(&old.id));
        assert!(!ids.contains(&kept.id));
    }
}
