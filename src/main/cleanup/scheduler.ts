import { deleteOldItems, getSettings } from '../database';
import { logger } from '../logger/logger';

let timer: NodeJS.Timeout | null = null;

export function runCleanupNow(): number {
  const settings = getSettings();
  const deleted = deleteOldItems(settings.retentionDays);
  logger.info('cleanup', `自动清理完成，删除 ${deleted} 条记录`);
  return deleted;
}

export function startCleanupScheduler(): void {
  stopCleanupScheduler();
  runCleanupNow();
  timer = setInterval(
    () => {
      runCleanupNow();
    },
    24 * 60 * 60 * 1000
  );
}

export function stopCleanupScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
