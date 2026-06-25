import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ClipboardItem } from '@shared/types';
import { ClipboardList } from '@/components/ClipboardList';
import { useClipboardStore } from '@/store/clipboardStore';

const {
  copyItemMock,
  createTextItemMock,
  deleteItemMock,
  hideWindowMock,
  listPropsMock,
  pasteItemMock,
  scrollToItemMock,
  specialPasteItemMock,
  updateTextItemMock
} = vi.hoisted(() => ({
  copyItemMock: vi.fn(),
  createTextItemMock: vi.fn(),
  deleteItemMock: vi.fn(),
  hideWindowMock: vi.fn(),
  listPropsMock: vi.fn(),
  pasteItemMock: vi.fn(),
  scrollToItemMock: vi.fn(),
  specialPasteItemMock: vi.fn(),
  updateTextItemMock: vi.fn()
}));

vi.mock('@/lib/tauriApi', () => ({
  clipboardApi: {
    getHistory: vi.fn().mockResolvedValue([]),
    copyItem: copyItemMock,
    createTextItem: createTextItemMock,
    deleteItem: deleteItemMock,
    hideWindow: hideWindowMock,
    pasteItem: pasteItemMock,
    specialPasteItem: specialPasteItemMock,
    togglePin: vi.fn(),
    toggleFavorite: vi.fn(),
    updateTextItem: updateTextItemMock
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
      ReactModule.useImperativeHandle(ref, () => ({ scrollToItem: scrollToItemMock }));
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
    copyItemMock.mockImplementation((id: number) => {
      const item = useClipboardStore.getState().items.find((entry) => entry.id === id);
      return Promise.resolve({
        success: true,
        item: item ? { ...item, useCount: item.useCount + 1 } : undefined
      });
    });
    deleteItemMock.mockResolvedValue({ success: true });
    hideWindowMock.mockResolvedValue(undefined);
    pasteItemMock.mockResolvedValue({ success: true });
    specialPasteItemMock.mockImplementation((id: number) => {
      const item = useClipboardStore.getState().items.find((entry) => entry.id === id);
      return Promise.resolve({
        success: true,
        item: item ? { ...item, useCount: item.useCount + 1 } : undefined
      });
    });
    updateTextItemMock.mockImplementation((id: number, content: string) => {
      const item = useClipboardStore.getState().items.find((entry) => entry.id === id);
      return Promise.resolve(item ? { ...item, content, preview: content } : makeItem(id, content));
    });
    createTextItemMock.mockImplementation((content: string) => Promise.resolve(makeItem(99, content)));
    scrollToItemMock.mockReset();
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

  it('searches text across content types even when another type filter is active', () => {
    useClipboardStore.setState({ selectedType: 'image', searchQuery: 'alpha' });

    render(<ClipboardList />);

    expect(screen.getByText('alpha')).toBeInTheDocument();
    expect(screen.queryByText('bravo')).not.toBeInTheDocument();
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

  it('pastes the selected item with Enter and copies it with Ctrl+C', async () => {
    render(<ClipboardList />);

    await waitFor(() => {
      expect(useClipboardStore.getState().selectedItemId).toBe(3);
    });
    fireEvent.keyDown(window, { key: 'Enter' });

    await waitFor(() => {
      expect(pasteItemMock).toHaveBeenCalledWith(3);
    });

    fireEvent.keyDown(window, { key: 'c', ctrlKey: true });

    await waitFor(() => {
      expect(copyItemMock).toHaveBeenCalledWith(3);
    });
  });

  it('selects a clicked history item without copying it', async () => {
    render(<ClipboardList />);

    const row = screen.getByText('alpha').closest('[role="button"]');
    expect(row).toBeTruthy();
    fireEvent.click(row as HTMLElement);

    expect(copyItemMock).not.toHaveBeenCalled();
    expect(hideWindowMock).not.toHaveBeenCalled();
    expect(useClipboardStore.getState().selectedItemId).toBe(1);
  });

  it('pastes a double-clicked history item', async () => {
    render(<ClipboardList />);

    const alpha = screen.getByText('alpha').closest('[role="button"]');
    expect(alpha).toBeTruthy();
    fireEvent.doubleClick(alpha as HTMLElement);

    await waitFor(() => {
      expect(pasteItemMock).toHaveBeenCalledWith(1);
    });
  });

  it('shows text special paste actions from the context menu', async () => {
    render(<ClipboardList />);

    const row = screen.getByText('alpha').closest('[role="button"]');
    expect(row).toBeTruthy();
    fireEvent.contextMenu(row as HTMLElement);
    fireEvent.click(await screen.findByRole('menuitem', { name: '全部大写' }));

    await waitFor(() => {
      expect(specialPasteItemMock).toHaveBeenCalledWith(1, 'upper');
    });
  });

  it('opens the text workbench from the context menu and saves edits', async () => {
    updateTextItemMock.mockResolvedValue(makeItem(1, 'edited text'));
    render(<ClipboardList />);

    const row = screen.getByText('alpha').closest('[role="button"]');
    expect(row).toBeTruthy();
    fireEvent.contextMenu(row as HTMLElement);
    fireEvent.click(await screen.findByRole('menuitem', { name: '编辑内容' }));

    const editor = await screen.findByLabelText('编辑结果');
    fireEvent.change(editor, { target: { value: 'edited text' } });
    fireEvent.click(screen.getByRole('button', { name: '保存到当前历史' }));

    await waitFor(() => {
      expect(updateTextItemMock).toHaveBeenCalledWith(1, 'edited text');
    });
  });

  it('applies text workbench transforms and saves as a new item', async () => {
    createTextItemMock.mockResolvedValue(makeItem(9, 'HELLO'));
    render(<ClipboardList />);

    const row = screen.getByText('alpha').closest('[role="button"]');
    expect(row).toBeTruthy();
    fireEvent.contextMenu(row as HTMLElement);
    fireEvent.click(await screen.findByRole('menuitem', { name: '编辑内容' }));
    fireEvent.change(await screen.findByLabelText('编辑结果'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: '全部大写' }));
    fireEvent.click(screen.getByRole('button', { name: '另存为新历史' }));

    await waitFor(() => {
      expect(createTextItemMock).toHaveBeenCalledWith('HELLO');
    });
  });

  it('prefills fixed content from a history item through the context menu', async () => {
    const addFixedContentMock = vi.fn();
    render(<ClipboardList onAddFixedContent={addFixedContentMock} />);

    const row = screen.getByText('alpha').closest('[role="button"]');
    expect(row).toBeTruthy();
    fireEvent.contextMenu(row as HTMLElement);
    fireEvent.click(await screen.findByRole('menuitem', { name: '添加为固定内容' }));

    expect(addFixedContentMock).toHaveBeenCalledWith({ title: 'alpha', content: 'alpha' });
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
    expect(copyItemMock).not.toHaveBeenCalled();
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
          itemSize: 78
        })
      );
    });
  });

  it('scrolls to the item selected by quick paste cursor events', async () => {
    render(<ClipboardList />);

    await waitFor(() => {
      expect(useClipboardStore.getState().selectedItemId).toBe(3);
    });

    useClipboardStore.getState().setSelectedItemId(1);

    await waitFor(() => {
      expect(scrollToItemMock).toHaveBeenCalledWith(2, 'smart');
    });
  });
});
