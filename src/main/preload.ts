import { contextBridge, ipcRenderer } from 'electron';
import type {
  AppSettings,
  BlacklistApp,
  ClipboardApi,
  ClipboardItem,
  HotkeySettings,
  HudPayload,
  MonitoringStatus
} from '@shared/types';

const api: ClipboardApi = {
  getHistory: (limit?: number) => ipcRenderer.invoke('get-history', limit),
  getHistoryRevision: (): Promise<number> => ipcRenderer.invoke('get-history-revision'),
  searchItems: (query: string) => ipcRenderer.invoke('search-items', query),
  pasteItem: (id: number) => ipcRenderer.invoke('paste-item', id),
  deleteItem: (id: number) => ipcRenderer.invoke('delete-item', id),
  togglePin: (id: number) => ipcRenderer.invoke('toggle-pin', id),
  toggleFavorite: (id: number) => ipcRenderer.invoke('toggle-favorite', id),
  getImageDataUrl: (id: number) => ipcRenderer.invoke('get-image-data-url', id),
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('get-settings'),
  updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]): Promise<AppSettings> =>
    ipcRenderer.invoke('update-setting', key, value),
  listBlacklist: (): Promise<BlacklistApp[]> => ipcRenderer.invoke('list-blacklist'),
  addBlacklist: (appName: string, appPath?: string): Promise<BlacklistApp> =>
    ipcRenderer.invoke('add-blacklist', appName, appPath),
  removeBlacklist: (id: number): Promise<void> => ipcRenderer.invoke('remove-blacklist', id),
  clearHistory: (): Promise<{ success: boolean; deleted: number; error?: string }> => ipcRenderer.invoke('clear-history'),
  toggleMonitoring: (): Promise<boolean> => ipcRenderer.invoke('toggle-monitoring'),
  minimizeWindow: (): Promise<void> => ipcRenderer.invoke('minimize-window'),
  hideWindow: (): Promise<void> => ipcRenderer.invoke('hide-window'),
  getHotkeys: (): Promise<HotkeySettings> => ipcRenderer.invoke('get-hotkeys'),
  updateHotkeys: (hotkeys: Partial<HotkeySettings>): Promise<HotkeySettings> =>
    ipcRenderer.invoke('update-hotkeys', hotkeys),
  checkHotkeyConflicts: (hotkeys: Partial<HotkeySettings>): Promise<string[]> =>
    ipcRenderer.invoke('check-hotkey-conflicts', hotkeys),
  checkHotkeyAvailable: (hotkey: string): Promise<boolean> => ipcRenderer.invoke('check-hotkey-available', hotkey),
  rendererReady: () => {
    ipcRenderer.send('renderer-ready');
  },
  testMonitoring: (): Promise<MonitoringStatus> => ipcRenderer.invoke('test-monitoring'),
  testHud: (): Promise<{ success: boolean; reason?: string }> => ipcRenderer.invoke('test-hud'),
  onHudShow: (handler: (payload: HudPayload) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: HudPayload) => handler(payload);
    ipcRenderer.on('hud:show', listener);
    return () => {
      ipcRenderer.removeListener('hud:show', listener);
    };
  },
  onNewItem: (handler: (item: ClipboardItem) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, item: ClipboardItem) => handler(item);
    ipcRenderer.on('clipboard:new-item', listener);
    return () => {
      ipcRenderer.removeListener('clipboard:new-item', listener);
    };
  },
  onFocusSearch: (handler: () => void) => {
    const listener = () => handler();
    ipcRenderer.on('clipboard:focus-search', listener);
    return () => {
      ipcRenderer.removeListener('clipboard:focus-search', listener);
    };
  },
  onOpenSettings: (handler: () => void) => {
    const listener = () => handler();
    ipcRenderer.on('clipboard:open-settings', listener);
    return () => {
      ipcRenderer.removeListener('clipboard:open-settings', listener);
    };
  },
  onOpenHotkeys: (handler: () => void) => {
    const listener = () => handler();
    ipcRenderer.on('clipboard:open-hotkeys', listener);
    return () => {
      ipcRenderer.removeListener('clipboard:open-hotkeys', listener);
    };
  },
  onWindowMoving: (handler: (moving: boolean) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, moving: boolean) => handler(moving);
    ipcRenderer.on('window:moving', listener);
    return () => {
      ipcRenderer.removeListener('window:moving', listener);
    };
  }
};

contextBridge.exposeInMainWorld('electron', api);
