import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ClipboardItem } from '@shared/types';
import { QuickSearchOverlay } from '@/components/QuickSearchOverlay';

const {
  copyItemMock,
  getHistoryMock,
  hideSearchWindowMock,
  onQuickSearchOpenedMock,
  pasteItemMock,
  searchItemsMock
} = vi.hoisted(() => ({
  copyItemMock: vi.fn(),
  getHistoryMock: vi.fn(),
  hideSearchWindowMock: vi.fn(),
  onQuickSearchOpenedMock: vi.fn(),
  pasteItemMock: vi.fn(),
  searchItemsMock: vi.fn()
}));

vi.mock('@/lib/tauriApi', () => ({
  clipboardApi: {
    copyItem: copyItemMock,
    getHistory: getHistoryMock,
    hideSearchWindow: hideSearchWindowMock,
    onQuickSearchOpened: onQuickSearchOpenedMock,
    pasteItem: pasteItemMock,
    searchItems: searchItemsMock
  }
}));

function makeItem(id: number, preview: string, overrides: Partial<ClipboardItem> = {}): ClipboardItem {
  return {
    id,
    content: preview,
    contentType: 'text',
    contentHash: `hash-${id}`,
    preview,
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

describe('QuickSearchOverlay', () => {
  beforeEach(() => {
    getHistoryMock.mockResolvedValue([makeItem(1, 'alpha'), makeItem(2, 'bravo')]);
    searchItemsMock.mockResolvedValue([makeItem(3, 'needle result'), makeItem(4, 'needle backup')]);
    pasteItemMock.mockResolvedValue({ success: true });
    copyItemMock.mockResolvedValue({ success: true });
    hideSearchWindowMock.mockResolvedValue(undefined);
    onQuickSearchOpenedMock.mockReturnValue(vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('loads recent items, searches typed text, and selects with arrow keys', async () => {
    render(<QuickSearchOverlay />);

    expect(getHistoryMock).toHaveBeenCalledWith(20);
    expect(await screen.findByRole('option', { name: /alpha/ })).toHaveAttribute('aria-selected', 'true');

    fireEvent.change(screen.getByLabelText('搜索剪贴板历史'), { target: { value: 'needle' } });

    await waitFor(() => {
      expect(searchItemsMock).toHaveBeenCalledWith('needle', 20);
    });
    expect(await screen.findByRole('option', { name: /needle result/ })).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(window, { key: 'ArrowDown' });

    expect(screen.getByRole('option', { name: /needle backup/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('single-clicks only select and double-clicks paste then close', async () => {
    render(<QuickSearchOverlay />);

    const bravo = await screen.findByRole('option', { name: /bravo/ });
    fireEvent.click(bravo);

    expect(bravo).toHaveAttribute('aria-selected', 'true');
    expect(copyItemMock).not.toHaveBeenCalled();
    expect(pasteItemMock).not.toHaveBeenCalled();

    fireEvent.doubleClick(bravo);

    await waitFor(() => {
      expect(pasteItemMock).toHaveBeenCalledWith(2);
    });
    expect(hideSearchWindowMock).toHaveBeenCalledTimes(1);
  });

  it('uses keyboard commands for paste, copy, and close', async () => {
    render(<QuickSearchOverlay />);

    await screen.findByRole('option', { name: /alpha/ });
    fireEvent.keyDown(window, { key: 'Enter' });

    await waitFor(() => {
      expect(pasteItemMock).toHaveBeenCalledWith(1);
    });
    expect(hideSearchWindowMock).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: 'c', ctrlKey: true });

    await waitFor(() => {
      expect(copyItemMock).toHaveBeenCalledWith(1);
    });
    expect(hideSearchWindowMock).toHaveBeenCalledTimes(2);

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(hideSearchWindowMock).toHaveBeenCalledTimes(3);
  });

  it('closes when clicking outside the quick search panel', async () => {
    render(<QuickSearchOverlay />);

    await screen.findByRole('option', { name: /alpha/ });
    fireEvent.mouseDown(screen.getByTestId('quick-search-backdrop'));

    expect(hideSearchWindowMock).toHaveBeenCalledTimes(1);
  });

  it('positions the quick search panel toward the upper-right of its transparent window', async () => {
    render(<QuickSearchOverlay />);

    await screen.findByRole('option', { name: /alpha/ });
    expect(screen.getByTestId('quick-search-backdrop')).toHaveClass('items-start');
    expect(screen.getByTestId('quick-search-backdrop')).toHaveClass('justify-end');
  });
});
