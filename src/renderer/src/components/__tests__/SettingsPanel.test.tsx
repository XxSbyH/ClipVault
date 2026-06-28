import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AppSettings, BlacklistApp, FixedContent, HotkeySettings } from '@shared/types';
import { DEFAULT_HOTKEYS } from '@shared/types';
import { SettingsPanel } from '@/components/SettingsPanel';
import { useClipboardStore } from '@/store/clipboardStore';

const {
  addBlacklistMock,
  checkHotkeyAvailableMock,
  checkHotkeyConflictsMock,
  createFixedContentMock,
  deleteFixedContentMock,
  exportHistoryMock,
  getHistoryMock,
  getHotkeysMock,
  getRecentHistoryHotkeysMock,
  getSettingsMock,
  importHistoryMock,
  listFixedContentsMock,
  listBlacklistMock,
  openDialogMock,
  removeBlacklistMock,
  saveDialogMock,
  updateFixedContentMock,
  updateRecentHistoryHotkeyMock,
  updateHotkeysMock,
  updateSettingMock
} = vi.hoisted(() => ({
  addBlacklistMock: vi.fn(),
  checkHotkeyAvailableMock: vi.fn(),
  checkHotkeyConflictsMock: vi.fn(),
  createFixedContentMock: vi.fn(),
  deleteFixedContentMock: vi.fn(),
  exportHistoryMock: vi.fn(),
  getHistoryMock: vi.fn(),
  getHotkeysMock: vi.fn(),
  getRecentHistoryHotkeysMock: vi.fn(),
  getSettingsMock: vi.fn(),
  importHistoryMock: vi.fn(),
  listFixedContentsMock: vi.fn(),
  listBlacklistMock: vi.fn(),
  openDialogMock: vi.fn(),
  removeBlacklistMock: vi.fn(),
  saveDialogMock: vi.fn(),
  updateFixedContentMock: vi.fn(),
  updateRecentHistoryHotkeyMock: vi.fn(),
  updateHotkeysMock: vi.fn(),
  updateSettingMock: vi.fn()
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: openDialogMock,
  save: saveDialogMock
}));

vi.mock('@/lib/tauriApi', () => ({
  clipboardApi: {
    addBlacklist: addBlacklistMock,
    checkHotkeyAvailable: checkHotkeyAvailableMock,
    checkHotkeyConflicts: checkHotkeyConflictsMock,
    clearHistory: vi.fn(),
    createFixedContent: createFixedContentMock,
    deleteFixedContent: deleteFixedContentMock,
    exportHistory: exportHistoryMock,
    getHistory: getHistoryMock,
    getHotkeys: getHotkeysMock,
    getRecentHistoryHotkeys: getRecentHistoryHotkeysMock,
    getSettings: getSettingsMock,
    importHistory: importHistoryMock,
    listFixedContents: listFixedContentsMock,
    listBlacklist: listBlacklistMock,
    removeBlacklist: removeBlacklistMock,
    updateFixedContent: updateFixedContentMock,
    updateRecentHistoryHotkey: updateRecentHistoryHotkeyMock,
    updateHotkeys: updateHotkeysMock,
    updateSetting: updateSettingMock
  }
}));

const defaultSettings: AppSettings = {
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
};

function makeBlacklistApp(id: number, appName: string, isBuiltin = false): BlacklistApp {
  return {
    id,
    appName,
    appPath: null,
    isBuiltin,
    createdAt: 1_700_000_000_000
  };
}

function makeFixedContent(
  id: number,
  title: string,
  content: string,
  hotkey: string,
  enabled = true
): FixedContent {
  return {
    id,
    title,
    content,
    hotkey,
    enabled,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    lastUsedAt: null,
    useCount: 0
  };
}

function renderPanel(
  initialTab: 'general' | 'privacy' | 'storage' | 'hotkeys' | 'about',
  prefillFixedContent: { title: string; content: string; nonce: number } | null = null
) {
  return render(
    <SettingsPanel
      open
      initialTab={initialTab}
      prefillFixedContent={prefillFixedContent}
      onOpenChange={vi.fn()}
    />
  );
}

describe('SettingsPanel', () => {
  beforeEach(() => {
    getSettingsMock.mockResolvedValue(defaultSettings);
    listBlacklistMock.mockResolvedValue([]);
    getHotkeysMock.mockResolvedValue(DEFAULT_HOTKEYS);
    getRecentHistoryHotkeysMock.mockResolvedValue(
      Array.from({ length: 10 }, (_, index) => ({
        slot: index + 1,
        hotkey: '',
        enabled: false
      }))
    );
    updateSettingMock.mockImplementation((key: keyof AppSettings, value: AppSettings[keyof AppSettings]) =>
      Promise.resolve({ ...defaultSettings, [key]: value })
    );
    addBlacklistMock.mockResolvedValue(makeBlacklistApp(9, 'KeePass.exe'));
    removeBlacklistMock.mockResolvedValue(undefined);
    getHistoryMock.mockResolvedValue([]);
    listFixedContentsMock.mockResolvedValue([]);
    createFixedContentMock.mockImplementation((input) =>
      Promise.resolve(makeFixedContent(11, input.title, input.content, input.hotkey))
    );
    updateFixedContentMock.mockImplementation((id, input) =>
      Promise.resolve(makeFixedContent(id, input.title, input.content, input.hotkey))
    );
    deleteFixedContentMock.mockResolvedValue(undefined);
    exportHistoryMock.mockResolvedValue({ exported: 0, path: 'D:/tmp/history.clipvault' });
    importHistoryMock.mockResolvedValue({
      inserted: 0,
      skippedDuplicates: 0,
      mergedState: 0,
      skippedUnsupportedFormats: 0,
      failed: 0
    });
    openDialogMock.mockResolvedValue(null);
    saveDialogMock.mockResolvedValue(null);
    checkHotkeyConflictsMock.mockResolvedValue([]);
    checkHotkeyAvailableMock.mockResolvedValue(true);
    updateHotkeysMock.mockImplementation((patch: Partial<HotkeySettings>) =>
      Promise.resolve({ ...DEFAULT_HOTKEYS, ...patch })
    );
    updateRecentHistoryHotkeyMock.mockImplementation((input) =>
      Promise.resolve(
        Array.from({ length: 10 }, (_, index) => ({
          slot: index + 1,
          hotkey: input.slot === index + 1 ? input.hotkey : '',
          enabled: input.slot === index + 1 ? input.enabled : false
        }))
      )
    );
    useClipboardStore.setState({
      items: [],
      selectedType: 'all',
      selectedItemId: null,
      searchQuery: '',
      settings: null
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('toggles sensitive filtering through updateSetting', async () => {
    renderPanel('privacy');
    const dialog = screen.getByRole('dialog');

    await waitFor(() => expect(getSettingsMock).toHaveBeenCalled());
    const sensitiveSwitch = within(dialog).getAllByRole('switch')[0];
    fireEvent.click(sensitiveSwitch);

    await waitFor(() => {
      expect(updateSettingMock).toHaveBeenCalledWith('enableSensitiveFilter', false);
    });
  });

  it('updates the theme mode from general settings', async () => {
    renderPanel('general');

    const darkOption = await screen.findByRole('button', { name: '主题模式：暗色' });
    fireEvent.click(darkOption);

    await waitFor(() => {
      expect(updateSettingMock).toHaveBeenCalledWith('themeMode', 'dark');
    });
  });

  it('shows the current release version in the about settings', async () => {
    renderPanel('about');

    expect(await screen.findByText('ClipVault v2.1.9')).toBeInTheDocument();
  });

  it('defaults history retention to permanent and can switch back to a limited duration', async () => {
    renderPanel('general');

    await waitFor(() => expect(getSettingsMock).toHaveBeenCalled());
    const retentionSelect = screen.getByDisplayValue('永久保留');
    fireEvent.change(retentionSelect, { target: { value: '7' } });

    await waitFor(() => {
      expect(updateSettingMock).toHaveBeenCalledWith('retentionDays', 7);
    });
  });

  it('does not save maximum item count while the number field is incomplete', async () => {
    renderPanel('general');

    await waitFor(() => expect(getSettingsMock).toHaveBeenCalled());
    const maxItemsInput = screen.getByDisplayValue('10000');
    fireEvent.change(maxItemsInput, { target: { value: '' } });
    fireEvent.blur(maxItemsInput);

    expect(updateSettingMock).not.toHaveBeenCalled();
    expect(maxItemsInput).toHaveValue(10000);
  });

  it('saves maximum item count only after editing is committed', async () => {
    renderPanel('general');

    await waitFor(() => expect(getSettingsMock).toHaveBeenCalled());
    const maxItemsInput = screen.getByDisplayValue('10000');
    fireEvent.change(maxItemsInput, { target: { value: '5000' } });
    expect(updateSettingMock).not.toHaveBeenCalled();
    fireEvent.blur(maxItemsInput);

    await waitFor(() => {
      expect(updateSettingMock).toHaveBeenCalledWith('maxItems', 5000);
    });
  });

  it('allows maximum item count up to one million', async () => {
    renderPanel('general');

    await waitFor(() => expect(getSettingsMock).toHaveBeenCalled());
    const maxItemsInput = screen.getByDisplayValue('10000');
    fireEvent.change(maxItemsInput, { target: { value: '1000000' } });
    fireEvent.blur(maxItemsInput);

    await waitFor(() => {
      expect(updateSettingMock).toHaveBeenCalledWith('maxItems', 1_000_000);
    });
  });

  it('exports history from storage settings', async () => {
    saveDialogMock.mockResolvedValue('D:/tmp/history.clipvault');
    exportHistoryMock.mockResolvedValue({ exported: 2, path: 'D:/tmp/history.clipvault' });
    renderPanel('storage');

    fireEvent.click(await screen.findByRole('button', { name: /导出历史数据/ }));

    await waitFor(() => {
      expect(exportHistoryMock).toHaveBeenCalledWith('D:/tmp/history.clipvault');
    });
    expect(await screen.findByText(/已导出 2 条历史/)).toBeInTheDocument();
  });

  it('keeps storage history action icons aligned with labels', async () => {
    renderPanel('storage');

    const exportButton = await screen.findByRole('button', { name: '导出历史数据' });
    const importButton = await screen.findByRole('button', { name: '导入历史数据' });

    expect(exportButton).toHaveClass('gap-2');
    expect(exportButton).toHaveClass('leading-none');
    expect(exportButton.querySelector('svg')).toHaveClass('block');
    expect(importButton).toHaveClass('gap-2');
    expect(importButton).toHaveClass('leading-none');
    expect(importButton.querySelector('svg')).toHaveClass('block');
  });

  it('imports history and shows merge summary', async () => {
    openDialogMock.mockResolvedValue('D:/tmp/history.clipvault');
    importHistoryMock.mockResolvedValue({
      inserted: 3,
      skippedDuplicates: 1,
      mergedState: 1,
      skippedUnsupportedFormats: 0,
      failed: 0
    });
    renderPanel('storage');

    fireEvent.click(await screen.findByRole('button', { name: /导入历史数据/ }));

    await waitFor(() => {
      expect(importHistoryMock).toHaveBeenCalledWith('D:/tmp/history.clipvault');
    });
    expect(await screen.findByText(/新增 3 条/)).toBeInTheDocument();
  });

  it('adds a blacklist app and refreshes the list', async () => {
    renderPanel('privacy');
    const dialog = screen.getByRole('dialog');

    const input = within(dialog).getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'KeePass.exe' } });
    const addButton = input.parentElement?.querySelector('button');
    expect(addButton).toBeTruthy();
    fireEvent.click(addButton as HTMLButtonElement);

    await waitFor(() => {
      expect(addBlacklistMock).toHaveBeenCalledWith('KeePass.exe');
      expect(listBlacklistMock).toHaveBeenCalledTimes(2);
    });
  });

  it('removes a blacklist app and refreshes the list', async () => {
    listBlacklistMock.mockResolvedValue([makeBlacklistApp(4, 'KeePass.exe')]);
    renderPanel('privacy');

    const appName = await screen.findByText('KeePass.exe');
    const row = appName.parentElement?.parentElement;
    expect(row).toBeTruthy();
    const removeButton = within(row as HTMLElement).getByRole('button');
    fireEvent.click(removeButton);

    await waitFor(() => {
      expect(removeBlacklistMock).toHaveBeenCalledWith(4);
      expect(listBlacklistMock).toHaveBeenCalledTimes(2);
    });
  });

  it('records a hotkey and calls updateHotkeys with the changed command', async () => {
    renderPanel('hotkeys');

    const openPanelHotkey = await screen.findByText('Ctrl+Shift+V');
    fireEvent.click(openPanelHotkey);
    fireEvent.keyDown(window, { key: 'Control' });
    fireEvent.keyDown(window, { key: 'Alt' });
    fireEvent.keyDown(window, { key: 'k' });
    fireEvent.keyUp(window, { key: 'k' });

    await waitFor(() => {
      expect(checkHotkeyConflictsMock).toHaveBeenCalled();
      expect(checkHotkeyAvailableMock).toHaveBeenCalledWith('Ctrl+Alt+K');
      expect(updateHotkeysMock).toHaveBeenCalledWith({ openPanel: 'Ctrl+Alt+K' });
    });
  });

  it('shows history hotkeys as copy actions', async () => {
    renderPanel('hotkeys');

    expect(await screen.findByText('历史快速复制')).toBeInTheDocument();
    expect(screen.getByText('复制更旧的历史内容到剪贴板')).toBeInTheDocument();
    expect(screen.queryByText('快速粘贴')).not.toBeInTheDocument();
  });

  it('renders recent history hotkey slots and saves a slot shortcut', async () => {
    renderPanel('hotkeys');

    expect(await screen.findByText('最近十个历史记录')).toBeInTheDocument();
    const positionOneLabel = screen.getByText('位置 1（最新）');
    expect(screen.getByText('粘贴最近第 10 条历史记录')).toBeInTheDocument();

    const positionOneRow = positionOneLabel.parentElement?.parentElement;
    expect(positionOneRow).toBeTruthy();
    fireEvent.click(within(positionOneRow as HTMLElement).getByRole('button', { name: '录制快捷键' }));
    fireEvent.keyDown(window, { key: 'Control' });
    fireEvent.keyDown(window, { key: 'Alt' });
    fireEvent.keyDown(window, { key: '1' });
    fireEvent.keyUp(window, { key: '1' });

    await waitFor(() => {
      expect(updateRecentHistoryHotkeyMock).toHaveBeenCalledWith({
        slot: 1,
        hotkey: 'Ctrl+Alt+1',
        enabled: false
      });
    });
  });

  it('toggles a recent history hotkey slot', async () => {
    getRecentHistoryHotkeysMock.mockResolvedValue(
      Array.from({ length: 10 }, (_, index) => ({
        slot: index + 1,
        hotkey: index === 0 ? 'Ctrl+Alt+1' : '',
        enabled: index === 0
      }))
    );

    renderPanel('hotkeys');

    fireEvent.click(await screen.findByRole('switch', { name: '启用位置 1 最近历史快捷键' }));

    expect(updateRecentHistoryHotkeyMock).toHaveBeenCalledWith({
      slot: 1,
      hotkey: 'Ctrl+Alt+1',
      enabled: false
    });
  });

  it('marks hotkeys that are unavailable in the system', async () => {
    checkHotkeyAvailableMock.mockImplementation((hotkey: string) =>
      Promise.resolve(hotkey !== DEFAULT_HOTKEYS.clear)
    );
    renderPanel('hotkeys');

    expect(await screen.findByText('清空历史')).toBeInTheDocument();

    await waitFor(() => {
      expect(checkHotkeyAvailableMock).toHaveBeenCalledWith(DEFAULT_HOTKEYS.clear);
    });
    expect(await screen.findByText('热键被占用')).toBeInTheDocument();
  });

  it('shows fixed content trial examples without creating records', async () => {
    renderPanel('hotkeys');

    expect(await screen.findByText('试用示例')).toBeInTheDocument();
    expect(screen.getByText('收到，我稍后处理。')).toBeInTheDocument();
    expect(createFixedContentMock).not.toHaveBeenCalled();
  });

  it('prefills the fixed content form from a trial example', async () => {
    renderPanel('hotkeys');

    fireEvent.click(await screen.findByRole('button', { name: '使用示例 常用回复' }));

    expect(screen.getByLabelText('标题')).toHaveValue('常用回复');
    expect(screen.getByLabelText('内容')).toHaveValue('收到，我稍后处理。');
    expect(screen.getByRole('button', { name: '保存固定内容' })).toBeDisabled();
  });

  it('prefills the fixed content form from an external request', async () => {
    renderPanel('hotkeys', { title: 'alpha', content: 'alpha content', nonce: 1 });

    expect(await screen.findByLabelText('标题')).toHaveValue('alpha');
    expect(screen.getByLabelText('内容')).toHaveValue('alpha content');
    expect(screen.getByRole('button', { name: '保存固定内容' })).toBeDisabled();
  });

  it('renders fixed content hotkeys and creates a new one', async () => {
    listFixedContentsMock.mockResolvedValue([makeFixedContent(7, 'Topic A', 'Pinned A', 'Ctrl+1')]);
    renderPanel('hotkeys');

    expect(await screen.findByText('固定快捷内容')).toBeInTheDocument();
    expect(screen.getByText('为常用文本绑定快捷键，触发后写入剪贴板并粘贴。')).toBeInTheDocument();
    expect(screen.getByText('Topic A')).toBeInTheDocument();
    expect(screen.getByText('Ctrl+1')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '新增固定内容' }));
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: 'Topic B' } });
    fireEvent.change(screen.getByLabelText('内容'), { target: { value: 'Pinned B' } });
    fireEvent.click(screen.getByRole('button', { name: /录制固定内容快捷键/ }));
    fireEvent.keyDown(window, { key: 'Control' });
    fireEvent.keyDown(window, { key: '2' });
    fireEvent.keyUp(window, { key: '2' });

    await screen.findByRole('button', { name: /Ctrl\+2/ });
    fireEvent.click(screen.getByRole('button', { name: '保存固定内容' }));

    await waitFor(() => {
      expect(createFixedContentMock).toHaveBeenCalledWith({
        title: 'Topic B',
        content: 'Pinned B',
        hotkey: 'Ctrl+2',
        enabled: true
      });
      expect(listFixedContentsMock).toHaveBeenCalledTimes(2);
    });
  });

  it('updates an existing fixed content hotkey and saves disabled state', async () => {
    listFixedContentsMock.mockResolvedValue([makeFixedContent(7, 'Topic A', 'Pinned A', 'Ctrl+1')]);
    renderPanel('hotkeys');

    expect(await screen.findByText('Topic A')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '编辑固定内容 Topic A' }));
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: 'Topic A Updated' } });
    fireEvent.change(screen.getByLabelText('内容'), { target: { value: 'Pinned A Updated' } });
    fireEvent.click(screen.getByRole('switch', { name: '启用固定内容' }));
    fireEvent.click(screen.getByRole('button', { name: '保存固定内容' }));

    await waitFor(() => {
      expect(updateFixedContentMock).toHaveBeenCalledWith(7, {
        title: 'Topic A Updated',
        content: 'Pinned A Updated',
        hotkey: 'Ctrl+1',
        enabled: false
      });
      expect(listFixedContentsMock).toHaveBeenCalledTimes(2);
    });
  });

  it('shows a fixed content conflict when the hotkey is already used by normal shortcuts', async () => {
    renderPanel('hotkeys');

    await screen.findByText('固定快捷内容');
    fireEvent.click(screen.getByRole('button', { name: '新增固定内容' }));
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: 'Topic B' } });
    fireEvent.change(screen.getByLabelText('内容'), { target: { value: 'Pinned B' } });
    fireEvent.click(screen.getByRole('button', { name: /录制固定内容快捷键/ }));
    fireEvent.keyDown(window, { key: 'Control' });
    fireEvent.keyDown(window, { key: 'Shift' });
    fireEvent.keyDown(window, { key: 'v' });
    fireEvent.keyUp(window, { key: 'v' });

    await screen.findByRole('button', { name: '录制固定内容快捷键 Ctrl+Shift+V' });
    fireEvent.click(screen.getByRole('button', { name: '保存固定内容' }));

    expect(await screen.findByText('快捷键冲突：Ctrl+Shift+V 已绑定到 打开/隐藏面板。')).toBeInTheDocument();
    expect(createFixedContentMock).not.toHaveBeenCalled();
  });

  it('shows a fixed content conflict when the hotkey is already used by enabled fixed content', async () => {
    listFixedContentsMock.mockResolvedValue([makeFixedContent(7, 'Topic A', 'Pinned A', 'Ctrl+1')]);
    renderPanel('hotkeys');

    expect(await screen.findByText('Topic A')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '新增固定内容' }));
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: 'Topic B' } });
    fireEvent.change(screen.getByLabelText('内容'), { target: { value: 'Pinned B' } });
    fireEvent.click(screen.getByRole('button', { name: /录制固定内容快捷键/ }));
    fireEvent.keyDown(window, { key: 'Control' });
    fireEvent.keyDown(window, { key: '1' });
    fireEvent.keyUp(window, { key: '1' });

    await screen.findByRole('button', { name: /Ctrl\+1/ });
    fireEvent.click(screen.getByRole('button', { name: '保存固定内容' }));

    expect(await screen.findByText('快捷键冲突：Ctrl+1 已绑定到固定内容「Topic A」。')).toBeInTheDocument();
    expect(createFixedContentMock).not.toHaveBeenCalled();
  });

  it('shows backend fixed content conflict details when save is rejected', async () => {
    createFixedContentMock.mockRejectedValue('hotkey Ctrl+2 is assigned to both fixed content 7 and fixed content candidate');
    renderPanel('hotkeys');

    await screen.findByText('固定快捷内容');
    fireEvent.click(screen.getByRole('button', { name: '新增固定内容' }));
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: 'Topic B' } });
    fireEvent.change(screen.getByLabelText('内容'), { target: { value: 'Pinned B' } });
    fireEvent.click(screen.getByRole('button', { name: /录制固定内容快捷键/ }));
    fireEvent.keyDown(window, { key: 'Control' });
    fireEvent.keyDown(window, { key: '2' });
    fireEvent.keyUp(window, { key: '2' });

    await screen.findByRole('button', { name: /Ctrl\+2/ });
    fireEvent.click(screen.getByRole('button', { name: '保存固定内容' }));

    expect(
      await screen.findByText('快捷键冲突：Ctrl+2 已绑定到 固定内容 #7 和 当前固定内容。')
    ).toBeInTheDocument();
  });

  it('deletes a fixed content hotkey and refreshes the list', async () => {
    listFixedContentsMock
      .mockResolvedValueOnce([makeFixedContent(7, 'Topic A', 'Pinned A', 'Ctrl+1')])
      .mockResolvedValueOnce([]);
    renderPanel('hotkeys');

    expect(await screen.findByText('Topic A')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '删除固定内容 Topic A' }));

    await waitFor(() => {
      expect(deleteFixedContentMock).toHaveBeenCalledWith(7);
      expect(listFixedContentsMock).toHaveBeenCalledTimes(2);
    });
  });
});
