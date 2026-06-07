import { describe, expect, it } from 'vitest';
import type { ClipboardItem } from '@shared/types';
import { itemMatchesSearchQuery, parseRegexQuery } from '@/lib/search';

function makeItem(overrides: Partial<ClipboardItem> = {}): ClipboardItem {
  return {
    id: 1,
    content: 'token-ABC-7788',
    contentType: 'text',
    contentHash: 'hash',
    preview: 'token-ABC-7788',
    metadata: {
      fileName: 'clipvault.log'
    },
    filePath: 'D:/tmp/clipvault.log',
    imageData: null,
    createdAt: 1,
    lastUsedAt: null,
    useCount: 0,
    isPinned: false,
    isFavorite: false,
    ...overrides
  };
}

describe('search helpers', () => {
  it('parses slash regex queries with flags', () => {
    const regex = parseRegexQuery('/token-[a-z]+/i');

    expect(regex).toBeInstanceOf(RegExp);
    expect(regex?.test('TOKEN-abc')).toBe(true);
  });

  it('parses re: regex queries as case-insensitive', () => {
    const regex = parseRegexQuery('re:clipvault');

    expect(regex).toBeInstanceOf(RegExp);
    expect(regex?.test('ClipVault')).toBe(true);
  });

  it('falls back to plain text when regex is invalid', () => {
    const item = makeItem({ preview: '/broken[' });

    expect(parseRegexQuery('/broken[/')).toBeNull();
    expect(itemMatchesSearchQuery(item, '/broken[')).toBe(true);
  });

  it('matches regex across preview, content, filename and path', () => {
    expect(itemMatchesSearchQuery(makeItem(), '/abc-\\d{4}/i')).toBe(true);
    expect(itemMatchesSearchQuery(makeItem(), '/clipvault\\.log$/i')).toBe(true);
    expect(itemMatchesSearchQuery(makeItem(), '/missing/')).toBe(false);
  });
});
