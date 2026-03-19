import { clipboard } from 'electron';
import CryptoJS from 'crypto-js';
import type { AppSettings, ClipboardItem, ClipboardInsertInput } from '@shared/types';
import { getSettings, insertClipboardItem } from '../database';
import { logger } from '../logger/logger';
import { isBlacklistedForegroundApp } from '../privacy/blacklist';
import { isSensitiveContent } from '../privacy/filter';
import { createPreview, detectContentType, getFileMetadata, parseSingleFilePath } from './detector';
import { compressImage } from './imageProcessor';

type NewItemHandler = (item: ClipboardItem) => void;
export interface MonitoringDiagnostics {
  monitorEnabled: boolean;
  monitorStarted: boolean;
  hasTimer: boolean;
  isRunning: boolean;
  lastHashPrefix: string;
}

let monitorTimer: NodeJS.Timeout | null = null;
let monitorEnabled = true;
let monitorStarted = false;
let lastHash = '';
let isRunning = false;
let nextImageScanAt = 0;
let nextBlacklistCheckAt = 0;
let lastBlacklistResult = false;
let cachedSettings: AppSettings | null = null;
let settingsCachedAt = 0;

const SETTINGS_CACHE_MS = 2000;
const BLACKLIST_CHECK_INTERVAL_MS = 3000;
const IMAGE_SCAN_INTERVAL_MS = 1200;
const MONITOR_INTERVAL_MS = 800;

function getCachedSettings(): AppSettings {
  const now = Date.now();
  if (cachedSettings && now - settingsCachedAt < SETTINGS_CACHE_MS) {
    return cachedSettings;
  }
  cachedSettings = getSettings();
  settingsCachedAt = now;
  return cachedSettings;
}

function generateImageFilename(timestamp: number): string {
  const date = new Date(timestamp);
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `截图_${yyyy}-${mm}-${dd}_${hh}-${mi}-${ss}.png`;
}

function hashText(text: string): string {
  return CryptoJS.MD5(text).toString();
}

function hashBuffer(buffer: Buffer): string {
  return CryptoJS.MD5(CryptoJS.enc.Hex.parse(buffer.toString('hex'))).toString();
}

async function captureText(handler: NewItemHandler): Promise<boolean> {
  const rawText = clipboard.readText();
  const text = rawText.trim();
  if (!text) {
    return false;
  }

  const settings = getCachedSettings();
  if (settings.enableSensitiveFilter && isSensitiveContent(text)) {
    logger.info('clipboard', '命中敏感内容过滤，已跳过');
    return false;
  }
  if (text.length > settings.textLimitKb * 1024) {
    logger.warn('clipboard', `文本超出限制，长度: ${text.length}`);
    return false;
  }

  const contentType = detectContentType(text);
  const hash = hashText(`${contentType}:${text}`);
  if (hash === lastHash) {
    logger.debug('clipboard', '文本哈希未变化，跳过本次记录');
    return false;
  }

  const input: ClipboardInsertInput = {
    content: text,
    contentType,
    contentHash: hash,
    preview: createPreview(text),
    metadata: {}
  };

  if (contentType === 'file') {
    const filePath = parseSingleFilePath(text);
    if (filePath) {
      input.filePath = filePath;
      input.metadata = getFileMetadata(filePath);
    }
  }

  const inserted = insertClipboardItem(input);
  if (inserted) {
    lastHash = hash;
    logger.info('clipboard', `记录新文本成功: id=${inserted.id}, type=${inserted.contentType}`);
    handler(inserted);
    return true;
  }
  return false;
}

async function captureImage(handler: NewItemHandler): Promise<boolean> {
  const image = clipboard.readImage();
  if (image.isEmpty()) {
    return false;
  }
  const pngBuffer = image.toPNG();
  if (!pngBuffer || pngBuffer.length === 0) {
    return false;
  }

  const hash = hashBuffer(pngBuffer);
  if (hash === lastHash) {
    logger.debug('clipboard', '图片哈希未变化，跳过本次记录');
    return false;
  }

  const processed = await compressImage(pngBuffer);
  const filename = generateImageFilename(Date.now());
  const input: ClipboardInsertInput = {
    content: filename,
    contentType: 'image',
    contentHash: hash,
    preview: filename,
    imageData: processed.buffer,
    metadata: {
      fileName: filename,
      fileExt: '.png',
      fileSize: processed.compressedSize,
      originalSize: processed.originalSize,
      compressedSize: processed.compressedSize,
      imageWidth: processed.width,
      imageHeight: processed.height
    }
  };
  const inserted = insertClipboardItem(input);
  if (inserted) {
    lastHash = hash;
    logger.info('clipboard', `记录新图片成功: id=${inserted.id}, file=${filename}`);
    handler(inserted);
    return true;
  }
  return false;
}

async function tick(handler: NewItemHandler): Promise<void> {
  if (!monitorEnabled || isRunning) {
    return;
  }

  isRunning = true;
  try {
    const settings = getCachedSettings();
    if (settings.enableBlacklist) {
      const now = Date.now();
      if (now >= nextBlacklistCheckAt) {
        lastBlacklistResult = await isBlacklistedForegroundApp();
        nextBlacklistCheckAt = now + BLACKLIST_CHECK_INTERVAL_MS;
      }
      if (lastBlacklistResult) {
        return;
      }
    }

    const capturedText = await captureText(handler);
    if (!capturedText) {
      const hasImageFormat = clipboard
        .availableFormats()
        .some((format) => format.toLowerCase().startsWith('image/'));
      if (!hasImageFormat) {
        nextImageScanAt = 0;
        return;
      }

      const now = Date.now();
      if (now < nextImageScanAt) {
        return;
      }
      const capturedImage = await captureImage(handler);
      if (capturedImage) {
        nextImageScanAt = 0;
      } else {
        nextImageScanAt = now + IMAGE_SCAN_INTERVAL_MS;
      }
    }
  } catch (error) {
    logger.error('clipboard', `监听失败: ${String(error)}`);
  } finally {
    isRunning = false;
  }
}

export function startMonitoring(handler: NewItemHandler): void {
  if (monitorStarted || monitorTimer) {
    logger.info('clipboard', '监听已在运行，跳过重复启动');
    return;
  }
  logger.info('clipboard', '开始启动剪贴板监听');
  monitorStarted = true;
  nextBlacklistCheckAt = Date.now() + BLACKLIST_CHECK_INTERVAL_MS;
  monitorTimer = setInterval(() => {
    void tick(handler);
  }, MONITOR_INTERVAL_MS);
  logger.info('clipboard', '剪贴板监听已启动');
}

export function stopMonitoring(): void {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
  monitorStarted = false;
  isRunning = false;
  nextImageScanAt = 0;
  nextBlacklistCheckAt = 0;
  lastBlacklistResult = false;
  cachedSettings = null;
  settingsCachedAt = 0;
  logger.info('clipboard', '剪贴板监听已停止');
}

export function isMonitoring(): boolean {
  return monitorStarted && monitorEnabled;
}

export function toggleMonitoring(): boolean {
  monitorEnabled = !monitorEnabled;
  logger.info('clipboard', `监听状态切换: ${monitorEnabled ? '启用' : '暂停'}`);
  return monitorEnabled;
}

export function getMonitoringDiagnostics(): MonitoringDiagnostics {
  return {
    monitorEnabled,
    monitorStarted,
    hasTimer: Boolean(monitorTimer),
    isRunning,
    lastHashPrefix: lastHash.slice(0, 12)
  };
}
