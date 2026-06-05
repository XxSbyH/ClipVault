import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ClipboardItem } from '@shared/types';
import { ClipboardList } from '@/components/ClipboardList';
import { useClipboardStore } from '@/store/clipboardStore';

const { pasteItemMock, deleteItemMock, hideWindowMock, listPropsMock } = vi.hoisted(() => ({
  pasteItemMock: vi.fn(),
  deleteItemMock: vi.fn(),
  hideWindowMock: vi.fn(),
  listPropsMock: vi.fn()
}));

vi.mock('@/lib/tauriApi', () => ({
  clipboardApi: {
    getHistory: vi.fn().mockResolvedValue([]),
    pasteItem: pasteItemMock,
    deleteItem: deleteItemMock,
    hideWindow: hideWindowMock,
    togglePin: vi.fn(),
    toggleFavorite: vi.fn()
  }
}));

vi.mock('react-window', async () => {
  const ReactModule = await vi.importActual<typeof React>('react');
  return {
    FixedSizeList: ReactModule.forwardRef(function FixedSizeListMock(
      {
        children,
        height,
        itemCount,
        itemSize,
        itemData
      }: {
        children: (props: { index: number; style: React.CSSProperties; data: unknown }) => React.ReactNode;
        height: number;
        itemCount: number;
        itemSize: number;
        itemData: unknown;
      },
      ref
    ) {
      ReactModule.useImperativeHandle(ref, () => ({ scrollToItem: vi.fn() }));
      listPropsMock({ height, itemCount, itemSize });
      return (
        <div data-testid="virtual-list">
          {Array.from({ length: itemCount }, (_, index) =>
            children({ index, style: {}, data: itemData })
          )}
        </div>
      );
    })
  };
});

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

describe('ClipboardList', () => {
  let resizeCallback: ResizeObserverCallback | null = null;

  beforeEach(() => {
    class ResizeObserverMock {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }

      observe() {
        resizeCallback?.([], this as unknown as ResizeObserver);
      }

      disconnect() {
        resizeCallback = null;
      }
    }

    vi.stubGlobal('ResizeObserver', ResizeObserverMock);
    pasteItemMock.mockResolvedValue({ success: true });
    deleteItemMock.mockResolvedValue({ success: true });
    hideWindowMock.mockResolvedValue(undefined);
    useClipboardStore.setState({
      items: [],
      selectedType: 'all',
      selectedItemId: null,
      searchQuery: '',
      settings: null
    });
    useClipboardStore.getState().setItems([
      makeItem(1, 'alpha'),
      makeItem(2, 'bravo', { isFavorite: true }),
      makeItem(3, 'charlie')
    ]);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('filters favorite items', () => {
    useClipboardStore.setState({ selectedType: 'favorite' });

    render(<ClipboardList />);

    expect(screen.getByText('bravo')).toBeInTheDocument();
    expect(screen.queryByText('alpha')).not.toBeInTheDocument();
    expect(screen.queryByText('charlie')).not.toBeInTheDocument();
  });

  it('selects the next item with ArrowDown', async () => {
    render(<ClipboardList />);

    await waitFor(() => {
      expect(useClipboardStore.getState().selectedItemId).toBe(3);
    });

    fireEvent.keyDown(window, { key: 'ArrowDown' });

    expect(useClipboardStore.getState().selectedItemId).toBe(2);
  });

  it('pastes the selected item with Enter', async () => {
    render(<ClipboardList />);

    await waitFor(() => {
      expect(useClipboardStore.getState().selectedItemId).toBe(3);
    });
    fireEvent.keyDown(window, { key: 'Enter' });

    expect(pasteItemMock).toHaveBeenCalledWith(3);
  });

  it('deletes the selected item with Delete', async () => {
    render(<ClipboardList />);

    await waitFor(() => {
      expect(useClipboardStore.getState().selectedItemId).toBe(3);
    });
    fireEvent.keyDown(window, { key: 'Delete' });

    await waitFor(() => {
      expect(deleteItemMock).toHaveBeenCalledWith(3);
      expect(useClipboardStore.getState().items.some((item) => item.id === 3)).toBe(false);
    });
  });

  it('hides the Tauri window with Escape', async () => {
    render(<ClipboardList />);

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(hideWindowMock).toHaveBeenCalledTimes(1);
  });

  it('ignores global shortcuts from editable or dialog targets', async () => {
    render(<ClipboardList />);
    await waitFor(() => {
      expect(useClipboardStore.getState().selectedItemId).toBe(3);
    });

    const input = document.createElement('input');
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: 'Delete' });

    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    const button = document.createElement('button');
    dialog.appendChild(button);
    document.body.appendChild(dialog);
    fireEvent.keyDown(button, { key: 'Enter' });
    fireEvent.keyDown(button, { key: 'Escape' });

    expect(deleteItemMock).not.toHaveBeenCalled();
    expect(pasteItemMock).not.toHaveBeenCalled();
    expect(hideWindowMock).not.toHaveBeenCalled();

    input.remove();
    dialog.remove();
  });

  it('passes measured container height to the virtualized list', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(512);

    render(<ClipboardList />);

    await waitFor(() => {
      expect(listPropsMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          height: 512,
          itemCount: 3,
          itemSize: 106
        })
      );
    });
  });
});
