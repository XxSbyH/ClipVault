export const CREATE_CLIPBOARD_ITEMS_TABLE = `
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
);`;

export const CREATE_SETTINGS_TABLE = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at INTEGER
);`;

export const CREATE_BLACKLIST_TABLE = `
CREATE TABLE IF NOT EXISTS app_blacklist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_name TEXT NOT NULL,
  app_path TEXT,
  is_builtin INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);`;

export const CREATE_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_created_at ON clipboard_items(created_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_content_type ON clipboard_items(content_type);`,
  `CREATE INDEX IF NOT EXISTS idx_is_pinned ON clipboard_items(is_pinned);`,
  `CREATE INDEX IF NOT EXISTS idx_is_favorite ON clipboard_items(is_favorite);`,
  `CREATE INDEX IF NOT EXISTS idx_content_hash ON clipboard_items(content_hash);`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_blacklist_unique ON app_blacklist(app_name, is_builtin);`
];

export const CREATE_FTS_TABLE = `
CREATE VIRTUAL TABLE IF NOT EXISTS clipboard_fts USING fts5(
  content,
  preview,
  tokenize='unicode61'
);`;

export const CREATE_FTS_TRIGGERS = [
  `CREATE TRIGGER IF NOT EXISTS clipboard_items_ai AFTER INSERT ON clipboard_items BEGIN
    INSERT INTO clipboard_fts(rowid, content, preview)
    VALUES (new.id, coalesce(new.content, ''), coalesce(new.preview, ''));
  END;`,
  `CREATE TRIGGER IF NOT EXISTS clipboard_items_ad AFTER DELETE ON clipboard_items BEGIN
    DELETE FROM clipboard_fts WHERE rowid = old.id;
  END;`,
  `CREATE TRIGGER IF NOT EXISTS clipboard_items_au AFTER UPDATE ON clipboard_items BEGIN
    DELETE FROM clipboard_fts WHERE rowid = old.id;
    INSERT INTO clipboard_fts(rowid, content, preview)
    VALUES (new.id, coalesce(new.content, ''), coalesce(new.preview, ''));
  END;`
];
