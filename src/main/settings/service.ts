import type { AppSettings } from '@shared/types';
import { getSettings, updateSetting } from '../database';
import { runCleanupNow } from '../cleanup/scheduler';

export function readSettings(): AppSettings {
  return getSettings();
}

export function writeSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): AppSettings {
  const next = updateSetting(key, value);
  if (key === 'retentionDays') {
    runCleanupNow();
  }
  return next;
}
