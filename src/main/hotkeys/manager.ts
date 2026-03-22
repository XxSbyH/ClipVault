import { dialog, globalShortcut, type BrowserWindow } from 'electron';
import {
  DEFAULT_HOTKEYS,
  DEFAULT_SETTINGS,
  type AppSettings,
  type ClipboardItem,
  type HotkeySettings
} from '@shared/types';
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

interface UiohookKeyboardEvent {
  keycode: number;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

interface UiohookWheelEvent {
  rotation?: number;
  clicks?: number;
  direction?: number;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

interface UiohookApi {
  start: () => void;
  stop: () => void;
  on: {
    (event: 'keydown', listener: (event: UiohookKeyboardEvent) => void): void;
    (event: 'wheel', listener: (event: UiohookWheelEvent) => void): void;
  };
  off?: {
    (event: 'keydown', listener: (event: UiohookKeyboardEvent) => void): void;
    (event: 'wheel', listener: (event: UiohookWheelEvent) => void): void;
  };
  removeListener?: {
    (event: 'keydown', listener: (event: UiohookKeyboardEvent) => void): void;
    (event: 'wheel', listener: (event: UiohookWheelEvent) => void): void;
  };
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
const WHEEL_DEBOUNCE_MS = 200;
const WHEEL_MAX_STEPS_PER_BATCH = 10;

type QuickPasteDirection = 'older' | 'newer';
type WheelModifier = AppSettings['wheelShortcutModifier'];
type WheelScope = AppSettings['wheelShortcutScope'];

interface WheelShortcutOptions {
  enabled: boolean;
  modifier: WheelModifier;
  scope: WheelScope;
}

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
let quickKeyboardListener: ((event: UiohookKeyboardEvent) => void) | null = null;
let quickWheelListener: ((event: UiohookWheelEvent) => void) | null = null;
let quickPrevSpec: QuickSpec = { ctrl: true, alt: true, shift: false, keycode: 203 };
let quickNextSpec: QuickSpec = { ctrl: true, alt: true, shift: false, keycode: 205 };
let quickHeadId: number | null = null;
let quickInFlight = false;
const quickQueue: number[] = [];
let wheelDebounceTimer: NodeJS.Timeout | null = null;
let wheelDeltaAccumulator = 0;
let wheelWindowRef: BrowserWindow | null = null;
let wheelOptions: WheelShortcutOptions = {
  enabled: DEFAULT_SETTINGS.wheelShortcutEnabled,
  modifier: DEFAULT_SETTINGS.wheelShortcutModifier,
  scope: DEFAULT_SETTINGS.wheelShortcutScope
};

function resolveQuickPasteItem(
  direction: 'older' | 'newer'
): { item: ClipboardItem; hudDirection: 'prev' | 'next' } | null {
  const total = countItems();
  if (total === 0) {
    logger.info('hotkeys', '快速粘贴跳过：历史为空');
    return null;
  }

  const head = getHistoryByOffset(0);
  if (!head) {
    return null;
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
    return null;
  }

  return { item, hudDirection: direction === 'older' ? 'prev' : 'next' };
}

async function performQuickPaste(itemId: number): Promise<void> {
  await pasteItem(itemId);
}

async function processQuickQueue(): Promise<void> {
  if (quickInFlight) {
    return;
  }
  quickInFlight = true;
  try {
    while (quickQueue.length > 0) {
      const itemId = quickQueue.shift();
      if (typeof itemId !== 'number') {
        continue;
      }
      await performQuickPaste(itemId);
    }
  } finally {
    quickInFlight = false;
  }
}

function quickPaste(direction: QuickPasteDirection, window: BrowserWindow, hideWindow = true): void {
  const payload = resolveQuickPasteItem(direction);
  if (!payload) {
    return;
  }
  showQuickPasteHud(payload.item, payload.hudDirection);
  if (hideWindow && window.isVisible() && window.isFocused()) {
    window.hide();
  }
  quickQueue.push(payload.item.id);
  void processQuickQueue();
}

function clearWheelDebounceState(): void {
  if (wheelDebounceTimer) {
    clearTimeout(wheelDebounceTimer);
    wheelDebounceTimer = null;
  }
  wheelDeltaAccumulator = 0;
}

function isWheelModifierMatched(event: UiohookWheelEvent): boolean {
  const ctrl = Boolean(event.ctrlKey);
  const alt = Boolean(event.altKey);
  const shift = Boolean(event.shiftKey);

  switch (wheelOptions.modifier) {
    case 'ctrl':
      return ctrl && !alt && !shift;
    case 'alt':
      return alt && !ctrl && !shift;
    case 'shift':
      return shift && !ctrl && !alt;
    case 'ctrl+alt':
      return ctrl && alt && !shift;
    default:
      return false;
  }
}

function isWheelScopeMatched(window: BrowserWindow): boolean {
  if (wheelOptions.scope === 'global') {
    return true;
  }
  return window.isVisible() && window.isFocused();
}

function flushWheelAccumulated(window: BrowserWindow): void {
  const delta = wheelDeltaAccumulator;
  wheelDeltaAccumulator = 0;
  wheelDebounceTimer = null;

  if (delta === 0) {
    return;
  }

  const direction: QuickPasteDirection = delta > 0 ? 'older' : 'newer';
  const steps = Math.max(1, Math.min(WHEEL_MAX_STEPS_PER_BATCH, Math.round(Math.abs(delta))));
  const hideWindow = wheelOptions.scope !== 'panel-only';
  for (let index = 0; index < steps; index += 1) {
    quickPaste(direction, window, hideWindow);
  }
}

function handleWheelEvent(event: UiohookWheelEvent): void {
  const window = wheelWindowRef;
  if (!window || window.isDestroyed()) {
    return;
  }
  if (!wheelOptions.enabled) {
    return;
  }
  if (!isWheelScopeMatched(window)) {
    return;
  }
  if (!isWheelModifierMatched(event)) {
    return;
  }

  const rotation = Number(event.rotation ?? 0);
  if (!Number.isFinite(rotation) || rotation === 0) {
    return;
  }

  const clicks = Math.max(1, Math.abs(Math.round(Number(event.clicks ?? 1))));
  // Windows 下 uiohook 的滚轮符号与直觉常见相反：向下滚通常是正值。
  // 统一修正后，normalizedRotation > 0 表示“向上滚”（上一项）。
  const normalizedRotation = process.platform === 'win32' ? -rotation : rotation;
  wheelDeltaAccumulator += normalizedRotation > 0 ? clicks : -clicks;

  if (wheelDebounceTimer) {
    clearTimeout(wheelDebounceTimer);
  }
  wheelDebounceTimer = setTimeout(() => {
    flushWheelAccumulated(window);
  }, WHEEL_DEBOUNCE_MS);
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

function eventMatches(event: UiohookKeyboardEvent, spec: QuickSpec): boolean {
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
  if (quickHook && quickKeyboardListener) {
    quickHook.off?.('keydown', quickKeyboardListener);
    quickHook.removeListener?.('keydown', quickKeyboardListener);
  }
  if (quickHook && quickWheelListener) {
    quickHook.off?.('wheel', quickWheelListener);
    quickHook.removeListener?.('wheel', quickWheelListener);
  }
  if (quickHook && (quickKeyboardListener || quickWheelListener)) {
    quickHook.stop();
  }
  quickHook = null;
  quickKeyboardListener = null;
  quickWheelListener = null;
  wheelWindowRef = null;
  clearWheelDebounceState();
}

async function registerQuickPasteHotkeys(window: BrowserWindow, hotkeys: HotkeySettings): Promise<void> {
  quickPrevSpec = parseQuickSpec(hotkeys.quickPastePrev, 203);
  quickNextSpec = parseQuickSpec(hotkeys.quickPasteNext, 205);
  wheelWindowRef = window;
  const prev = toElectronAccelerator(hotkeys.quickPastePrev, 'CommandOrControl+Alt+Left');
  const next = toElectronAccelerator(hotkeys.quickPasteNext, 'CommandOrControl+Alt+Right');

  const prevRegistered = safeRegister(prev, () => {
    void quickPaste('older', window);
  });
  const nextRegistered = safeRegister(next, () => {
    void quickPaste('newer', window);
  });

  const needKeyboardFallback = !prevRegistered || !nextRegistered;
  const needWheelHook = wheelOptions.enabled;

  if (!needKeyboardFallback && !needWheelHook) {
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

    if (needKeyboardFallback) {
      quickKeyboardListener = (event: UiohookKeyboardEvent) => {
        if (!prevRegistered && eventMatches(event, quickPrevSpec)) {
          void quickPaste('older', window);
        } else if (!nextRegistered && eventMatches(event, quickNextSpec)) {
          void quickPaste('newer', window);
        }
      };
      hook.on('keydown', quickKeyboardListener);
    }

    if (needWheelHook) {
      quickWheelListener = (event: UiohookWheelEvent) => {
        handleWheelEvent(event);
      };
      hook.on('wheel', quickWheelListener);
    }

    if (!quickKeyboardListener && !quickWheelListener) {
      logger.info('hotkeys', '快速粘贴使用 globalShortcut 通道');
      return;
    }

    hook.start();
    quickHook = hook;
    if (needKeyboardFallback && needWheelHook) {
      logger.info('hotkeys', '已启用 uiohook 作为快速粘贴键盘补充与滚轮监听通道');
    } else if (needKeyboardFallback) {
      logger.info('hotkeys', '已启用 uiohook 作为快速粘贴补充通道');
    } else {
      logger.info('hotkeys', '已启用 uiohook 滚轮快捷键监听');
    }
  } catch (error) {
    logger.warn('hotkeys', `uiohook 不可用，仅使用 globalShortcut: ${String(error)}`);
  }
}

export function applyWheelShortcutSettings(settings: Pick<AppSettings, 'wheelShortcutEnabled' | 'wheelShortcutModifier' | 'wheelShortcutScope'>): void {
  wheelOptions = {
    enabled: settings.wheelShortcutEnabled,
    modifier: settings.wheelShortcutModifier,
    scope: settings.wheelShortcutScope
  };
  if (!wheelOptions.enabled) {
    clearWheelDebounceState();
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
