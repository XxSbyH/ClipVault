pub const CLIPBOARD_ITEMS_TABLE: &str = "clipboard_items";
pub const SETTINGS_TABLE: &str = "settings";
pub const APP_BLACKLIST_TABLE: &str = "app_blacklist";
pub const CLIPBOARD_FTS_TABLE: &str = "clipboard_fts";

pub const CREATE_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS clipboard_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT,
  content_type TEXT,
  content_hash TEXT UNIQUE,
  preview TEXT,
  metadata TEXT,
  file_path TEXT,
  image_data BLOB,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  use_count INTEGER DEFAULT 0,
  is_pinned INTEGER DEFAULT 0,
  is_favorite INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_created_at ON clipboard_items(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_content_type ON clipboard_items(content_type);
CREATE INDEX IF NOT EXISTS idx_is_pinned ON clipboard_items(is_pinned);
CREATE INDEX IF NOT EXISTS idx_is_favorite ON clipboard_items(is_favorite);
CREATE UNIQUE INDEX IF NOT EXISTS idx_content_hash_unique ON clipboard_items(content_hash);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS app_blacklist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_name TEXT,
  app_path TEXT,
  is_builtin INTEGER DEFAULT 0,
  created_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_blacklist_unique ON app_blacklist(app_name, is_builtin);
"#;
