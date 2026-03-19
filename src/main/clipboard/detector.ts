import fs from 'node:fs';
import path from 'node:path';
import type { ClipboardContentType } from '@shared/types';

const CODE_PATTERNS = [
  /function\s+\w+\s*\(/,
  /const\s+\w+\s*=/,
  /let\s+\w+\s*=/,
  /import\s+.*from/,
  /class\s+\w+/,
  /<[a-z][\s\S]*>/i,
  /=>\s*{/,
  /SELECT\s+.+\s+FROM/i
];

const FILE_PATH_PATTERN = /^(?:[a-zA-Z]:\\|\\\\)[^\n\r]+$/;

export function detectContentType(text: string): ClipboardContentType {
  const trimmed = text.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return 'url';
  }
  if (/^#[0-9A-Fa-f]{6}$/.test(trimmed)) {
    return 'color';
  }
  if (/^[\w.-]+@[\w.-]+\.\w+$/.test(trimmed)) {
    return 'email';
  }
  if (isFilePathText(trimmed)) {
    return 'file';
  }
  if (CODE_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return 'code';
  }
  return 'text';
}

export function createPreview(content: string, maxLength = 200): string {
  const clean = content.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLength) {
    return clean;
  }
  return `${clean.slice(0, maxLength - 1)}…`;
}

export function isFilePathText(content: string): boolean {
  if (!content) {
    return false;
  }
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return false;
  }

  return lines.every((line) => FILE_PATH_PATTERN.test(line));
}

export function parseSingleFilePath(content: string): string | null {
  const candidate = content.trim();
  if (!FILE_PATH_PATTERN.test(candidate)) {
    return null;
  }
  return path.normalize(candidate);
}

export function getFileMetadata(filePath: string): Record<string, string | number | boolean> {
  try {
    const stat = fs.statSync(filePath);
    return {
      fileName: path.basename(filePath),
      fileExt: path.extname(filePath).toLowerCase(),
      fileSize: stat.size,
      exists: true
    };
  } catch {
    return {
      fileName: path.basename(filePath),
      fileExt: path.extname(filePath).toLowerCase(),
      fileSize: 0,
      exists: false
    };
  }
}
