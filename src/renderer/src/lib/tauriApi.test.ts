import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClipboardItem } from '@shared/types';

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn()
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: listenMock
}));

describe('clipboardApi Tauri adapter', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
  });

  it('invokes get_history with limit', async () => {
    const { clipboardApi } = await import('./tauriApi');
    invokeMock.mockResolvedValueOnce([]);

    await expect(clipboardApi.getHistory(50)).resolves.toEqual([]);

    expect(invokeMock).toHaveBeenCalledWith('get_history', { limit: 50 });
  });

  it('invokes search_items with query', async () => {
    const { clipboardApi } = await import('./tauriApi');
    invokeMock.mockResolvedValueOnce([]);

    await expect(clipboardApi.searchItems('abc')).resolves.toEqual([]);

    expect(invokeMock).toHaveBeenCalledWith('search_items', { query: 'abc' });
  });

  it('listens for new item events, unwraps payload, and unlistens', async () => {
    const item = makeItem(1);
    const unlisten = vi.fn();
    const handler = vi.fn();
    listenMock.mockImplementationOnce(async (_eventName, callback) => {
      callback({ payload: item });
      return unlisten;
    });
    const { clipboardApi } = await import('./tauriApi');

    const off = clipboardApi.onNewItem(handler);
    await Promise.resolve();
    off();

    expect(listenMock).toHaveBeenCalledWith('clipboard:new-item', expect.any(Function));
    expect(handler).toHaveBeenCalledWith(item);
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it('maps delete_item success and rejected invoke to old result shape', async () => {
    const { clipboardApi } = await import('./tauriApi');
    invokeMock.mockResolvedValueOnce(2);

    await expect(clipboardApi.deleteItem(7)).resolves.toEqual({ success: true });
    expect(invokeMock).toHaveBeenCalledWith('delete_item', { id: 7 });

    invokeMock.mockRejectedValueOnce(new Error('missing item'));
    await expect(clipboardApi.deleteItem(8)).resolves.toEqual({
      success: false,
      error: 'missing item'
    });
  });

  it('maps unsupported paste_item stub to old result shape without throwing', async () => {
    const { clipboardApi } = await import('./tauriApi');
    invokeMock.mockResolvedValueOnce({
      success: false,
      message: 'paste is not implemented in Task 4',
      item: null,
      revision: 0
    });

    await expect(clipboardApi.pasteItem(3)).resolves.toEqual({
      success: false,
      error: 'paste is not implemented in Task 4'
    });
    expect(invokeMock).toHaveBeenCalledWith('paste_item', { id: 3 });
  });
});

function makeItem(id: number): ClipboardItem {
  return {
    id,
    content: 'abc',
    contentType: 'text',
    contentHash: `hash-${id}`,
    preview: 'abc',
    metadata: {},
    filePath: null,
    imageData: null,
    createdAt: 1_700_000_000,
    lastUsedAt: null,
    useCount: 0,
    isPinned: false,
    isFavorite: false
  };
}
