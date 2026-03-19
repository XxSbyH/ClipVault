import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { clipboard, nativeImage, type BrowserWindow } from 'electron';
import { getItemById, incrementUseStats } from '../database';
import { logger } from '../logger/logger';

const execFileAsync = promisify(execFile);

async function sendCtrlV(): Promise<void> {
  const cmd = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')`;
  await execFileAsync('powershell', ['-NoProfile', '-Command', cmd]);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function pasteItem(itemId: number, window?: BrowserWindow | null): Promise<{
  success: boolean;
  error?: string;
}> {
  const item = getItemById(itemId);
  if (!item) {
    return { success: false, error: '条目不存在' };
  }

  try {
    if (item.contentType === 'image' && item.imageData) {
      clipboard.writeImage(nativeImage.createFromBuffer(Buffer.from(item.imageData)));
    } else if (item.contentType === 'file') {
      clipboard.writeText(item.filePath ?? item.content ?? '');
    } else {
      clipboard.writeText(item.content ?? '');
    }

    if (window && window.isVisible()) {
      window.hide();
    }

    await wait(120);
    try {
      await sendCtrlV();
    } catch (error) {
      logger.warn('paste', `模拟 Ctrl+V 失败，但内容已写入剪贴板: ${String(error)}`);
    }
    incrementUseStats(itemId);
    return { success: true };
  } catch (error) {
    logger.error('paste', `pasteItem(${itemId}) 失败: ${String(error)}`);
    return { success: false, error: '粘贴失败，请重试' };
  }
}
