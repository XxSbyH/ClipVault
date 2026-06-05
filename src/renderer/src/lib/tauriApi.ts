import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  AppSettings,
  BlacklistApp,
  ClipboardApi,
  ClipboardItem,
  HotkeySettings,
  HudPayload,
  MonitoringStatus
} from '@shared/types';

type CommandResult = { success: boolean; error?: string };
type ClearHistoryResult = { success: boolean; deleted: number; error?: string };
type PasteResult = {
  success: boolean;
  message?: string;
};
type HotkeyConflictReport = {
  hasConflicts: boolean;
  conflicts: Array<{
    hotkey: string;
    commands: string[];
  }>;
};
type HotkeyAvailability = {
  available: boolean;
};

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

async function commandResult(command: string, args: Record<string, unknown>): Promise<CommandResult> {
  try {
    await invoke(command, args);
    return { success: true };
  } catch (error) {
    return { success: false, error: errorMessage(error) };
  }
}

function listenPayload<T>(eventName: string, handler: (payload: T) => void): () => void {
  let disposed = false;
  let unlisten: UnlistenFn | null = null;

  void listen<T>(eventName, (event) => {
    handler(event.payload);
  }).then((nextUnlisten) => {
    if (disposed) {
      nextUnlisten();
      return;
    }
    unlisten = nextUnlisten;
  }).catch(() => {
    // Keep the old preload API behavior: registering a listener should not crash the UI.
  });

  return () => {
    disposed = true;
    unlisten?.();
    unlisten = null;
  };
}

function readableHotkeyConflicts(report: HotkeyConflictReport): string[] {
  if (!report.hasConflicts) {
    return [];
  }
  return report.conflicts.map((conflict) => {
    const commands = conflict.commands.join(', ');
    return `${conflict.hotkey}: ${commands}`;
  });
}

function findAddedBlacklistApp(apps: BlacklistApp[], appName: string): BlacklistApp {
  const normalized = appName.trim().toLowerCase();
  const matches = apps.filter((app) => app.appName.trim().toLowerCase() === normalized);
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    if (!matches[index].isBuiltin) {
      return matches[index];
    }
  }
  return matches.at(-1) ?? apps.at(-1) ?? {
    id: Date.now(),
    appName,
    appPath: null,
    isBuiltin: false,
    createdAt: Date.now()
  };
}

export const clipboardApi: ClipboardApi = {
  getHistory(limit) {
    return invoke<ClipboardItem[]>('get_history', { limit });
  },
  getHistoryRevision() {
    return invoke<number>('get_history_revision');
  },
  searchItems(query) {
    return invoke<ClipboardItem[]>('search_items', { query });
  },
  async pasteItem(id) {
    try {
      const result = await invoke<PasteResult>('paste_item', { id });
      if (result.success) {
        return { success: true };
      }
      return { success: false, error: result.message || 'paste failed' };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  },
  deleteItem(id) {
    return commandResult('delete_item', { id });
  },
  async togglePin(id) {
    return invoke<ClipboardItem>('toggle_pin', { id });
  },
  async toggleFavorite(id) {
    return invoke<ClipboardItem>('toggle_favorite', { id });
  },
  getImageDataUrl(id) {
    return invoke<string | null>('get_image_data_url', { id });
  },
  getSettings() {
    return invoke<AppSettings>('get_settings');
  },
  updateSetting(key, value) {
    return invoke<AppSettings>('update_setting', { key, value });
  },
  listBlacklist() {
    return invoke<BlacklistApp[]>('list_blacklist');
  },
  async addBlacklist(appName, appPath) {
    const apps = await invoke<BlacklistApp[]>('add_blacklist', { appName, appPath });
    return findAddedBlacklistApp(apps, appName);
  },
  async removeBlacklist(id) {
    await invoke<BlacklistApp[]>('remove_blacklist', { id });
  },
  async clearHistory(): Promise<ClearHistoryResult> {
    try {
      await invoke<number>('clear_history', { includeFavorites: false });
      return { success: true, deleted: 0 };
    } catch (error) {
      return { success: false, deleted: 0, error: errorMessage(error) };
    }
  },
  async toggleMonitoring() {
    const status = await invoke<MonitoringStatus>('toggle_monitoring');
    return status.monitorEnabled;
  },
  minimizeWindow() {
    return invoke<void>('minimize_window');
  },
  hideWindow() {
    return invoke<void>('hide_window');
  },
  getHotkeys() {
    return invoke<HotkeySettings>('get_hotkeys');
  },
  updateHotkeys(hotkeys) {
    return invoke<HotkeySettings>('update_hotkeys', { patch: hotkeys });
  },
  async checkHotkeyConflicts(hotkeys) {
    const report = await invoke<HotkeyConflictReport>('check_hotkey_conflicts', { patch: hotkeys });
    return readableHotkeyConflicts(report);
  },
  async checkHotkeyAvailable(hotkey) {
    const result = await invoke<HotkeyAvailability>('check_hotkey_available', { hotkey });
    return result.available;
  },
  rendererReady() {
    // Task 4 does not expose a renderer-ready command.
  },
  testMonitoring() {
    return invoke<MonitoringStatus>('test_monitoring');
  },
  async testHud() {
    try {
      await invoke<HudPayload>('test_hud');
      return { success: true };
    } catch (error) {
      return { success: false, reason: errorMessage(error) };
    }
  },
  onHudShow(handler) {
    return listenPayload<HudPayload>('hud:show', handler);
  },
  onNewItem(handler) {
    return listenPayload<ClipboardItem>('clipboard:new-item', handler);
  },
  onFocusSearch(handler) {
    return listenPayload<void>('clipboard:focus-search', handler);
  },
  onOpenSettings(handler) {
    return listenPayload<void>('clipboard:open-settings', handler);
  },
  onOpenHotkeys(handler) {
    return listenPayload<void>('clipboard:open-hotkeys', handler);
  },
  onWindowMoving() {
    return () => {};
  }
};
