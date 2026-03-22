import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  app,
  BrowserWindow,
  ipcMain,
  nativeImage,
  shell
} from 'electron';
import {
  addBlacklistApp,
  clearHistory,
  closeDatabase,
  deleteItem,
  getHistory,
  getHotkeySettings,
  getItemById,
  initDatabase,
  listBlacklistApps,
  removeBlacklistApp,
  searchItems as dbSearchItems,
  toggleFavorite,
  togglePin,
  updateHotkeySettings
} from './database';
import type { AppSettings, ClipboardItem } from '@shared/types';
import {
  applyWheelShortcutSettings,
  checkHotkeyAvailable,
  checkHotkeyConflicts,
  registerHotkeys,
  showHotkeyConflictWarning,
  unregisterHotkeys
} from './hotkeys/manager';
import { destroyHudWindow, prepareHudWindow, showQuickPasteHud } from './hud/window';
import { initLogger, logger } from './logger/logger';
import { pasteItem } from './paste/paster';
import { rebuildSearchIndex, addToSearchIndex, removeFromSearchIndex, searchIds } from './search/indexer';
import { createTray, destroyTray, refreshTrayMenu } from './tray/tray';
import { getMonitoringDiagnostics, startMonitoring, stopMonitoring, toggleMonitoring, isMonitoring } from './clipboard/monitor';
import { readSettings, writeSetting } from './settings/service';
import { runCleanupNow, startCleanupScheduler, stopCleanupScheduler } from './cleanup/scheduler';

let mainWindow: BrowserWindow | null = null;
let isQuitting = false;
let rendererReady = false;
let rendererReadyForShow = false;
let windowReadyToShow = false;
let monitoringStarted = false;
const pendingClipboardItems: ClipboardItem[] = [];
let historyRevision = 0;
const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (process.platform === 'win32') {
  app.setAppUserModelId('com.clipvault.app');
}

function resolveWindowIconPath(): string | undefined {
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'icon.ico')
    : join(app.getAppPath(), 'resources', 'icon.ico');
  return existsSync(iconPath) ? iconPath : undefined;
}

function tryShowMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  if (windowReadyToShow && rendererReadyForShow && !mainWindow.isVisible()) {
    mainWindow.show();
  }
}

function showAndFocusMainWindow(): void {
  if (!mainWindow) {
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  if (!mainWindow.isVisible()) {
    mainWindow.show();
  }
  mainWindow.center();
  mainWindow.focus();
}

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showAndFocusMainWindow();
  });
}

function applyLaunchOnStartup(enabled: boolean): void {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    path: process.execPath
  });
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 600,
    height: 800,
    minWidth: 520,
    minHeight: 640,
    show: false,
    frame: false,
    autoHideMenuBar: true,
    alwaysOnTop: false,
    skipTaskbar: false,
    backgroundColor: '#f8fafc',
    icon: resolveWindowIconPath(),
    webPreferences: {
      preload: join(__dirname, '../preload/preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  window.on('ready-to-show', () => {
    windowReadyToShow = true;
    tryShowMainWindow();
    // 启动兜底：防止异常情况下主窗口长时间不显示
    setTimeout(() => {
      if (!window.isDestroyed() && !window.isVisible()) {
        window.show();
      }
    }, 2000);
  });

  window.webContents.on('did-start-loading', () => {
    rendererReady = false;
    rendererReadyForShow = false;
    windowReadyToShow = false;
  });

  window.webContents.on('did-finish-load', () => {
    rendererReady = true;
    logger.info('startup', '主窗口页面加载完成');
    flushPendingClipboardItems();
    setTimeout(() => {
      ensureMonitoringStarted();
    }, 800);
  });

  window.webContents.on('render-process-gone', (_event, details) => {
    rendererReady = false;
    logger.error('startup', `渲染进程退出: ${details.reason}`);
    if (!window.isDestroyed()) {
      setTimeout(() => {
        if (!window.isDestroyed()) {
          void window.webContents.reload();
        }
      }, 300);
    }
  });

  window.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      window.hide();
    }
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(__dirname, '../../dist/renderer/index.html'));
  }

  return window;
}

function toggleMainWindow(): void {
  if (!mainWindow) {
    return;
  }
  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    showAndFocusMainWindow();
  }
}

function rebuildIndexFromDatabase(): void {
  const items = getHistory(5000);
  rebuildSearchIndex(items);
  historyRevision += 1;
}

function clearHistoryAndRebuild(): { success: boolean; deleted: number; error?: string } {
  const result = clearHistory(false);
  if (!result.success) {
    return result;
  }
  rebuildIndexFromDatabase();
  return result;
}

function openSettingsPanel(): void {
  showAndFocusMainWindow();
  mainWindow?.webContents.send('clipboard:open-settings');
}

function buildTrayActions() {
  return {
    toggleWindow: toggleMainWindow,
    toggleMonitoring: toggleMonitoringWithTraySync,
    clearHistory: clearHistoryAndRebuild,
    openSettings: openSettingsPanel,
    quit: () => app.quit(),
    isMonitoring
  };
}

function toggleMonitoringWithTraySync(): boolean {
  const enabled = toggleMonitoring();
  if (mainWindow) {
    refreshTrayMenu(buildTrayActions());
  }
  return enabled;
}

function buildHotkeyActions() {
  return {
    toggleWindow: toggleMainWindow,
    focusSearch: () => {
      if (!mainWindow) {
        return;
      }
      if (!mainWindow.isVisible()) {
        showAndFocusMainWindow();
      } else {
        mainWindow.focus();
      }
      mainWindow.webContents.send('clipboard:focus-search');
    },
    toggleMonitoring: toggleMonitoringWithTraySync,
    clearHistory: clearHistoryAndRebuild
  };
}

function emitClipboardItem(item: ClipboardItem): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  if (!rendererReady || mainWindow.webContents.isLoadingMainFrame()) {
    pendingClipboardItems.push(item);
    return;
  }
  mainWindow.webContents.send('clipboard:new-item', item);
}

function flushPendingClipboardItems(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  if (!rendererReady || mainWindow.webContents.isLoadingMainFrame()) {
    return;
  }
  while (pendingClipboardItems.length > 0) {
    const item = pendingClipboardItems.shift();
    if (item) {
      mainWindow.webContents.send('clipboard:new-item', item);
    }
  }
}

function ensureMonitoringStarted(): void {
  if (monitoringStarted) {
    return;
  }
  logger.info('startup', '开始启动剪贴板监听');
  monitoringStarted = true;
  startMonitoring((item) => {
    addToSearchIndex(item);
    historyRevision += 1;
    emitClipboardItem(item);
  });
}

function registerIpcHandlers(): void {
  ipcMain.on('renderer-ready', () => {
    rendererReady = true;
    rendererReadyForShow = true;
    logger.info('startup', '收到 renderer-ready，准备刷新缓存事件');
    tryShowMainWindow();
    ensureMonitoringStarted();
    flushPendingClipboardItems();
  });

  ipcMain.handle('get-history', (_event, limit = 300) => getHistory(limit));
  ipcMain.handle('get-history-revision', () => historyRevision);

  ipcMain.handle('search-items', (_event, query: string) => {
    const q = query.trim();
    if (!q) {
      return getHistory(500);
    }
    const ids = searchIds(q);
    if (ids.length === 0) {
      return dbSearchItems(q, 300);
    }
    const map = new Map(getHistory(5000).map((item) => [item.id, item]));
    return ids.map((id) => map.get(id)).filter((item): item is NonNullable<typeof item> => Boolean(item));
  });

  ipcMain.handle('paste-item', async (_event, id: number) => pasteItem(id, mainWindow));

  ipcMain.handle('delete-item', (_event, id: number) => {
    const ok = deleteItem(id);
    if (ok) {
      removeFromSearchIndex(id);
      historyRevision += 1;
    }
    return { success: ok, error: ok ? undefined : '删除失败' };
  });

  ipcMain.handle('toggle-pin', (_event, id: number) => {
    const item = togglePin(id);
    if (item) {
      addToSearchIndex(item);
      historyRevision += 1;
    }
    return item;
  });

  ipcMain.handle('toggle-favorite', (_event, id: number) => {
    const item = toggleFavorite(id);
    if (item) {
      addToSearchIndex(item);
      historyRevision += 1;
    }
    return item;
  });

  ipcMain.handle('get-image-data-url', (_event, id: number) => {
    const item = getItemById(id);
    if (!item?.imageData) {
      return null;
    }
    const image = nativeImage.createFromBuffer(Buffer.from(item.imageData));
    return image.toDataURL();
  });

  ipcMain.handle('get-settings', () => readSettings());
  ipcMain.handle('update-setting', (_event, key: keyof AppSettings, value: AppSettings[keyof AppSettings]) =>
    {
      const next = writeSetting(key, value);
      applyWheelShortcutSettings(next);
      if (key === 'launchOnStartup') {
        applyLaunchOnStartup(next.launchOnStartup);
      }
      if (
        (key === 'wheelShortcutEnabled' || key === 'wheelShortcutModifier' || key === 'wheelShortcutScope') &&
        mainWindow
      ) {
        registerHotkeys(mainWindow, buildHotkeyActions(), getHotkeySettings());
      }
      return next;
    });

  ipcMain.handle('list-blacklist', () => listBlacklistApps());
  ipcMain.handle('add-blacklist', (_event, appName: string, appPath?: string) => addBlacklistApp(appName, appPath));
  ipcMain.handle('remove-blacklist', (_event, id: number) => removeBlacklistApp(id));

  ipcMain.handle('get-hotkeys', () => getHotkeySettings());
  ipcMain.handle('check-hotkey-conflicts', (_event, hotkeys: Record<string, string>) =>
    checkHotkeyConflicts(hotkeys)
  );
  ipcMain.handle('check-hotkey-available', (_event, hotkey: string) => checkHotkeyAvailable(hotkey));
  ipcMain.handle('update-hotkeys', (_event, hotkeys: Record<string, string>) => {
    const next = updateHotkeySettings(hotkeys);
    if (mainWindow) {
      registerHotkeys(mainWindow, buildHotkeyActions(), next);
    }
    return next;
  });

  ipcMain.handle('clear-history', () => {
    return clearHistoryAndRebuild();
  });

  ipcMain.handle('toggle-monitoring', () => {
    return toggleMonitoringWithTraySync();
  });

  ipcMain.handle('minimize-window', () => {
    mainWindow?.minimize();
  });

  ipcMain.handle('hide-window', () => {
    mainWindow?.hide();
  });

  ipcMain.handle('test-monitoring', () => getMonitoringDiagnostics());

  ipcMain.handle('test-hud', () => {
    const item = getHistory(1)[0];
    if (!item) {
      return { success: false, reason: '当前没有可展示的历史内容' };
    }
    showQuickPasteHud(item, 'prev');
    return { success: true };
  });
}

if (gotSingleInstanceLock) {
  app.whenReady().then(() => {
    initLogger('info');
    logger.info('startup', 'ClipVault 主进程启动完成');
    initDatabase();
    const appSettings = readSettings();
    applyLaunchOnStartup(appSettings.launchOnStartup);
    applyWheelShortcutSettings(appSettings);
    runCleanupNow();
    startCleanupScheduler();

    mainWindow = createWindow();
    registerIpcHandlers();
    prepareHudWindow();
    const hotkeys = getHotkeySettings();
    void showHotkeyConflictWarning(hotkeys, () => {
      showAndFocusMainWindow();
      if (!mainWindow) {
        return;
      }
      if (mainWindow.webContents.isLoadingMainFrame()) {
        mainWindow.webContents.once('did-finish-load', () => {
          mainWindow?.webContents.send('clipboard:open-hotkeys');
        });
      } else {
        mainWindow.webContents.send('clipboard:open-hotkeys');
      }
    });

    registerHotkeys(mainWindow, buildHotkeyActions(), hotkeys);

    createTray(mainWindow, buildTrayActions());
    setTimeout(() => {
      rebuildIndexFromDatabase();
    }, 1200);

    // 启动兜底：即使页面事件未按预期触发，也保证监听最终启动。
    setTimeout(() => {
      ensureMonitoringStarted();
    }, 1500);
  });
}

app.on('before-quit', () => {
  isQuitting = true;
  stopMonitoring();
  monitoringStarted = false;
  stopCleanupScheduler();
  unregisterHotkeys();
  destroyHudWindow();
  destroyTray();
  closeDatabase();
});

app.on('window-all-closed', () => {
  // Windows 托盘应用不自动退出
});

app.on('activate', () => {
  if (!mainWindow) {
    mainWindow = createWindow();
  }
  if (!mainWindow.isVisible()) {
    mainWindow.show();
  }
});
