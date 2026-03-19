import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { app } from 'electron';
import {
  DEFAULT_HOTKEYS,
  DEFAULT_SETTINGS,
  type AppSettings,
  type BlacklistApp,
  type ClipboardInsertInput,
  type ClipboardItem,
  type HotkeySettings
} from '@shared/types';
import { logger } from '../logger/logger';
import { runMigrations } from './migrations';
import { CREATE_FTS_TABLE, CREATE_FTS_TRIGGERS } from './schema';

interface ClipboardRow {
  id: number;
  content: string | null;
  content_type: string;
  content_hash: string;
  preview: string;
  metadata: string | null;
  file_path: string | null;
  image_data?: Uint8Array | null;
  created_at: number;
  last_used_at: number | null;
  use_count: number;
  is_pinned: number;
  is_favorite: number;
}

interface BlacklistRow {
  id: number;
  app_name: string;
  app_path: string | null;
  is_builtin: number;
  created_at: number;
}

let db: Database.Database | null = null;
let dbPath = '';
const HOTKEY_KEYS: Array<keyof HotkeySettings> = [
  'openPanel',
  'search',
  'pause',
  'clear',
  'quickPastePrev',
  'quickPasteNext'
];

function ensureDb(): Database.Database {
  if (!db) {
    throw new Error('数据库尚未初始化');
  }
  return db;
}

function parseMetadata(raw: string | null): ClipboardItem['metadata'] {
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as ClipboardItem['metadata'];
    return parsed ?? {};
  } catch {
    return {};
  }
}

const CLIPBOARD_COLUMNS =
  'id, content, content_type, content_hash, preview, metadata, file_path, created_at, last_used_at, use_count, is_pinned, is_favorite';
const CLIPBOARD_COLUMNS_WITH_ALIAS =
  'c.id, c.content, c.content_type, c.content_hash, c.preview, c.metadata, c.file_path, c.created_at, c.last_used_at, c.use_count, c.is_pinned, c.is_favorite';

function mapClipboardRow(row: ClipboardRow, includeImageData = false): ClipboardItem {
  return {
    id: row.id,
    content: row.content,
    contentType: row.content_type as ClipboardItem['contentType'],
    contentHash: row.content_hash,
    preview: row.preview,
    metadata: parseMetadata(row.metadata),
    filePath: row.file_path,
    imageData: includeImageData ? (row.image_data ?? null) : null,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    useCount: row.use_count,
    isPinned: Boolean(row.is_pinned),
    isFavorite: Boolean(row.is_favorite)
  };
}

function mapBlacklistRow(row: BlacklistRow): BlacklistApp {
  return {
    id: row.id,
    appName: row.app_name,
    appPath: row.app_path,
    isBuiltin: Boolean(row.is_builtin),
    createdAt: row.created_at
  };
}

export function initDatabase(customPath?: string): void {
  if (db) {
    return;
  }
  const target = customPath ?? path.join(app.getPath('userData'), 'clipboard.db');
  const dir = path.dirname(target);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  db = new Database(target);
  dbPath = target;
  runMigrations(db);
  logger.info('database', `数据库已初始化: ${target}`);
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export function getDatabasePath(): string {
  return dbPath;
}

export function getHistory(limit = 200): ClipboardItem[] {
  try {
    const rows = ensureDb()
      .prepare(
        `
      SELECT ${CLIPBOARD_COLUMNS}
      FROM clipboard_items
      ORDER BY is_pinned DESC, created_at DESC
      LIMIT ?
      `
      )
      .all(limit) as ClipboardRow[];
    return rows.map((row) => mapClipboardRow(row));
  } catch (error) {
    logger.error('database', `getHistory 失败: ${String(error)}`);
    return [];
  }
}

export function getItemById(id: number): ClipboardItem | null {
  try {
    const row = ensureDb()
      .prepare(`SELECT * FROM clipboard_items WHERE id = ?`)
      .get(id) as ClipboardRow | undefined;
    return row ? mapClipboardRow(row, true) : null;
  } catch (error) {
    logger.error('database', `getItemById(${id}) 失败: ${String(error)}`);
    return null;
  }
}

export function insertClipboardItem(item: ClipboardInsertInput): ClipboardItem | null {
  try {
    const database = ensureDb();
    const existing = database
      .prepare(`SELECT * FROM clipboard_items WHERE content_hash = ?`)
      .get(item.contentHash) as ClipboardRow | undefined;
    if (existing) {
      return mapClipboardRow(existing);
    }

    const now = Date.now();
    const result = database
      .prepare(
        `
      INSERT INTO clipboard_items (
        content, content_type, content_hash, preview, metadata, file_path, image_data, created_at
      ) VALUES (@content, @contentType, @contentHash, @preview, @metadata, @filePath, @imageData, @createdAt)
      `
      )
      .run({
        content: item.content,
        contentType: item.contentType,
        contentHash: item.contentHash,
        preview: item.preview,
        metadata: JSON.stringify(item.metadata ?? {}),
        filePath: item.filePath ?? null,
        imageData: item.imageData ?? null,
        createdAt: now
      });

    const insertedId = Number(result.lastInsertRowid);
    enforceMaxItems(getSettings().maxItems);
    return getItemById(insertedId);
  } catch (error) {
    logger.error('database', `insertClipboardItem 失败: ${String(error)}`);
    return null;
  }
}

export function searchItems(query: string, limit = 200): ClipboardItem[] {
  const text = query.trim();
  if (!text) {
    return getHistory(limit);
  }

  try {
    const rows = ensureDb()
      .prepare(
        `
      SELECT ${CLIPBOARD_COLUMNS_WITH_ALIAS}
      FROM clipboard_fts f
      JOIN clipboard_items c ON c.id = f.rowid
      WHERE clipboard_fts MATCH ?
      ORDER BY c.is_pinned DESC, bm25(clipboard_fts), c.created_at DESC
      LIMIT ?
      `
      )
      .all(text, limit) as ClipboardRow[];
    return rows.map((row) => mapClipboardRow(row));
  } catch {
    try {
      const like = `%${text}%`;
      const rows = ensureDb()
        .prepare(
          `
        SELECT ${CLIPBOARD_COLUMNS}
        FROM clipboard_items
        WHERE preview LIKE ? OR content LIKE ?
        ORDER BY is_pinned DESC, created_at DESC
        LIMIT ?
        `
        )
        .all(like, like, limit) as ClipboardRow[];
      return rows.map((row) => mapClipboardRow(row));
    } catch (error) {
      logger.error('database', `searchItems 失败: ${String(error)}`);
      return [];
    }
  }
}

export function deleteItem(id: number): boolean {
  try {
    const result = ensureDb().prepare(`DELETE FROM clipboard_items WHERE id = ?`).run(id);
    return result.changes > 0;
  } catch (error) {
    logger.error('database', `deleteItem(${id}) 失败: ${String(error)}`);
    return false;
  }
}

export function clearHistory(includeFavorites = false): { success: boolean; deleted: number; error?: string } {
  const runDelete = (): number => {
    if (includeFavorites) {
      return ensureDb().prepare(`DELETE FROM clipboard_items`).run().changes;
    }
    return ensureDb()
      .prepare(`DELETE FROM clipboard_items WHERE COALESCE(is_favorite, 0) = 0`)
      .run().changes;
  };

  try {
    return { success: true, deleted: runDelete() };
  } catch (error) {
    const message = String(error);
    logger.error('database', `clearHistory 失败: ${message}`);

    if (!/SQL logic error/i.test(message)) {
      return { success: false, deleted: 0, error: message };
    }

    try {
      repairFtsArtifacts();
      const deleted = runDelete();
      logger.warn('database', 'clearHistory 触发 FTS 自愈后已恢复');
      return { success: true, deleted };
    } catch (repairError) {
      const repairMessage = String(repairError);
      logger.error('database', `clearHistory 自愈失败: ${repairMessage}`);
      return { success: false, deleted: 0, error: repairMessage };
    }
  }
}

function repairFtsArtifacts(): void {
  const database = ensureDb();
  const tx = database.transaction(() => {
    const triggers = database
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'clipboard_items_%'`)
      .all() as Array<{ name: string }>;

    for (const trigger of triggers) {
      const escapedName = trigger.name.replace(/"/g, '""');
      database.exec(`DROP TRIGGER IF EXISTS "${escapedName}";`);
    }

    database.exec('DROP TABLE IF EXISTS clipboard_fts;');
    database.exec(CREATE_FTS_TABLE);
    for (const sql of CREATE_FTS_TRIGGERS) {
      database.exec(sql);
    }

    database.exec(`
      INSERT INTO clipboard_fts(rowid, content, preview)
      SELECT id, COALESCE(content, ''), COALESCE(preview, '')
      FROM clipboard_items
    `);
  });

  tx();
}

export function toggleFavorite(id: number): ClipboardItem | null {
  try {
    ensureDb()
      .prepare(
        `
      UPDATE clipboard_items
      SET is_favorite = CASE WHEN is_favorite = 1 THEN 0 ELSE 1 END
      WHERE id = ?
      `
      )
      .run(id);
    return getItemById(id);
  } catch (error) {
    logger.error('database', `toggleFavorite(${id}) 失败: ${String(error)}`);
    return null;
  }
}

export function togglePin(id: number): ClipboardItem | null {
  try {
    ensureDb()
      .prepare(
        `
      UPDATE clipboard_items
      SET is_pinned = CASE WHEN is_pinned = 1 THEN 0 ELSE 1 END
      WHERE id = ?
      `
      )
      .run(id);
    return getItemById(id);
  } catch (error) {
    logger.error('database', `togglePin(${id}) 失败: ${String(error)}`);
    return null;
  }
}

export function deleteOldItems(days: number): number {
  if (days <= 0) {
    return 0;
  }
  try {
    const threshold = Date.now() - days * 24 * 60 * 60 * 1000;
    const result = ensureDb()
      .prepare(
        `
      DELETE FROM clipboard_items
      WHERE created_at < ? AND COALESCE(is_favorite, 0) = 0
      `
      )
      .run(threshold);
    return result.changes;
  } catch (error) {
    logger.error('database', `deleteOldItems(${days}) 失败: ${String(error)}`);
    return 0;
  }
}

function enforceMaxItems(maxItems: number): void {
  if (maxItems <= 0) {
    return;
  }
  const database = ensureDb();
  const totalRow = database.prepare(`SELECT COUNT(*) as count FROM clipboard_items`).get() as
    | { count: number }
    | undefined;
  const total = Number(totalRow?.count ?? 0);
  if (total <= maxItems) {
    return;
  }
  const over = total - maxItems;
  database
    .prepare(
      `
    DELETE FROM clipboard_items
    WHERE id IN (
      SELECT id
      FROM clipboard_items
      WHERE COALESCE(is_favorite, 0) = 0
      ORDER BY created_at ASC
      LIMIT ?
    )
    `
    )
    .run(over);
}

export function incrementUseStats(id: number): void {
  try {
    ensureDb()
      .prepare(
        `
      UPDATE clipboard_items
      SET use_count = use_count + 1, last_used_at = ?
      WHERE id = ?
      `
      )
      .run(Date.now(), id);
  } catch (error) {
    logger.error('database', `incrementUseStats(${id}) 失败: ${String(error)}`);
  }
}

export function getSettings(): AppSettings {
  try {
    const rows = ensureDb().prepare(`SELECT key, value FROM settings`).all() as Array<{
      key: keyof AppSettings;
      value: string;
    }>;
    const merged: AppSettings = { ...DEFAULT_SETTINGS };
    for (const row of rows) {
      if (row.key in merged) {
        try {
          const parsed = JSON.parse(row.value) as unknown;
          switch (row.key) {
            case 'retentionDays':
            case 'maxItems':
            case 'textLimitKb':
              if (typeof parsed === 'number') {
                merged[row.key] = parsed;
              }
              break;
            case 'enableSensitiveFilter':
            case 'enableBlacklist':
            case 'launchOnStartup':
              if (typeof parsed === 'boolean') {
                merged[row.key] = parsed;
              }
              break;
            case 'imageCompression':
              if (parsed === 'original' || parsed === 'high' || parsed === 'medium') {
                merged[row.key] = parsed;
              }
              break;
            default:
              break;
          }
        } catch {
          // 忽略损坏配置，回退默认值
        }
      }
    }
    return merged;
  } catch (error) {
    logger.error('database', `getSettings 失败: ${String(error)}`);
    return { ...DEFAULT_SETTINGS };
  }
}

export function updateSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): AppSettings {
  try {
    ensureDb()
      .prepare(
        `
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key)
      DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `
      )
      .run(key, JSON.stringify(value), Date.now());
  } catch (error) {
    logger.error('database', `updateSetting(${String(key)}) 失败: ${String(error)}`);
  }
  return getSettings();
}

export function getHotkeySettings(): HotkeySettings {
  const hotkeys: HotkeySettings = { ...DEFAULT_HOTKEYS };
  try {
    const rows = ensureDb()
      .prepare(`SELECT key, value FROM settings WHERE key LIKE 'hotkey_%'`)
      .all() as Array<{ key: string; value: string }>;

    for (const row of rows) {
      const mappedKey = row.key.replace('hotkey_', '') as keyof HotkeySettings;
      if (!HOTKEY_KEYS.includes(mappedKey)) {
        continue;
      }
      try {
        const parsed = JSON.parse(row.value);
        if (typeof parsed === 'string' && parsed.trim()) {
          hotkeys[mappedKey] = parsed;
        }
      } catch {
        if (row.value.trim()) {
          hotkeys[mappedKey] = row.value;
        }
      }
    }
  } catch (error) {
    logger.error('database', `getHotkeySettings 失败: ${String(error)}`);
  }
  return hotkeys;
}

export function updateHotkeySettings(partial: Partial<HotkeySettings>): HotkeySettings {
  try {
    const now = Date.now();
    const upsert = ensureDb().prepare(
      `
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key)
      DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `
    );

    const tx = ensureDb().transaction(() => {
      for (const key of HOTKEY_KEYS) {
        const value = partial[key];
        if (typeof value === 'string' && value.trim()) {
          upsert.run(`hotkey_${key}`, JSON.stringify(value), now);
        }
      }
    });
    tx();
  } catch (error) {
    logger.error('database', `updateHotkeySettings 失败: ${String(error)}`);
  }
  return getHotkeySettings();
}

export function listBlacklistApps(): BlacklistApp[] {
  try {
    const rows = ensureDb()
      .prepare(`SELECT * FROM app_blacklist ORDER BY is_builtin DESC, app_name ASC`)
      .all() as BlacklistRow[];
    return rows.map(mapBlacklistRow);
  } catch (error) {
    logger.error('database', `listBlacklistApps 失败: ${String(error)}`);
    return [];
  }
}

export function addBlacklistApp(appName: string, appPath?: string): BlacklistApp {
  const name = appName.trim();
  if (!name) {
    throw new Error('应用名不能为空');
  }
  const result = ensureDb()
    .prepare(
      `
    INSERT INTO app_blacklist (app_name, app_path, is_builtin, created_at)
    VALUES (?, ?, 0, ?)
    `
    )
    .run(name, appPath ?? null, Date.now());
  const inserted = ensureDb()
    .prepare(`SELECT * FROM app_blacklist WHERE id = ?`)
    .get(Number(result.lastInsertRowid)) as BlacklistRow;
  return mapBlacklistRow(inserted);
}

export function removeBlacklistApp(id: number): void {
  ensureDb()
    .prepare(`DELETE FROM app_blacklist WHERE id = ? AND is_builtin = 0`)
    .run(id);
}

export function getHistoryByOffset(offset: number): ClipboardItem | null {
  try {
    const row = ensureDb()
      .prepare(
        `
      SELECT ${CLIPBOARD_COLUMNS}
      FROM clipboard_items
      ORDER BY is_pinned DESC, created_at DESC
      LIMIT 1 OFFSET ?
      `
      )
      .get(offset) as ClipboardRow | undefined;
    return row ? mapClipboardRow(row) : null;
  } catch (error) {
    logger.error('database', `getHistoryByOffset(${offset}) 失败: ${String(error)}`);
    return null;
  }
}

export function countItems(): number {
  try {
    const row = ensureDb().prepare(`SELECT COUNT(*) as count FROM clipboard_items`).get() as {
      count: number;
    };
    return row.count;
  } catch {
    return 0;
  }
}
