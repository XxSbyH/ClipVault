import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AppSettings, BlacklistApp, HotkeySettings } from '@shared/types';
import { DEFAULT_HOTKEYS } from '@shared/types';
import { SettingsPanel } from '@/components/SettingsPanel';
import { useClipboardStore } from '@/store/clipboardStore';

const {
  addBlacklistMock,
  checkHotkeyAvailableMock,
  checkHotkeyConflictsMock,
  getHistoryMock,
  getHotkeysMock,
  getSettingsMock,
  listBlacklistMock,
  removeBlacklistMock,
  updateHotkeysMock,
  updateSettingMock
} = vi.hoisted(() => ({
  addBlacklistMock: vi.fn(),
  checkHotkeyAvailableMock: vi.fn(),
  checkHotkeyConflictsMock: vi.fn(),
  getHistoryMock: vi.fn(),
  getHotkeysMock: vi.fn(),
  getSettingsMock: vi.fn(),
  listBlacklistMock: vi.fn(),
  removeBlacklistMock: vi.fn(),
  updateHotkeysMock: vi.fn(),
  updateSettingMock: vi.fn()
}));

vi.mock('@/lib/tauriApi', () => ({
  clipboardApi: {
    addBlacklist: addBlacklistMock,
    checkHotkeyAvailable: checkHotkeyAvailableMock,
    checkHotkeyConflicts: checkHotkeyConflictsMock,
    clearHistory: vi.fn(),
    getHistory: getHistoryMock,
    getHotkeys: getHotkeysMock,
    getSettings: getSettingsMock,
    listBlacklist: listBlacklistMock,
    removeBlacklist: removeBlacklistMock,
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
});
