import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

let currentLevel: LogLevel = 'info';
let logDirReady = false;
let pendingLines: string[] = [];
let flushing = false;
let flushScheduled = false;

function flushPendingLogs(): void {
  flushScheduled = false;
  if (flushing || pendingLines.length === 0) {
    return;
  }

  flushing = true;
  const output = pendingLines.join('');
  pendingLines = [];

  try {
    ensureLogDir();
    fs.appendFile(getLogFilePath(), output, 'utf8', () => {
      flushing = false;
      if (pendingLines.length > 0) {
        flushPendingLogs();
      }
    });
  } catch {
    flushing = false;
  }
}

function getLogDir(): string {
  return path.join(app.getPath('userData'), 'logs');
}

function getLogFilePath(date = new Date()): string {
  const day = date.toISOString().slice(0, 10);
  return path.join(getLogDir(), `app-${day}.log`);
}

function ensureLogDir(): void {
  if (logDirReady) {
    return;
  }
  const dir = getLogDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  logDirReady = true;
}

export function initLogger(level: LogLevel = 'info'): void {
  currentLevel = level;
  ensureLogDir();
  rotateLogs(7);
}

function rotateLogs(keepDays: number): void {
  const dir = getLogDir();
  if (!fs.existsSync(dir)) {
    return;
  }

  const now = Date.now();
  const maxAge = keepDays * 24 * 60 * 60 * 1000;
  const files = fs.readdirSync(dir);

  for (const file of files) {
    const full = path.join(dir, file);
    const stat = fs.statSync(full);
    if (now - stat.mtimeMs > maxAge) {
      fs.rmSync(full, { force: true });
    }
  }
}

function write(level: LogLevel, module: string, message: string): void {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[currentLevel]) {
    return;
  }

  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] [${module}] ${message}\n`;
  pendingLines.push(line);
  if (flushScheduled) {
    return;
  }
  flushScheduled = true;
  setTimeout(() => {
    flushPendingLogs();
  }, 0);
}

export const logger = {
  debug(module: string, message: string): void {
    write('debug', module, message);
  },
  info(module: string, message: string): void {
    write('info', module, message);
  },
  warn(module: string, message: string): void {
    write('warn', module, message);
  },
  error(module: string, message: string): void {
    write('error', module, message);
  }
};
