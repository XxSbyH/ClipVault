import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ClipboardItem } from '@shared/types';
import { ClipboardDetail } from '@/components/ClipboardDetail';
import { useClipboardStore } from '@/store/clipboardStore';

const { copyItemMock, getImageDataUrlMock } = vi.hoisted(() => ({
  copyItemMock: vi.fn(),
  getImageDataUrlMock: vi.fn()
}));

vi.mock('@/lib/tauriApi', () => ({
  clipboardApi: {
    copyItem: copyItemMock,
    getImageDataUrl: getImageDataUrlMock
  }
}));

function makeItem(overrides: Partial<ClipboardItem> = {}): ClipboardItem {
  return {
    id: 1,
    content: 'first line\nsecond line\nthird line',
    contentType: 'text',
    contentHash: 'hash-1',
    preview: 'first line...',
    metadata: {},
    filePath: null,
    imageData: null,
    createdAt: 1_700_000_000_000,
    lastUsedAt: null,
    useCount: 0,
    isPinned: false,
    isFavorite: false,
    ...overrides
  };
}

describe('ClipboardDetail', () => {
  beforeEach(() => {
    copyItemMock.mockResolvedValue({ success: true });
    getImageDataUrlMock.mockResolvedValue(null);
    useClipboardStore.setState({
      items: [makeItem()],
      selectedItemId: 1,
      selectedType: 'all',
      searchQuery: '',
      settings: null
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders full text content instead of the shortened preview', () => {
    render(<ClipboardDetail />);

    expect(
      screen.getByText((_, node) => node?.textContent === 'first line\nsecond line\nthird line')
    ).toBeInTheDocument();
    expect(screen.queryByText('first line...')).not.toBeInTheDocument();
  });
});
