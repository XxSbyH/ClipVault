export type ClipboardContentType =
  | 'text'
  | 'image'
  | 'file'
  | 'url'
  | 'code'
  | 'color'
  | 'email';

export interface ClipboardMetadata {
  language?: string;
  urlTitle?: string;
  colorHex?: string;
  fileSize?: number;
  fileName?: string;
  fileExt?: string;
  imageWidth?: number;
  imageHeight?: number;
  originalSize?: number;
  compressedSize?: number;
  exists?: boolean;
  [key: string]: string | number | boolean | undefined;
}

export interface ClipboardItem {
  id: number;
  content: string | null;
  contentType: ClipboardContentType;
  contentHash: string;
  preview: string;
  metadata: ClipboardMetadata;
  filePath: string | null;
  imageData: Uint8Array | null;
  createdAt: number;
  lastUsedAt: number | null;
  useCount: number;
  isPinned: boolean;
  isFavorite: boolean;
}

export interface ClipboardInsertInput {
  content: string | null;
  contentType: ClipboardContentType;
  contentHash: string;
  preview: string;
  metadata?: ClipboardMetadata;
  filePath?: string | null;
  imageData?: Uint8Array | null;
}

export interface AppSettings {
  retentionDays: number;
  maxItems: number;
  enableSensitiveFilter: boolean;
  enableBlacklist: boolean;
  textLimitKb: number;
  imageCompression: 'original' | 'high' | 'medium';
  launchOnStartup: boolean;
  wheelShortcutEnabled: boolean;
  wheelShortcutModifier: 'ctrl' | 'alt' | 'shift' | 'ctrl+alt';
  wheelShortcutScope: 'global' | 'panel-only';
}

export const DEFAULT_SETTINGS: AppSettings = {
  retentionDays: 7,
  maxItems: 1000,
  enableSensitiveFilter: true,
  enableBlacklist: true,
  textLimitKb: 100,
  imageCompression: 'high',
  launchOnStartup: false,
  wheelShortcutEnabled: true,
  wheelShortcutModifier: 'ctrl',
  wheelShortcutScope: 'global'
};

export interface HotkeySettings {
  openPanel: string;
  search: string;
  pause: string;
  clear: string;
  quickPastePrev: string;
  quickPasteNext: string;
}

export interface HudPayload {
  direction: 'prev' | 'next';
  type: ClipboardContentType;
  text: string;
}

export interface MonitoringStatus {
  monitorEnabled: boolean;
  monitorStarted: boolean;
  hasTimer: boolean;
  isRunning: boolean;
  lastHashPrefix: string;
}

export const DEFAULT_HOTKEYS: HotkeySettings = {
  openPanel: 'CommandOrControl+Shift+V',
  search: 'CommandOrControl+Shift+F',
  pause: 'CommandOrControl+Shift+P',
  clear: 'CommandOrControl+Shift+C',
  quickPastePrev: 'Ctrl+Alt+Left',
  quickPasteNext: 'Ctrl+Alt+Right'
};

export interface BlacklistApp {
  id: number;
  appName: string;
  appPath: string | null;
  isBuiltin: boolean;
  createdAt: number;
}

export type FilterType = 'all' | 'text' | 'image' | 'code' | 'url' | 'favorite';

export interface ClipboardApi {
  getHistory: (limit?: number) => Promise<ClipboardItem[]>;
  getHistoryRevision: () => Promise<number>;
  searchItems: (query: string) => Promise<ClipboardItem[]>;
  pasteItem: (id: number) => Promise<{ success: boolean; error?: string }>;
  deleteItem: (id: number) => Promise<{ success: boolean; error?: string }>;
  togglePin: (id: number) => Promise<ClipboardItem | null>;
  toggleFavorite: (id: number) => Promise<ClipboardItem | null>;
  getImageDataUrl: (id: number) => Promise<string | null>;
  getSettings: () => Promise<AppSettings>;
  updateSetting: <K extends keyof AppSettings>(
    key: K,
    value: AppSettings[K]
  ) => Promise<AppSettings>;
  listBlacklist: () => Promise<BlacklistApp[]>;
  addBlacklist: (appName: string, appPath?: string) => Promise<BlacklistApp>;
  removeBlacklist: (id: number) => Promise<void>;
  clearHistory: () => Promise<{ success: boolean; deleted: number; error?: string }>;
  toggleMonitoring: () => Promise<boolean>;
  minimizeWindow: () => Promise<void>;
  hideWindow: () => Promise<void>;
  getHotkeys: () => Promise<HotkeySettings>;
  updateHotkeys: (hotkeys: Partial<HotkeySettings>) => Promise<HotkeySettings>;
  checkHotkeyConflicts: (hotkeys: Partial<HotkeySettings>) => Promise<string[]>;
  checkHotkeyAvailable: (hotkey: string) => Promise<boolean>;
  rendererReady: () => void;
  testMonitoring: () => Promise<MonitoringStatus>;
  testHud: () => Promise<{ success: boolean; reason?: string }>;
  onHudShow: (handler: (payload: HudPayload) => void) => () => void;
  onNewItem: (handler: (item: ClipboardItem) => void) => () => void;
  onFocusSearch: (handler: () => void) => () => void;
  onOpenSettings: (handler: () => void) => () => void;
  onOpenHotkeys: (handler: () => void) => () => void;
  onWindowMoving: (handler: (moving: boolean) => void) => () => void;
}
