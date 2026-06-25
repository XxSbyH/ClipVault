import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import type { QuickPasteCursorPayload } from '@shared/types';
import { useClipboardData } from '@/hooks/useClipboard';
import { useClipboardStore } from '@/store/clipboardStore';

const {
  getHistoryMock,
  getHistoryRevisionMock,
  getSettingsMock,
  offNewItemMock,
  offQuickPasteCursorMock,
  rendererReadyMock,
  quickPasteCursorHandlerRef
} = vi.hoisted(() => ({
  getHistoryMock: vi.fn(),
  getHistoryRevisionMock: vi.fn(),
  getSettingsMock: vi.fn(),
  offNewItemMock: vi.fn(),
  offQuickPasteCursorMock: vi.fn(),
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
    onNewItem: vi.fn(() => offNewItemMock),
    onQuickPasteCursor: vi.fn((handler: (payload: QuickPasteCursorPayload) => void) => {
      quickPasteCursorHandlerRef.current = handler;
      return offQuickPasteCursorMock;
    }),
    rendererReady: rendererReadyMock
  }
}));

function Harness(): null {
  useClipboardData();
  return null;
}

describe('useClipboardData', () => {
  beforeEach(() => {
    getHistoryMock.mockResolvedValue([]);
    getHistoryRevisionMock.mockResolvedValue(0);
    getSettingsMock.mockResolvedValue({
      retentionDays: 7,
      maxItems: 10000,
      enableSensitiveFilter: true,
      enableBlacklist: true,
      textLimitKb: 100,
      imageCompression: 'high',
      themeMode: 'system',
      launchOnStartup: false,
      wheelShortcutEnabled: true,
      wheelShortcutModifier: 'ctrl',
      wheelShortcutScope: 'global'
    });
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
});
