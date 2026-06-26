import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BlacklistApp,
  ClipboardItem,
  FixedContent,
  FixedContentInput,
  QuickPasteCursorPayload
} from '@shared/types';

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

  it('listens for quick paste cursor events', async () => {
    const payload: QuickPasteCursorPayload = {
      selectedItemId: 7,
      boundary: null
    };
    const unlisten = vi.fn();
    const handler = vi.fn();
    listenMock.mockImplementationOnce(async (_eventName, callback) => {
      callback({ payload });
      return unlisten;
    });
    const { clipboardApi } = await import('./tauriApi');

    const off = clipboardApi.onQuickPasteCursor(handler);
    await Promise.resolve();
    off();

    expect(listenMock).toHaveBeenCalledWith('quick-paste:cursor', expect.any(Function));
    expect(handler).toHaveBeenCalledWith(payload);
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it('invokes set_quick_paste_cursor with the selected history id', async () => {
    const { clipboardApi } = await import('./tauriApi');
    invokeMock.mockResolvedValueOnce(undefined);

    await expect(clipboardApi.setQuickPasteCursor(7)).resolves.toBeUndefined();

    expect(invokeMock).toHaveBeenCalledWith('set_quick_paste_cursor', { id: 7 });
  });

  it('maps quick search window commands and events', async () => {
    const unlisten = vi.fn();
    const handler = vi.fn();
    listenMock.mockImplementationOnce(async (_eventName, callback) => {
      callback({ payload: undefined });
      return unlisten;
    });
    const { clipboardApi } = await import('./tauriApi');
    invokeMock.mockResolvedValueOnce(undefined);

    await expect(clipboardApi.hideSearchWindow()).resolves.toBeUndefined();
    expect(invokeMock).toHaveBeenCalledWith('hide_search_window');

    const off = clipboardApi.onQuickSearchOpened(handler);
    await Promise.resolve();
    off();

    expect(listenMock).toHaveBeenCalledWith('quick-search:opened', expect.any(Function));
    expect(handler).toHaveBeenCalledTimes(1);
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

  it('maps copy_item success with the updated item', async () => {
    const { clipboardApi } = await import('./tauriApi');
    const item = makeItem(9);
    invokeMock.mockResolvedValueOnce({
      success: true,
      message: 'copied',
      item,
      revision: 2
    });

    await expect(clipboardApi.copyItem(9)).resolves.toEqual({
      success: true,
      item
    });
    expect(invokeMock).toHaveBeenCalledWith('copy_item', { id: 9 });
  });

  it('maps special paste and text item commands', async () => {
    const { clipboardApi } = await import('./tauriApi');
    const item = makeItem(12);
    invokeMock.mockResolvedValueOnce({ success: true, message: 'pasted', item, revision: 3 });

    await expect(clipboardApi.specialPasteItem(12, 'upper')).resolves.toEqual({
      success: true,
      item
    });
    expect(invokeMock).toHaveBeenLastCalledWith('special_paste_item', { id: 12, action: 'upper' });

    invokeMock.mockResolvedValueOnce(item);
    await expect(clipboardApi.updateTextItem(12, 'updated')).resolves.toEqual(item);
    expect(invokeMock).toHaveBeenLastCalledWith('update_text_item', { id: 12, content: 'updated' });

    invokeMock.mockResolvedValueOnce(item);
    await expect(clipboardApi.createTextItem('new text')).resolves.toEqual(item);
    expect(invokeMock).toHaveBeenLastCalledWith('create_text_item', { content: 'new text' });
  });

  it('maps clear_history returned deleted count to old result shape', async () => {
    const { clipboardApi } = await import('./tauriApi');
    invokeMock.mockResolvedValueOnce({ revision: 4, deleted: 2 });

    await expect(clipboardApi.clearHistory()).resolves.toEqual({
      success: true,
      deleted: 2
    });

    expect(invokeMock).toHaveBeenCalledWith('clear_history', { includeFavorites: false });
  });

  it('invokes history export and import commands', async () => {
    const { clipboardApi } = await import('./tauriApi');
    invokeMock
      .mockResolvedValueOnce({ exported: 2, path: 'D:/tmp/history.clipvault' })
      .mockResolvedValueOnce({
        inserted: 1,
        skippedDuplicates: 2,
        mergedState: 1,
        skippedUnsupportedFormats: 0,
        failed: 0
      });

    await expect(clipboardApi.exportHistory('D:/tmp/history.clipvault')).resolves.toEqual({
      exported: 2,
      path: 'D:/tmp/history.clipvault'
    });
    await expect(clipboardApi.importHistory('D:/tmp/history.clipvault')).resolves.toEqual({
      inserted: 1,
      skippedDuplicates: 2,
      mergedState: 1,
      skippedUnsupportedFormats: 0,
      failed: 0
    });

    expect(invokeMock).toHaveBeenCalledWith('export_history', {
      path: 'D:/tmp/history.clipvault'
    });
    expect(invokeMock).toHaveBeenCalledWith('import_history', {
      path: 'D:/tmp/history.clipvault'
    });
  });

  it('returns the newest matching custom blacklist app when command returns a full list', async () => {
    const { clipboardApi } = await import('./tauriApi');
    const apps: BlacklistApp[] = [
      makeBlacklistApp(10, 'Chrome.exe', false),
      makeBlacklistApp(2, 'Chrome.exe', false),
      makeBlacklistApp(99, 'Chrome.exe', true)
    ];
    invokeMock.mockResolvedValueOnce(apps);

    await expect(clipboardApi.addBlacklist('chrome.exe')).resolves.toEqual(apps[0]);
  });

  it('maps fixed content commands', async () => {
    const { clipboardApi } = await import('./tauriApi');
    const fixedContent = {
      id: 1,
      title: 'Greeting',
      content: 'Hello from ClipVault',
      hotkey: 'Ctrl+Alt+1',
      enabled: true,
      createdAt: 1_700_000_000,
      updatedAt: 1_700_000_100,
      lastUsedAt: 1_700_000_200,
      useCount: 3
    };
    const input = {
      title: fixedContent.title,
      content: fixedContent.content,
      hotkey: fixedContent.hotkey,
      enabled: fixedContent.enabled
    };

    invokeMock.mockResolvedValueOnce([fixedContent]);
    await expect(clipboardApi.listFixedContents()).resolves.toEqual([fixedContent]);
    expect(invokeMock).toHaveBeenLastCalledWith('list_fixed_contents');

    invokeMock.mockResolvedValueOnce(fixedContent);
    await expect(clipboardApi.createFixedContent(input)).resolves.toEqual(fixedContent);
    expect(invokeMock).toHaveBeenLastCalledWith('create_fixed_content', { input });

    invokeMock.mockResolvedValueOnce(fixedContent);
    await expect(clipboardApi.updateFixedContent(1, input)).resolves.toEqual(fixedContent);
    expect(invokeMock).toHaveBeenLastCalledWith('update_fixed_content', { id: 1, input });

    invokeMock.mockResolvedValueOnce(undefined);
    await expect(clipboardApi.deleteFixedContent(1)).resolves.toBeUndefined();
    expect(invokeMock).toHaveBeenLastCalledWith('delete_fixed_content', { id: 1 });
  });

  it('does not call listener handlers after unsubscribe even if Tauri resolves later', async () => {
    const item = makeItem(5);
    const unlisten = vi.fn();
    const handler = vi.fn();
    const listenerRef: { current?: (event: { payload: ClipboardItem }) => void } = {};
    const resolveRef: { current?: (value: () => void) => void } = {};
    listenMock.mockImplementationOnce(async (_eventName, callback) => {
      listenerRef.current = callback;
      return new Promise((resolve) => {
        resolveRef.current = resolve;
      });
    });
    const { clipboardApi } = await import('./tauriApi');

    const off = clipboardApi.onNewItem(handler);
    off();
    listenerRef.current?.({ payload: item });
    resolveRef.current?.(unlisten);
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(handler).not.toHaveBeenCalled();
    expect(unlisten).toHaveBeenCalledTimes(1);
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

function makeBlacklistApp(id: number, appName: string, isBuiltin: boolean): BlacklistApp {
  return {
    id,
    appName,
    appPath: null,
    isBuiltin,
    createdAt: 1_700_000_000 + id
  };
}

type Expect<T extends true> = T;
type IsExactlyString<T> = [T] extends [string] ? ([string] extends [T] ? true : false) : false;
type IsRequired<T, K extends keyof T> = {} extends Pick<T, K> ? false : true;

const fixedContentHotkeyTypeCheck: Expect<IsExactlyString<FixedContent['hotkey']>> = true;
const fixedContentInputHotkeyTypeCheck: Expect<IsExactlyString<FixedContentInput['hotkey']>> = true;
const fixedContentInputHotkeyRequiredTypeCheck: Expect<
  IsRequired<FixedContentInput, 'hotkey'>
> = true;

void fixedContentHotkeyTypeCheck;
void fixedContentInputHotkeyTypeCheck;
void fixedContentInputHotkeyRequiredTypeCheck;
