import fs from 'node:fs';
import path from 'node:path';
import { Menu, Tray, app, nativeImage, screen, type BrowserWindow, type NativeImage } from 'electron';
import { logger } from '../logger/logger';

interface TrayActions {
  toggleWindow: () => void;
  toggleMonitoring: () => boolean;
  clearHistory: () => void;
  openSettings: () => void;
  quit: () => void;
  isMonitoring: () => boolean;
}

let tray: Tray | null = null;
let activeIcon: NativeImage | null = null;
let pausedIcon: NativeImage | null = null;

function createFallbackIcon(color: string): Electron.NativeImage {
  const svg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">
    <rect x="5" y="4" width="22" height="24" rx="5" fill="${color}" />
    <rect x="11" y="2" width="10" height="4" rx="2" fill="#1f2937" />
    <rect x="11" y="12" width="10" height="2.5" rx="1" fill="#f8fafc" />
    <rect x="11" y="17" width="10" height="2.5" rx="1" fill="#f8fafc" />
  </svg>
  `;
  let image = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
  if (process.platform === 'win32') {
    const targetSize = screen.getPrimaryDisplay().scaleFactor > 1.25 ? 32 : 16;
    image = image.resize({ width: targetSize, height: targetSize });
  }
  return image;
}

function resolveTrayIconPath(name: string): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, name);
  }
  return path.join(app.getAppPath(), 'resources', name);
}

function loadTrayIcon(name: string, fallbackColor: string): NativeImage {
  const iconPath = resolveTrayIconPath(name);
  if (fs.existsSync(iconPath)) {
    let icon = nativeImage.createFromPath(iconPath);
    if (!icon.isEmpty()) {
      if (process.platform === 'win32') {
        const targetSize = screen.getPrimaryDisplay().scaleFactor > 1.25 ? 32 : 16;
        icon = icon.resize({ width: targetSize, height: targetSize });
      }
      logger.info('tray', `托盘图标加载成功: ${iconPath}`);
      return icon;
    }
  }
  logger.warn('tray', `托盘图标加载失败，使用回退图标: ${iconPath}`);
  return createFallbackIcon(fallbackColor);
}

function ensureTrayIcons(): void {
  const scaleFactor = screen.getPrimaryDisplay().scaleFactor;
  const activeName = scaleFactor > 1.25 ? 'tray-icon@2x.png' : 'tray-icon.png';
  const pausedName = scaleFactor > 1.25 ? 'tray-icon-paused@2x.png' : 'tray-icon-paused.png';
  if (!activeIcon) {
    activeIcon = loadTrayIcon(activeName, '#1FA88E');
  }
  if (!pausedIcon) {
    pausedIcon = loadTrayIcon(pausedName, '#ef4444');
  }
}

function buildMenu(actions: TrayActions): Menu {
  const active = actions.isMonitoring();
  return Menu.buildFromTemplate([
    {
      label: '打开 ClipVault',
      click: actions.toggleWindow
    },
    {
      label: active ? '暂停监听' : '恢复监听',
      click: () => {
        actions.toggleMonitoring();
        refreshTrayMenu(actions);
      }
    },
    {
      label: '清空历史',
      click: actions.clearHistory
    },
    {
      label: '设置',
      click: actions.openSettings
    },
    {
      type: 'separator'
    },
    {
      label: '退出',
      click: actions.quit
    }
  ]);
}

export function createTray(window: BrowserWindow, actions: TrayActions): Tray {
  ensureTrayIcons();
  tray = new Tray(actions.isMonitoring() ? activeIcon! : pausedIcon!);
  tray.setToolTip('ClipVault - 智能剪贴板管理器');
  tray.on('click', () => {
    actions.toggleWindow();
  });
  tray.setContextMenu(buildMenu(actions));
  window.on('show', () => refreshTrayMenu(actions));
  window.on('hide', () => refreshTrayMenu(actions));
  return tray;
}

export function refreshTrayMenu(actions: TrayActions): void {
  if (!tray) {
    return;
  }
  ensureTrayIcons();
  tray.setImage(actions.isMonitoring() ? activeIcon! : pausedIcon!);
  tray.setContextMenu(buildMenu(actions));
}

export function destroyTray(): void {
  if (tray) {
    tray.destroy();
    tray = null;
  }
  activeIcon = null;
  pausedIcon = null;
}
