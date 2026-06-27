import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import type { ClipboardItem, QuickPasteCursorPayload } from '@shared/types';
import { useClipboardData } from '@/hooks/useClipboard';
import { useClipboardStore } from '@/store/clipboardStore';

const {
  getHistoryMock,
  getHistoryRevisionMock,
  getSettingsMock,
  offNewItemMock,
  offQuickPasteCursorMock,
  newItemHandlerRef,
  rendererReadyMock,
  quickPasteCursorHandlerRef
} = vi.hoisted(() => ({
  getHistoryMock: vi.fn(),
  getHistoryRevisionMock: vi.fn(),
  getSettingsMock: vi.fn(),
  offNewItemMock: vi.fn(),
  offQuickPasteCursorMock: vi.fn(),
  newItemHandlerRef: {
    current: undefined as undefined | ((item: ClipboardItem) => void)
  },
  rendererReadyMock: vi.fn(),
  quickPasteCursorHandlerRef: {
    current: undefined as undefined | ((payload: QuickPasteCursorPayload) => void)
  }
}));

vi.mock('@/lib/tauriApi', () => ({
  clipboardApi: {
    getHistory: getHistoryMock,
    getHistoryRevision: getHistoryRevisionMock,
    getSettings: getSettingsMock,
    onNewItem: vi.fn((handler: (item: ClipboardItem) => void) => {
      newItemHandlerRef.current = handler;
      return offNewItemMock;
    }),
    onQuickPasteCursor: vi.fn((handler: (payload: QuickPasteCursorPayload) => void) => {
      quickPasteCursorHandlerRef.current = handler;
      return offQuickPasteCursorMock;
    }),
    rendererReady: rendererReadyMock
  }
}));

function makeItem(id: number, preview: string): ClipboardItem {
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
    isFavorite: false
  };
}

function Harness(): null {
  useClipboardData();
  return null;
}

describe('useClipboardData', () => {
  beforeEach(() => {
    getHistoryMock.mockResolvedValue([]);
    getHistoryRevisionMock.mockResolvedValue(0);
    getSettingsMock.mockResolvedValue({
      retentionDays: 0,
      maxItems: 10000,
      enableSensitiveFilter: true,
      enableBlacklist: true,
      textLimitKb: 100,
      imageCompression: 'high',
      themeMode: 'system',
      launchOnStartup: true,
      wheelShortcutEnabled: true,
      wheelShortcutModifier: 'ctrl',
      wheelShortcutScope: 'global'
    });
    newItemHandlerRef.current = undefined;
    quickPasteCursorHandlerRef.current = undefined;
    useClipboardStore.setState({
      items: [],
      selectedItemId: null,
      selectedType: 'all',
      searchQuery: '',
      settings: null
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('syncs selected item from quick paste cursor events', async () => {
    render(<Harness />);

    await waitFor(() => {
      expect(quickPasteCursorHandlerRef.current).toBeTypeOf('function');
    });
    quickPasteCursorHandlerRef.current?.({ selectedItemId: 2, boundary: null });

    expect(useClipboardStore.getState().selectedItemId).toBe(2);
  });

  it('selects the newest item when clipboard capture adds history', async () => {
    render(<Harness />);

    await waitFor(() => {
      expect(newItemHandlerRef.current).toBeTypeOf('function');
    });
    newItemHandlerRef.current?.(makeItem(9, 'new clipboard text'));

    expect(useClipboardStore.getState().selectedItemId).toBe(9);
  });
});
