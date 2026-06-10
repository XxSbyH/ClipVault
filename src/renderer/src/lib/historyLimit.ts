import { DEFAULT_SETTINGS, type AppSettings } from '@shared/types';

export const INITIAL_HISTORY_LIMIT = 50;

export function getHistoryFetchLimit(settings: AppSettings | null | undefined): number {
  return Math.max(1, Math.floor(settings?.maxItems ?? DEFAULT_SETTINGS.maxItems));
}
