import type Database from 'better-sqlite3';
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/types';
import {
  CREATE_BLACKLIST_TABLE,
  CREATE_CLIPBOARD_ITEMS_TABLE,
  CREATE_FTS_TABLE,
  CREATE_FTS_TRIGGERS,
  CREATE_INDEXES,
  CREATE_SETTINGS_TABLE
} from './schema';

const BUILTIN_BLACKLIST = ['LastPass', '1Password', 'Bitwarden', 'KeePass'];

export function runMigrations(db: Database.Database): void {
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec(CREATE_CLIPBOARD_ITEMS_TABLE);
  db.exec(CREATE_SETTINGS_TABLE);
  db.exec(CREATE_BLACKLIST_TABLE);
  for (const sql of CREATE_INDEXES) {
    db.exec(sql);
  }
  rebuildFtsArtifacts(db);
  seedDefaultSettings(db, DEFAULT_SETTINGS);
  seedBuiltinBlacklist(db);
}

function rebuildFtsArtifacts(db: Database.Database): void {
  const tx = db.transaction(() => {
    const triggers = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'clipboard_items_%'`)
      .all() as Array<{ name: string }>;

    for (const trigger of triggers) {
      const escapedName = trigger.name.replace(/"/g, '""');
      db.exec(`DROP TRIGGER IF EXISTS "${escapedName}";`);
    }

    db.exec('DROP TABLE IF EXISTS clipboard_fts;');
    db.exec(CREATE_FTS_TABLE);
    for (const sql of CREATE_FTS_TRIGGERS) {
      db.exec(sql);
    }

    db.exec(`
      INSERT INTO clipboard_fts(rowid, content, preview)
      SELECT id, COALESCE(content, ''), COALESCE(preview, '')
      FROM clipboard_items
    `);
  });

  tx();
}

function seedDefaultSettings(db: Database.Database, settings: AppSettings): void {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO settings (key, value, updated_at)
    VALUES (@key, @value, @updatedAt)
  `);

  const now = Date.now();
  const tx = db.transaction(() => {
    (Object.keys(settings) as Array<keyof AppSettings>).forEach((key) => {
      const value = settings[key];
      insert.run({
        key,
        value: JSON.stringify(value),
        updatedAt: now
      });
    });
  });
  tx();
}

function seedBuiltinBlacklist(db: Database.Database): void {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO app_blacklist (app_name, app_path, is_builtin, created_at)
    VALUES (@appName, NULL, 1, @createdAt)
  `);
  const now = Date.now();
  const tx = db.transaction(() => {
    BUILTIN_BLACKLIST.forEach((appName) => {
      stmt.run({ appName, createdAt: now });
    });
  });
  tx();
}
