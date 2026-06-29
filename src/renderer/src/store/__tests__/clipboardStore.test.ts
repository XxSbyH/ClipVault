import { beforeEach, describe, expect, it } from 'vitest';
import type { ClipboardItem } from '@shared/types';
import { useClipboardStore } from '@/store/clipboardStore';

function item(id: number, overrides: Partial<ClipboardItem> = {}): ClipboardItem {
  return {
    id,
    content: `item ${id}`,
    contentType: 'text',
    contentHash: `hash-${id}`,
    preview: `item ${id}`,
    metadata: {},
    filePath: null,
    imageData: null,
    createdAt: 1_700_000_000_000 + id,
    lastUsedAt: null,
    useCount: 0,
    isPinned: false,
    isFavorite: false,
    ...overrides
  };
}

describe('clipboardStore sorting', () => {
  beforeEach(() => {
    useClipboardStore.setState({
      items: [],
      selectedType: 'all',
      selectedItemId: null,
      searchQuery: '',
      settings: null
    });
  });

  it('sorts pinned first and then by recent active time', () => {
    useClipboardStore.getState().setItems([
      item(1, { createdAt: 100, lastUsedAt: 500 }),
      item(2, { createdAt: 400 }),
      item(3, { createdAt: 50, lastUsedAt: 200, isPinned: true })
    ]);

    expect(useClipboardStore.getState().items.map((entry) => entry.id)).toEqual([3, 1, 2]);
  });

  it('upsert moves a recently used item to the top of its pinned group', () => {
    useClipboardStore.getState().setItems([item(1, { createdAt: 100 }), item(2, { createdAt: 300 })]);

    useClipboardStore.getState().upsertItem(item(1, { createdAt: 100, lastUsedAt: 500, useCount: 1 }));

    expect(useClipboardStore.getState().items.map((entry) => entry.id)).toEqual([1, 2]);
  });
});
