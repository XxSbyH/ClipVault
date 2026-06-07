import type { ClipboardItem } from '@shared/types';

const REGEX_FLAGS = /^[dgimsuvy]*$/;

export function parseRegexQuery(query: string): RegExp | null {
  const trimmed = query.trim();
  if (trimmed.startsWith('re:') && trimmed.length > 3) {
    try {
      return new RegExp(trimmed.slice(3), 'i');
    } catch {
      return null;
    }
  }

  if (!trimmed.startsWith('/') || trimmed.length < 3) {
    return null;
  }

  const lastSlash = trimmed.lastIndexOf('/');
  if (lastSlash <= 0) {
    return null;
  }

  const pattern = trimmed.slice(1, lastSlash);
  const flags = trimmed.slice(lastSlash + 1);
  if (!REGEX_FLAGS.test(flags)) {
    return null;
  }

  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

function searchableValues(item: ClipboardItem): string[] {
  return [item.preview, item.content, item.filePath, item.metadata.fileName]
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
}

export function itemMatchesSearchQuery(item: ClipboardItem, query: string): boolean {
  const trimmed = query.trim();
  if (!trimmed) {
    return true;
  }

  const regex = parseRegexQuery(trimmed);
  if (regex) {
    return searchableValues(item).some((value) => {
      regex.lastIndex = 0;
      return regex.test(value);
    });
  }

  const needle = trimmed.toLowerCase();
  return searchableValues(item).some((value) => value.toLowerCase().includes(needle));
}
