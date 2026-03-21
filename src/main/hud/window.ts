import { join } from 'node:path';
import { BrowserWindow, screen } from 'electron';
import type { ClipboardItem, HudPayload } from '@shared/types';
import { logger } from '../logger/logger';

type HudDirection = 'prev' | 'next';

const HUD_MIN_WIDTH = 420;
const HUD_MAX_WIDTH = 560;
const HUD_HEIGHT = 76;
const HUD_TOP_OFFSET = 20;
const HUD_HIDE_DELAY = 2500;
const HUD_CONTINUOUS_HIDE_DELAY = 6500;
const HUD_CONTINUOUS_WINDOW = 4000;
const HUD_CHANNEL = 'hud:show';

let hudWindow: BrowserWindow | null = null;
let hideTimer: NodeJS.Timeout | null = null;
let pendingPayload: HudPayload | null = null;
let hideToken = 0;
let lastBounds: { x: number; y: number; width: number; height: number } | null = null;
let lastShowAt = 0;
let continuousStreak = 0;

function getHudBounds(): { x: number; y: number; width: number; height: number } {
  const cursorPoint = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursorPoint);
  const width = Math.max(
    HUD_MIN_WIDTH,
    Math.min(HUD_MAX_WIDTH, Math.floor(display.workArea.width * 0.44))
  );
  return {
    x: display.workArea.x + Math.floor((display.workArea.width - width) / 2),
    y: display.workArea.y + HUD_TOP_OFFSET,
    width,
    height: HUD_HEIGHT
  };
}

function scheduleHide(): void {
  const now = Date.now();
  if (now - lastShowAt <= HUD_CONTINUOUS_WINDOW) {
    continuousStreak += 1;
  } else {
    continuousStreak = 1;
  }
  lastShowAt = now;
  const hideDelay = continuousStreak >= 2 ? HUD_CONTINUOUS_HIDE_DELAY : HUD_HIDE_DELAY;

  if (hideTimer) {
    clearTimeout(hideTimer);
  }
  const token = ++hideToken;
  hideTimer = setTimeout(() => {
    if (token !== hideToken) {
      return;
    }
    if (hudWindow && !hudWindow.isDestroyed()) {
      hudWindow.hide();
    }
    hideTimer = null;
    continuousStreak = 0;
  }, hideDelay);
}

function setHudBoundsIfNeeded(bounds: { x: number; y: number; width: number; height: number }): void {
  if (!hudWindow || hudWindow.isDestroyed()) {
    return;
  }
  const same =
    lastBounds &&
    lastBounds.x === bounds.x &&
    lastBounds.y === bounds.y &&
    lastBounds.width === bounds.width &&
    lastBounds.height === bounds.height;
  if (same) {
    return;
  }
  hudWindow.setBounds(bounds, false);
  lastBounds = bounds;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function formatContentForHud(item: ClipboardItem): string {
  if (item.contentType === 'image') {
    return item.metadata.fileName || item.preview || '图片';
  }
  if (item.contentType === 'file') {
    const path = item.filePath || item.content || '';
    const filename = path.split(/[\\/]/).filter(Boolean).pop();
    return item.metadata.fileName || filename || '文件';
  }
  const text = normalizeText(item.preview || item.content || '');
  if (!text) {
    return '空内容';
  }
  return text.length > 80 ? `${text.slice(0, 80)}...` : text;
}

function toHudPayload(item: ClipboardItem, direction: HudDirection): HudPayload {
  return {
    direction,
    type: item.contentType,
    text: formatContentForHud(item)
  };
}

function sendHudPayload(payload: HudPayload): void {
  if (!hudWindow || hudWindow.isDestroyed()) {
    return;
  }
  if (hudWindow.webContents.isLoadingMainFrame()) {
    pendingPayload = payload;
    return;
  }

  hudWindow.webContents.send(HUD_CHANNEL, payload);
  if (!hudWindow.isVisible()) {
    hudWindow.showInactive();
    if (!hudWindow.isVisible()) {
      hudWindow.show();
    }
  }
  hudWindow.moveTop();
  scheduleHide();
}

function createHudWindow(): BrowserWindow {
  if (hudWindow && !hudWindow.isDestroyed()) {
    return hudWindow;
  }

  const bounds = getHudBounds();
  hudWindow = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    focusable: false,
    show: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  hudWindow.setAlwaysOnTop(true, 'screen-saver');
  hudWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  hudWindow.setIgnoreMouseEvents(true, { forward: true });
  logger.info('hud', 'HUD 窗口创建完成');

  hudWindow.on('closed', () => {
    hudWindow = null;
    pendingPayload = null;
  });

  hudWindow.webContents.on('did-finish-load', () => {
    if (pendingPayload) {
      sendHudPayload(pendingPayload);
      pendingPayload = null;
    }
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    logger.info('hud', `HUD 加载开发地址: ${process.env.ELECTRON_RENDERER_URL}/hud.html`);
    void hudWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}/hud.html`);
  } else {
    logger.info('hud', 'HUD 加载生产页面: dist/renderer/hud.html');
    void hudWindow.loadFile(join(__dirname, '../../dist/renderer/hud.html'));
  }

  return hudWindow;
}

export function showQuickPasteHud(item: ClipboardItem, direction: HudDirection): void {
  try {
    createHudWindow();
    const bounds = getHudBounds();
    setHudBoundsIfNeeded(bounds);
    const payload = toHudPayload(item, direction);
    sendHudPayload(payload);
    logger.info('hud', `显示 HUD: ${payload.direction} ${payload.type} ${payload.text.slice(0, 40)}`);
  } catch (error) {
    logger.warn('hud', `显示 HUD 失败: ${String(error)}`);
  }
}

export function prepareHudWindow(): void {
  try {
    createHudWindow();
  } catch (error) {
    logger.warn('hud', `预创建 HUD 失败: ${String(error)}`);
  }
}

export function destroyHudWindow(): void {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  if (hudWindow && !hudWindow.isDestroyed()) {
    hudWindow.destroy();
  }
  hudWindow = null;
  pendingPayload = null;
  lastBounds = null;
  hideToken += 1;
}
