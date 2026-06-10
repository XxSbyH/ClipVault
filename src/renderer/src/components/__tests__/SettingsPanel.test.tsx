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
  getHistoryMock,
  getHotkeysMock,
  getSettingsMock,
  listFixedContentsMock,
  listBlacklistMock,
  removeBlacklistMock,
  updateFixedContentMock,
  updateHotkeysMock,
  updateSettingMock
} = vi.hoisted(() => ({
  addBlacklistMock: vi.fn(),
  checkHotkeyAvailableMock: vi.fn(),
  checkHotkeyConflictsMock: vi.fn(),
  createFixedContentMock: vi.fn(),
  deleteFixedContentMock: vi.fn(),
  getHistoryMock: vi.fn(),
  getHotkeysMock: vi.fn(),
  getSettingsMock: vi.fn(),
  listFixedContentsMock: vi.fn(),
  listBlacklistMock: vi.fn(),
  removeBlacklistMock: vi.fn(),
  updateFixedContentMock: vi.fn(),
  updateHotkeysMock: vi.fn(),
  updateSettingMock: vi.fn()
}));

vi.mock('@/lib/tauriApi', () => ({
  clipboardApi: {
    addBlacklist: addBlacklistMock,
    checkHotkeyAvailable: checkHotkeyAvailableMock,
    checkHotkeyConflicts: checkHotkeyConflictsMock,
    clearHistory: vi.fn(),
    createFixedContent: createFixedContentMock,
    deleteFixedContent: deleteFixedContentMock,
    getHistory: getHistoryMock,
    getHotkeys: getHotkeysMock,
    getSettings: getSettingsMock,
    listFixedContents: listFixedContentsMock,
    listBlacklist: listBlacklistMock,
    removeBlacklist: removeBlacklistMock,
    updateFixedContent: updateFixedContentMock,
    updateHotkeys: updateHotkeysMock,
    updateSetting: updateSettingMock
  }
}));

const defaultSettings: AppSettings = {
  retentionDays: 7,
  maxItems: 1000,
  enableSensitiveFilter: true,
  enableBlacklist: true,
  textLimitKb: 100,
  imageCompression: 'high',
  themeMode: 'system',
  launchOnStartup: false,
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

function makeFixedContent(id: number, title: string, content: string, hotkey: string): FixedContent {
  return {
    id,
    title,
    content,
    hotkey,
    enabled: true,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    lastUsedAt: null,
    useCount: 0
  };
}

function renderPanel(initialTab: 'general' | 'privacy' | 'hotkeys') {
  return render(
    <SettingsPanel
      open
      initialTab={initialTab as 'general'}
      onOpenChange={vi.fn()}
    />
  );
}

describe('SettingsPanel', () => {
  beforeEach(() => {
    getSettingsMock.mockResolvedValue(defaultSettings);
    listBlacklistMock.mockResolvedValue([]);
    getHotkeysMock.mockResolvedValue(DEFAULT_HOTKEYS);
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
    checkHotkeyConflictsMock.mockResolvedValue([]);
    checkHotkeyAvailableMock.mockResolvedValue(true);
    updateHotkeysMock.mockImplementation((patch: Partial<HotkeySettings>) =>
      Promise.resolve({ ...DEFAULT_HOTKEYS, ...patch })
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

  it('renders fixed content hotkeys and creates a new one', async () => {
    listFixedContentsMock.mockResolvedValue([makeFixedContent(7, 'Topic A', 'Pinned A', 'Ctrl+1')]);
    renderPanel('hotkeys');

    expect(await screen.findByText('固定快捷内容')).toBeInTheDocument();
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
    });
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
