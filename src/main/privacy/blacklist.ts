import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { listBlacklistApps } from '../database';
import { logger } from '../logger/logger';

const execFileAsync = promisify(execFile);

let cachedProcess: string | null = null;
let cacheAt = 0;
let inFlight: Promise<string | null> | null = null;
let cachedBlacklist: string[] = [];
let blacklistCacheAt = 0;

const PROCESS_CACHE_MS = 15000;
const BLACKLIST_CACHE_MS = 10000;

async function queryForegroundProcessName(): Promise<string | null> {
  const command = `
$p = Get-Process -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 -and $_.Responding } |
  Sort-Object StartTime -Descending |
  Select-Object -First 1
if ($p) { $p.ProcessName }
`;
  const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', command]);
  const normalized = stdout.trim().toLowerCase();
  return normalized || null;
}

async function getForegroundProcessName(): Promise<string | null> {
  const now = Date.now();
  if (now - cacheAt < PROCESS_CACHE_MS) {
    return cachedProcess;
  }

  if (!inFlight) {
    inFlight = queryForegroundProcessName()
      .then((processName) => {
        cachedProcess = processName;
        cacheAt = Date.now();
        return processName;
      })
      .catch((error) => {
        logger.warn('blacklist', `读取前台进程失败: ${String(error)}`);
        cacheAt = Date.now();
        return cachedProcess;
      })
      .finally(() => {
        inFlight = null;
      });
  }

  return inFlight;
}

function getBlacklistNames(): string[] {
  const now = Date.now();
  if (now - blacklistCacheAt < BLACKLIST_CACHE_MS) {
    return cachedBlacklist;
  }
  const items = listBlacklistApps();
  cachedBlacklist = items
    .map((item) => item.appName.toLowerCase().replace('.exe', '').trim())
    .filter(Boolean);
  blacklistCacheAt = now;
  return cachedBlacklist;
}

export async function isBlacklistedForegroundApp(): Promise<boolean> {
  const blacklist = getBlacklistNames();
  if (blacklist.length === 0) {
    return false;
  }
  const processName = await getForegroundProcessName();
  if (!processName) {
    return false;
  }
  return blacklist.some((name) => processName.includes(name));
}
