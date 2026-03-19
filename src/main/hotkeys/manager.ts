import { dialog, globalShortcut, type BrowserWindow } from 'electron';
import { DEFAULT_HOTKEYS, type HotkeySettings } from '@shared/types';
import { countItems, getHistoryByOffset } from '../database';
import { showQuickPasteHud } from '../hud/window';
import { logger } from '../logger/logger';
import { pasteItem } from '../paste/paster';

interface HotkeyActions {
  toggleWindow: () => void;
  focusSearch: () => void;
  toggleMonitoring: () => boolean;
  clearHistory: () => void;
}

interface UiohookEvent {
  keycode: number;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

interface UiohookApi {
  start: () => void;
  stop: () => void;
  on: (event: 'keydown', listener: (event: UiohookEvent) => void) => void;
  off?: (event: 'keydown', listener: (event: UiohookEvent) => void) => void;
  removeListener?: (event: 'keydown', listener: (event: UiohookEvent) => void) => void;
}

interface QuickSpec {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  keycode: number;
}

const KEYCODE_MAP: Record<string, number> = {
  left: 203,
  right: 205
};

const HOTKEY_LABELS: Record<keyof HotkeySettings, string> = {
  openPanel: '打开/隐藏面板',
  search: '聚焦搜索',
  pause: '暂停/恢复监听',
  clear: '清空历史',
  quickPastePrev: '快速粘贴上一项',
  quickPasteNext: '快速粘贴下一项'
};

let quickPosition: number | null = null;
let quickHook: UiohookApi | null = null;
let quickListener: ((event: UiohookEvent) => void) | null = null;
let quickPrevSpec: QuickSpec = { ctrl: true, alt: true, shift: false, keycode: 203 };
let quickNextSpec: QuickSpec = { ctrl: true, alt: true, shift: false, keycode: 205 };
let quickHeadId: number | null = null;
let quickInFlight = false;
const quickQueue: Array<'older' | 'newer'> = [];

async function performQuickPaste(direction: 'older' | 'newer', window: BrowserWindow): Promise<void> {
  const total = countItems();
  if (total === 0) {
    logger.info('hotkeys', '快速粘贴跳过：历史为空');
    return;
  }

  const head = getHistoryByOffset(0);
  if (!head) {
    return;
  }
  if (quickHeadId !== null && head.id !== quickHeadId) {
    // 仅在历史头部发生变化时重置游标（即复制了新内容）。
    quickPosition = null;
  }
  quickHeadId = head.id;

  const base = Math.min(quickPosition ?? 0, total - 1);
  if (direction === 'older') {
    quickPosition = Math.min(base + 1, total - 1);
  } else {
    quickPosition = Math.max(base - 1, 0);
  }

  const item = getHistoryByOffset(quickPosition);
  if (!item) {
    return;
  }

  showQuickPasteHud(item, direction === 'older' ? 'prev' : 'next');
  if (window.isVisible() && window.isFocused()) {
    window.hide();
  }
  await pasteItem(item.id);
}

async function processQuickQueue(window: BrowserWindow): Promise<void> {
  if (quickInFlight) {
    return;
  }
  quickInFlight = true;
  try {
    while (quickQueue.length > 0) {
      const direction = quickQueue.shift();
      if (!direction) {
        continue;
      }
      await performQuickPaste(direction, window);
    }
  } finally {
    quickInFlight = false;
  }
}

function quickPaste(direction: 'older' | 'newer', window: BrowserWindow): void {
  quickQueue.push(direction);
  void processQuickQueue(window);
}

function safeRegister(accelerator: string, callback: () => void): boolean {
  try {
    const ok = globalShortcut.register(accelerator, callback);
    if (!ok) {
      logger.warn('hotkeys', `快捷键注册失败: ${accelerator}`);
    }
    return ok;
  } catch (error) {
    logger.warn('hotkeys', `快捷键注册异常: ${accelerator} -> ${String(error)}`);
    return false;
  }
}

function parseQuickSpec(raw: string, fallbackKeycode: number): QuickSpec {
  const tokens = raw
    .toLowerCase()
    .split('+')
    .map((token) => token.trim())
    .filter(Boolean);
  const keyToken = tokens[tokens.length - 1] ?? '';
  const keycode = KEYCODE_MAP[keyToken] ?? fallbackKeycode;
  return {
    ctrl: tokens.includes('ctrl') || tokens.includes('control') || tokens.includes('commandorcontrol'),
    alt: tokens.includes('alt'),
    shift: tokens.includes('shift'),
    keycode
  };
}

function eventMatches(event: UiohookEvent, spec: QuickSpec): boolean {
  return (
    Boolean(event.ctrlKey) === spec.ctrl &&
    Boolean(event.altKey) === spec.alt &&
    Boolean(event.shiftKey) === spec.shift &&
    event.keycode === spec.keycode
  );
}

function toElectronAccelerator(raw: string, fallback: string): string {
  const tokens = raw
    .toLowerCase()
    .split('+')
    .map((token) => token.trim())
    .filter(Boolean);

  if (tokens.length === 0) {
    return fallback;
  }

  const normalized = tokens.map((token) => {
    if (token === 'ctrl' || token === 'control') {
      return 'CommandOrControl';
    }
    if (token === 'meta' || token === 'cmd' || token === 'command') {
      return 'Super';
    }
    if (token === 'commandorcontrol' || token === 'cmdorctrl') {
      return 'CommandOrControl';
    }
    if (token === 'left') {
      return 'Left';
    }
    if (token === 'right') {
      return 'Right';
    }
    if (token === 'up') {
      return 'Up';
    }
    if (token === 'down') {
      return 'Down';
    }
    if (token === 'space') {
      return 'Space';
    }
    if (token.length === 1) {
      return token.toUpperCase();
    }
    return token.charAt(0).toUpperCase() + token.slice(1);
  });

  return normalized.join('+');
}

function cleanupQuickPasteHook(): void {
  if (quickHook && quickListener) {
    quickHook.off?.('keydown', quickListener);
    quickHook.removeListener?.('keydown', quickListener);
    quickHook.stop();
  }
  quickHook = null;
  quickListener = null;
}

async function registerQuickPasteHotkeys(window: BrowserWindow, hotkeys: HotkeySettings): Promise<void> {
  quickPrevSpec = parseQuickSpec(hotkeys.quickPastePrev, 203);
  quickNextSpec = parseQuickSpec(hotkeys.quickPasteNext, 205);
  const prev = toElectronAccelerator(hotkeys.quickPastePrev, 'CommandOrControl+Alt+Left');
  const next = toElectronAccelerator(hotkeys.quickPasteNext, 'CommandOrControl+Alt+Right');

  const prevRegistered = safeRegister(prev, () => {
    void quickPaste('older', window);
  });
  const nextRegistered = safeRegister(next, () => {
    void quickPaste('newer', window);
  });

  if (prevRegistered && nextRegistered) {
    logger.info('hotkeys', '快速粘贴使用 globalShortcut 通道');
    return;
  }

  try {
    const module = await import('uiohook-napi');
    const hook = (module.uIOhook ??
      (module as unknown as { default?: { uIOhook?: UiohookApi } }).default?.uIOhook ??
      null) as UiohookApi | null;

    if (!hook) {
      throw new Error('uiohook 实例不可用');
    }

    quickListener = (event: UiohookEvent) => {
      if (!prevRegistered && eventMatches(event, quickPrevSpec)) {
        void quickPaste('older', window);
      } else if (!nextRegistered && eventMatches(event, quickNextSpec)) {
        void quickPaste('newer', window);
      }
    };

    hook.on('keydown', quickListener);
    hook.start();
    quickHook = hook;
    logger.info('hotkeys', '已启用 uiohook 作为快速粘贴补充通道');
  } catch (error) {
    logger.warn('hotkeys', `uiohook 不可用，仅使用 globalShortcut: ${String(error)}`);
  }
}

function mergeHotkeys(partial?: Partial<HotkeySettings>): HotkeySettings {
  return {
    ...DEFAULT_HOTKEYS,
    ...partial
  };
}

export async function checkHotkeyConflicts(partial: Partial<HotkeySettings>): Promise<string[]> {
  const merged = mergeHotkeys(partial);
  const conflicts: string[] = [];

  const candidates: Array<[keyof HotkeySettings, string]> = [
    ['openPanel', merged.openPanel],
    ['search', merged.search],
    ['pause', merged.pause],
    ['clear', merged.clear],
    ['quickPastePrev', merged.quickPastePrev],
    ['quickPasteNext', merged.quickPasteNext]
  ];

  const seen = new Map<string, keyof HotkeySettings>();
  for (const [name, value] of candidates) {
    const key = toElectronAccelerator(value, value).toLowerCase();
    const exists = seen.get(key);
    if (exists) {
      conflicts.push(`${HOTKEY_LABELS[name]} 与 ${HOTKEY_LABELS[exists]} 重复: ${value}`);
      continue;
    }
    seen.set(key, name);
  }

  return conflicts;
}

export function checkHotkeyAvailable(raw: string): boolean {
  const accelerator = toElectronAccelerator(raw, raw);
  if (!accelerator.trim()) {
    return false;
  }

  try {
    if (globalShortcut.isRegistered(accelerator)) {
      return true;
    }

    const ok = globalShortcut.register(accelerator, () => undefined);
    if (ok) {
      globalShortcut.unregister(accelerator);
    }
    return ok;
  } catch {
    return false;
  }
}

async function detectSystemHotkeyConflicts(partial: Partial<HotkeySettings>): Promise<string[]> {
  const merged = mergeHotkeys(partial);
  const checks: Array<[keyof HotkeySettings, string]> = [
    ['openPanel', merged.openPanel],
    ['search', merged.search],
    ['pause', merged.pause],
    ['clear', merged.clear]
  ];

  const conflicts: string[] = [];
  for (const [name, value] of checks) {
    if (!checkHotkeyAvailable(value)) {
      conflicts.push(`${HOTKEY_LABELS[name]} 可能被其他应用占用: ${value}`);
    }
  }
  return conflicts;
}

export function registerHotkeys(
  window: BrowserWindow,
  actions: HotkeyActions,
  partialHotkeys?: Partial<HotkeySettings>
): void {
  cleanupQuickPasteHook();
  const hotkeys = mergeHotkeys(partialHotkeys);
  globalShortcut.unregisterAll();

  safeRegister(toElectronAccelerator(hotkeys.openPanel, DEFAULT_HOTKEYS.openPanel), actions.toggleWindow);
  safeRegister(toElectronAccelerator(hotkeys.search, DEFAULT_HOTKEYS.search), actions.focusSearch);
  safeRegister(toElectronAccelerator(hotkeys.pause, DEFAULT_HOTKEYS.pause), () => {
    const enabled = actions.toggleMonitoring();
    logger.info('hotkeys', `监听状态: ${enabled ? '启用' : '暂停'}`);
  });
  safeRegister(toElectronAccelerator(hotkeys.clear, DEFAULT_HOTKEYS.clear), actions.clearHistory);

  void registerQuickPasteHotkeys(window, hotkeys);
}

export async function showHotkeyConflictWarning(
  partial: Partial<HotkeySettings>,
  onOpenSettings?: () => void
): Promise<void> {
  const conflicts = [
    ...(await checkHotkeyConflicts(partial)),
    ...(await detectSystemHotkeyConflicts(partial))
  ];
  if (conflicts.length > 0) {
    const result = await dialog.showMessageBox({
      type: 'warning',
      title: 'ClipVault - 快捷键冲突',
      message: '检测到快捷键冲突',
      detail: conflicts.join('\n'),
      buttons: ['知道了', '打开快捷键设置'],
      defaultId: 0,
      cancelId: 0
    });
    if (result.response === 1) {
      onOpenSettings?.();
    }
  }
}

export function unregisterHotkeys(): void {
  globalShortcut.unregisterAll();

  cleanupQuickPasteHook();

  quickQueue.length = 0;
  quickPosition = null;
  quickHeadId = null;
  quickInFlight = false;
}
