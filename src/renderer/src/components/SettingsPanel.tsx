import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, Monitor, Moon, SlidersHorizontal, Sun, Upload, X } from 'lucide-react';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import {
  DEFAULT_HOTKEYS,
  type AppSettings,
  type BlacklistApp,
  type FixedContent,
  type FixedContentInput,
  type HotkeySettings
} from '@shared/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { clipboardApi } from '@/lib/tauriApi';
import { getHistoryFetchLimit } from '@/lib/historyLimit';
import { cn } from '@/lib/utils';
import { useClipboardStore } from '@/store/clipboardStore';

type SettingsTab = 'general' | 'privacy' | 'storage' | 'hotkeys' | 'about';

interface FixedContentPrefill {
  title: string;
  content: string;
  nonce: number;
}

interface SettingsPanelProps {
  open: boolean;
  initialTab?: SettingsTab;
  prefillFixedContent?: FixedContentPrefill | null;
  onOpenChange: (open: boolean) => void;
}

const HOTKEY_LABELS: Record<keyof HotkeySettings, string> = {
  openPanel: '打开/隐藏面板',
  search: '聚焦搜索',
  pause: '暂停/恢复监听',
  clear: '清空历史',
  quickPastePrev: '复制上一项历史',
  quickPasteNext: '复制下一项历史'
};

const HOTKEY_DESCRIPTIONS: Record<keyof HotkeySettings, string> = {
  openPanel: '显示或隐藏主面板',
  search: '打开面板并自动聚焦搜索框',
  pause: '临时暂停或恢复剪贴板监听',
  clear: '清空非收藏历史记录',
  quickPastePrev: '复制更旧的历史内容到剪贴板',
  quickPasteNext: '复制更新的历史内容到剪贴板'
};

const HOTKEY_CONFLICT_LABELS: Record<string, string> = {
  openPanel: HOTKEY_LABELS.openPanel,
  search: HOTKEY_LABELS.search,
  pause: HOTKEY_LABELS.pause,
  clear: HOTKEY_LABELS.clear,
  quickPastePrev: HOTKEY_LABELS.quickPastePrev,
  quickPasteNext: HOTKEY_LABELS.quickPasteNext,
  'fixed content candidate': '当前固定内容'
};

const NORMAL_HOTKEY_KEYS: Array<keyof HotkeySettings> = ['openPanel', 'search', 'pause', 'clear'];
const QUICK_PASTE_HOTKEY_KEYS: Array<keyof HotkeySettings> = ['quickPastePrev', 'quickPasteNext'];
const FIXED_CONTENT_EXAMPLES = [
  { title: '常用回复', content: '收到，我稍后处理。' },
  { title: '邮件签名', content: '谢谢，祝好。' },
  { title: '日期占位', content: '今天需要同步的事项：' }
];
const MODIFIER_KEYS = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const;
type ModifierKey = (typeof MODIFIER_KEYS)[number];

const WHEEL_MODIFIER_OPTIONS: Array<{ value: AppSettings['wheelShortcutModifier']; label: string }> = [
  { value: 'ctrl', label: 'Ctrl' },
  { value: 'alt', label: 'Alt' },
  { value: 'shift', label: 'Shift' },
  { value: 'ctrl+alt', label: 'Ctrl+Alt' }
];

const MIN_MAX_ITEMS = 100;
const MAX_MAX_ITEMS = 1_000_000;

const WHEEL_SCOPE_OPTIONS: Array<{ value: AppSettings['wheelShortcutScope']; label: string }> = [
  { value: 'global', label: '全局生效' },
  { value: 'panel-only', label: '仅面板打开时' }
];

const THEME_MODE_OPTIONS: Array<{
  value: AppSettings['themeMode'];
  label: string;
  description: string;
  icon: JSX.Element;
}> = [
  {
    value: 'system',
    label: '跟随系统',
    description: '随 Windows 亮暗色自动切换',
    icon: <Monitor className="h-4 w-4" />
  },
  {
    value: 'light',
    label: '亮色',
    description: '清爽、低干扰的默认外观',
    icon: <Sun className="h-4 w-4" />
  },
  {
    value: 'dark',
    label: '暗色',
    description: '夜间和低光环境更舒适',
    icon: <Moon className="h-4 w-4" />
  }
];

const DISPLAY_TOKEN_MAP: Record<string, string> = {
  CommandOrControl: 'Ctrl',
  Command: 'Cmd',
  Meta: 'Win',
  Super: 'Win',
  Left: 'Left',
  Right: 'Right',
  Up: 'Up',
  Down: 'Down'
};

function isModifierKey(token: string): token is ModifierKey {
  return MODIFIER_KEYS.includes(token as ModifierKey);
}

function orderHotkeyTokens(tokens: string[]): string[] {
  const unique = Array.from(new Set(tokens));
  const modifiers = MODIFIER_KEYS.filter((key) => unique.includes(key));
  const others = unique.filter((key) => !isModifierKey(key));
  return [...modifiers, ...others];
}

function normalizeRecordedKey(key: string): string | null {
  const keyMap: Record<string, string> = {
    Control: 'Ctrl',
    Alt: 'Alt',
    Shift: 'Shift',
    Meta: 'Meta',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ' ': 'Space'
  };
  if (key === 'Escape') {
    return null;
  }
  if (keyMap[key]) {
    return keyMap[key];
  }
  if (/^F\d{1,2}$/i.test(key)) {
    return key.toUpperCase();
  }
  if (key.length === 1) {
    return key.toUpperCase();
  }
  return key.charAt(0).toUpperCase() + key.slice(1);
}

function formatHotkeyLabel(value: string): string {
  return value
    .split('+')
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => DISPLAY_TOKEN_MAP[token] ?? token)
    .join('+');
}

function hotkeyComparisonKey(value: string): string {
  const canonicalTokens = value
    .split('+')
    .map((token) => {
      const trimmed = token.trim();
      const lower = trimmed.toLowerCase();
      if (lower === 'commandorcontrol' || lower === 'control' || lower === 'ctrl') {
        return 'Ctrl';
      }
      if (lower === 'alt' || lower === 'option') {
        return 'Alt';
      }
      if (lower === 'shift') {
        return 'Shift';
      }
      if (['meta', 'command', 'cmd', 'super', 'win', 'windows'].includes(lower)) {
        return 'Meta';
      }
      if (lower === 'arrowleft') {
        return 'Left';
      }
      if (lower === 'arrowright') {
        return 'Right';
      }
      if (lower === 'arrowup') {
        return 'Up';
      }
      if (lower === 'arrowdown') {
        return 'Down';
      }
      if (trimmed.length === 1) {
        return trimmed.toUpperCase();
      }
      return trimmed;
    })
    .filter(Boolean);
  return orderHotkeyTokens(canonicalTokens).join('+').toLowerCase();
}

function fixedContentConflictLabel(command: string): string {
  if (HOTKEY_CONFLICT_LABELS[command]) {
    return HOTKEY_CONFLICT_LABELS[command];
  }
  const fixedContentMatch = /^fixed content (\d+)$/.exec(command);
  if (fixedContentMatch) {
    return `固定内容 #${fixedContentMatch[1]}`;
  }
  return command;
}

function readableErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function fixedContentSaveErrorMessage(error: unknown): string {
  const message = readableErrorMessage(error);
  const conflictMatch = /^hotkey (.+) is assigned to both (.+) and (.+)$/.exec(message);
  if (conflictMatch) {
    const [, hotkey, firstCommand, secondCommand] = conflictMatch;
    return `快捷键冲突：${formatHotkeyLabel(hotkey)} 已绑定到 ${fixedContentConflictLabel(firstCommand)} 和 ${fixedContentConflictLabel(secondCommand)}。`;
  }
  return `固定快捷内容保存失败：${message}`;
}

function findFixedContentHotkeyConflict(
  hotkey: string,
  enabled: boolean,
  currentId: number | null,
  hotkeys: HotkeySettings,
  fixedContents: FixedContent[]
): string | null {
  if (!enabled) {
    return null;
  }

  const candidateKey = hotkeyComparisonKey(hotkey);
  for (const key of Object.keys(hotkeys) as Array<keyof HotkeySettings>) {
    if (hotkeyComparisonKey(hotkeys[key]) === candidateKey) {
      return `快捷键冲突：${formatHotkeyLabel(hotkey)} 已绑定到 ${HOTKEY_LABELS[key]}。`;
    }
  }

  const existingContent = fixedContents.find(
    (content) =>
      content.enabled &&
      content.id !== currentId &&
      hotkeyComparisonKey(content.hotkey) === candidateKey
  );
  if (existingContent) {
    return `快捷键冲突：${formatHotkeyLabel(hotkey)} 已绑定到固定内容「${existingContent.title}」。`;
  }

  return null;
}

export function SettingsPanel({
  open,
  initialTab = 'general',
  prefillFixedContent = null,
  onOpenChange
}: SettingsPanelProps): JSX.Element {
  const settings = useClipboardStore((state) => state.settings);
  const setSettings = useClipboardStore((state) => state.setSettings);
  const setItems = useClipboardStore((state) => state.setItems);
  const itemsCount = useClipboardStore((state) => state.items.length);

  const [blacklist, setBlacklist] = useState<BlacklistApp[]>([]);
  const [newAppName, setNewAppName] = useState('');
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
  const [showBlacklistHelp, setShowBlacklistHelp] = useState(false);
  const [hotkeys, setHotkeys] = useState<HotkeySettings | null>(null);
  const [editingHotkey, setEditingHotkey] = useState<keyof HotkeySettings | null>(null);
  const [hotkeyConflicts, setHotkeyConflicts] = useState<string[]>([]);
  const [recordingPreview, setRecordingPreview] = useState('');
  const [fixedContents, setFixedContents] = useState<FixedContent[]>([]);
  const [showFixedContentForm, setShowFixedContentForm] = useState(false);
  const [editingFixedContent, setEditingFixedContent] = useState<FixedContent | null>(null);
  const [fixedContentTitle, setFixedContentTitle] = useState('');
  const [fixedContentValue, setFixedContentValue] = useState('');
  const [fixedContentHotkey, setFixedContentHotkey] = useState('');
  const [fixedContentEnabled, setFixedContentEnabled] = useState(true);
  const [recordingFixedContentHotkey, setRecordingFixedContentHotkey] = useState(false);
  const [fixedContentRecordingPreview, setFixedContentRecordingPreview] = useState('');
  const [savingFixedContent, setSavingFixedContent] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [clearState, setClearState] = useState<'idle' | 'clearing' | 'success' | 'error'>('idle');
  const [clearMessage, setClearMessage] = useState('');
  const [historyTransferStatus, setHistoryTransferStatus] = useState<string | null>(null);
  const [historyTransferBusy, setHistoryTransferBusy] = useState(false);
  const [maxItemsDraft, setMaxItemsDraft] = useState('10000');
  const pressedKeysRef = useRef<Set<string>>(new Set());
  const candidateComboRef = useRef('');
  const fixedContentPressedKeysRef = useRef<Set<string>>(new Set());
  const fixedContentCandidateComboRef = useRef('');
  const clearFeedbackTimerRef = useRef<number | null>(null);
  const settingsUpdateSeqRef = useRef<Partial<Record<keyof AppSettings, number>>>({});
  const hotkeyRecordSeqRef = useRef(0);
  const fixedContentHotkeyRecordSeqRef = useRef(0);
  const openRef = useRef(open);

  function openPrefilledFixedContentForm(title: string, content: string) {
    hotkeyRecordSeqRef.current += 1;
    setEditingHotkey(null);
    setRecordingPreview('');
    pressedKeysRef.current.clear();
    candidateComboRef.current = '';
    fixedContentHotkeyRecordSeqRef.current += 1;
    setRecordingFixedContentHotkey(false);
    setFixedContentRecordingPreview('');
    fixedContentPressedKeysRef.current.clear();
    fixedContentCandidateComboRef.current = '';
    setEditingFixedContent(null);
    setFixedContentTitle(title);
    setFixedContentValue(content);
    setFixedContentHotkey('');
    setFixedContentEnabled(true);
    setShowFixedContentForm(true);
    setErrorMessage('');
  }

  useEffect(() => {
    openRef.current = open;
    if (!open) {
      hotkeyRecordSeqRef.current += 1;
      fixedContentHotkeyRecordSeqRef.current += 1;
      setEditingHotkey(null);
      setRecordingPreview('');
      pressedKeysRef.current.clear();
      candidateComboRef.current = '';
      setRecordingFixedContentHotkey(false);
      setFixedContentRecordingPreview('');
      fixedContentPressedKeysRef.current.clear();
      fixedContentCandidateComboRef.current = '';
      setShowFixedContentForm(false);
      setEditingFixedContent(null);
      setFixedContentTitle('');
      setFixedContentValue('');
      setFixedContentHotkey('');
      setFixedContentEnabled(true);
      setSavingFixedContent(false);
      setErrorMessage('');
      setClearState('idle');
      setClearMessage('');
      setHistoryTransferStatus(null);
      setHistoryTransferBusy(false);
      return;
    }

    let cancelled = false;
    setActiveTab(initialTab);
    setErrorMessage('');
    void clipboardApi
      .getSettings()
      .then((nextSettings) => {
        if (!cancelled) {
          setSettings(nextSettings);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setErrorMessage('设置加载失败，请稍后重试。');
        }
      });
    void clipboardApi
      .listBlacklist()
      .then((apps) => {
        if (!cancelled) {
          setBlacklist(apps);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setErrorMessage('黑名单加载失败，请稍后重试。');
        }
      });
    void clipboardApi
      .getHotkeys()
      .then((nextHotkeys) => {
        if (!cancelled) {
          setHotkeys(nextHotkeys);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setErrorMessage('快捷键加载失败，请稍后重试。');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, initialTab, setSettings]);

  useEffect(() => {
    if (!open || !prefillFixedContent) {
      return;
    }
    setActiveTab('hotkeys');
    openPrefilledFixedContentForm(prefillFixedContent.title, prefillFixedContent.content);
  }, [open, prefillFixedContent?.nonce]);

  useEffect(() => {
    if (!open || activeTab !== 'hotkeys') {
      return;
    }

    let cancelled = false;
    void clipboardApi
      .listFixedContents()
      .then((contents) => {
        if (!cancelled) {
          setFixedContents(contents);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setErrorMessage('固定快捷内容加载失败，请稍后重试。');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [open, activeTab]);

  useEffect(() => {
    return () => {
      if (clearFeedbackTimerRef.current) {
        window.clearTimeout(clearFeedbackTimerRef.current);
      }
    };
  }, []);

  const safeSettings = useMemo<AppSettings>(
    () =>
      settings ?? {
        retentionDays: 0,
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
      },
    [settings]
  );

  useEffect(() => {
    if (open) {
      setMaxItemsDraft(String(safeSettings.maxItems));
    }
  }, [open, safeSettings.maxItems]);

  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    const seq = (settingsUpdateSeqRef.current[key] ?? 0) + 1;
    settingsUpdateSeqRef.current[key] = seq;
    setErrorMessage('');
    void clipboardApi
      .updateSetting(key, value)
      .then((nextSettings) => {
        if (settingsUpdateSeqRef.current[key] === seq) {
          const latestSettings = useClipboardStore.getState().settings ?? nextSettings;
          setSettings({ ...latestSettings, [key]: nextSettings[key] });
        }
      })
      .catch(() => {
        if (settingsUpdateSeqRef.current[key] === seq) {
          setErrorMessage('设置保存失败，请稍后重试。');
        }
      });
  };

  const commitMaxItemsDraft = () => {
    const trimmed = maxItemsDraft.trim();
    const next = Number(trimmed);
    if (
      !trimmed ||
      !Number.isInteger(next) ||
      next < MIN_MAX_ITEMS ||
      next > MAX_MAX_ITEMS
    ) {
      setMaxItemsDraft(String(safeSettings.maxItems));
      return;
    }

    if (next !== safeSettings.maxItems) {
      update('maxItems', next);
    } else {
      setMaxItemsDraft(String(safeSettings.maxItems));
    }
  };

  const handleClearHistory = async () => {
    if (!window.confirm('确认清空非收藏历史吗？收藏项会保留。')) {
      return;
    }

    if (clearFeedbackTimerRef.current) {
      window.clearTimeout(clearFeedbackTimerRef.current);
      clearFeedbackTimerRef.current = null;
    }

    setClearState('clearing');
    setClearMessage('正在清理历史，请稍候。');

    try {
      const result = await clipboardApi.clearHistory();
      if (!result.success) {
        throw new Error(result.error || 'clear-history-failed');
      }
      const latestItems = await clipboardApi.getHistory(getHistoryFetchLimit(safeSettings));
      setItems(latestItems);
      setClearState('success');
      setClearMessage(
        result.deleted > 0
          ? `清理完成，已删除 ${result.deleted} 条非收藏记录。`
          : '清理完成，当前没有可删除的非收藏记录。'
      );
    } catch {
      setClearState('error');
      setClearMessage('清理失败，请稍后重试。');
    }

    clearFeedbackTimerRef.current = window.setTimeout(() => {
      setClearState('idle');
      setClearMessage('');
      clearFeedbackTimerRef.current = null;
    }, 2600);
  };

  const handleExportHistory = async () => {
    const path = await saveDialog({
      title: '导出 ClipVault 历史',
      defaultPath: `clipvault-history-${new Date().toISOString().slice(0, 10)}.clipvault`,
      filters: [{ name: 'ClipVault History', extensions: ['clipvault'] }]
    });
    if (!path) {
      return;
    }

    setHistoryTransferBusy(true);
    setHistoryTransferStatus(null);
    try {
      const result = await clipboardApi.exportHistory(path);
      setHistoryTransferStatus(`已导出 ${result.exported} 条历史`);
    } catch {
      setHistoryTransferStatus('导出失败，请稍后重试。');
    } finally {
      setHistoryTransferBusy(false);
    }
  };

  const handleImportHistory = async () => {
    const path = await openDialog({
      title: '导入 ClipVault 历史',
      multiple: false,
      filters: [{ name: 'ClipVault History', extensions: ['clipvault'] }]
    });
    if (!path || Array.isArray(path)) {
      return;
    }

    setHistoryTransferBusy(true);
    setHistoryTransferStatus(null);
    try {
      const result = await clipboardApi.importHistory(path);
      setHistoryTransferStatus(
        `新增 ${result.inserted} 条，跳过重复 ${result.skippedDuplicates} 条，合并状态 ${result.mergedState} 条`
      );
    } catch {
      setHistoryTransferStatus('导入失败，请确认文件有效后重试。');
    } finally {
      setHistoryTransferBusy(false);
    }
  };

  const addBlacklist = () => {
    const appName = newAppName.trim();
    if (!appName) {
      return;
    }
    setErrorMessage('');
    void clipboardApi
      .addBlacklist(appName)
      .then(() => {
        setNewAppName('');
        return clipboardApi.listBlacklist();
      })
      .then(setBlacklist)
      .catch(() => setErrorMessage('黑名单保存失败，请稍后重试。'));
  };

  const removeBlacklist = (id: number) => {
    setErrorMessage('');
    void clipboardApi
      .removeBlacklist(id)
      .then(() => clipboardApi.listBlacklist())
      .then(setBlacklist)
      .catch(() => setErrorMessage('黑名单删除失败，请稍后重试。'));
  };

  const refreshFixedContents = async () => {
    const contents = await clipboardApi.listFixedContents();
    setFixedContents(contents);
  };

  const resetFixedContentForm = () => {
    fixedContentHotkeyRecordSeqRef.current += 1;
    setRecordingFixedContentHotkey(false);
    setFixedContentRecordingPreview('');
    fixedContentPressedKeysRef.current.clear();
    fixedContentCandidateComboRef.current = '';
    setShowFixedContentForm(false);
    setEditingFixedContent(null);
    setFixedContentTitle('');
    setFixedContentValue('');
    setFixedContentHotkey('');
    setFixedContentEnabled(true);
  };

  const openNewFixedContentForm = () => {
    openPrefilledFixedContentForm('', '');
  };

  const openEditFixedContentForm = (content: FixedContent) => {
    hotkeyRecordSeqRef.current += 1;
    setEditingHotkey(null);
    setRecordingPreview('');
    pressedKeysRef.current.clear();
    candidateComboRef.current = '';
    fixedContentHotkeyRecordSeqRef.current += 1;
    setRecordingFixedContentHotkey(false);
    setFixedContentRecordingPreview('');
    fixedContentPressedKeysRef.current.clear();
    fixedContentCandidateComboRef.current = '';
    setEditingFixedContent(content);
    setFixedContentTitle(content.title);
    setFixedContentValue(content.content);
    setFixedContentHotkey(content.hotkey);
    setFixedContentEnabled(content.enabled);
    setShowFixedContentForm(true);
    setErrorMessage('');
  };

  const startFixedContentHotkeyRecording = () => {
    hotkeyRecordSeqRef.current += 1;
    setEditingHotkey(null);
    setRecordingPreview('');
    pressedKeysRef.current.clear();
    candidateComboRef.current = '';
    fixedContentHotkeyRecordSeqRef.current += 1;
    setRecordingFixedContentHotkey(true);
    setFixedContentRecordingPreview('');
    fixedContentPressedKeysRef.current.clear();
    fixedContentCandidateComboRef.current = '';
    setErrorMessage('');
  };

  const saveFixedContent = async () => {
    const title = fixedContentTitle.trim();
    const content = fixedContentValue;
    const hotkey = fixedContentHotkey.trim();
    if (!title || !content.trim() || !hotkey) {
      setErrorMessage('请填写固定内容的标题、内容和快捷键。');
      return;
    }

    setSavingFixedContent(true);
    setErrorMessage('');

    try {
      const currentHotkeys = hotkeys ?? await clipboardApi.getHotkeys();
      const conflictMessage = findFixedContentHotkeyConflict(
        hotkey,
        fixedContentEnabled,
        editingFixedContent?.id ?? null,
        currentHotkeys,
        fixedContents
      );
      if (conflictMessage) {
        setErrorMessage(conflictMessage);
        return;
      }

      try {
        const available = await clipboardApi.checkHotkeyAvailable(hotkey);
        if (available === false) {
          const accepted = window.confirm(`快捷键 ${formatHotkeyLabel(hotkey)} 可能被其他应用占用，仍然保存吗？`);
          if (!accepted) {
            return;
          }
        }
      } catch {
        // 可用性检测只是保存前提示，最终冲突由后端创建/更新接口处理。
      }

      const input: FixedContentInput = {
        title,
        content,
        hotkey,
        enabled: fixedContentEnabled
      };

      if (editingFixedContent) {
        await clipboardApi.updateFixedContent(editingFixedContent.id, input);
      } else {
        await clipboardApi.createFixedContent(input);
      }

      await refreshFixedContents();
      resetFixedContentForm();
    } catch (error) {
      setErrorMessage(fixedContentSaveErrorMessage(error));
    } finally {
      setSavingFixedContent(false);
    }
  };

  const deleteFixedContent = async (id: number) => {
    setErrorMessage('');
    try {
      await clipboardApi.deleteFixedContent(id);
      await refreshFixedContents();
      if (editingFixedContent?.id === id) {
        resetFixedContentForm();
      }
    } catch {
      setErrorMessage('固定快捷内容删除失败，请稍后重试。');
    }
  };

  const resetHotkeys = () => {
    hotkeyRecordSeqRef.current += 1;
    setEditingHotkey(null);
    setRecordingPreview('');
    pressedKeysRef.current.clear();
    candidateComboRef.current = '';
    setHotkeyConflicts([]);
    setErrorMessage('');
    void clipboardApi
      .updateHotkeys(DEFAULT_HOTKEYS)
      .then(setHotkeys)
      .catch(() => setErrorMessage('快捷键恢复失败，请稍后重试。'));
  };

  const cancelHotkeyRecording = () => {
    hotkeyRecordSeqRef.current += 1;
    setEditingHotkey(null);
    setRecordingPreview('');
    pressedKeysRef.current.clear();
    candidateComboRef.current = '';
  };

  const startHotkeyRecording = (key: keyof HotkeySettings) => {
    fixedContentHotkeyRecordSeqRef.current += 1;
    setRecordingFixedContentHotkey(false);
    setFixedContentRecordingPreview('');
    fixedContentPressedKeysRef.current.clear();
    fixedContentCandidateComboRef.current = '';
    hotkeyRecordSeqRef.current += 1;
    setHotkeyConflicts([]);
    setEditingHotkey(key);
    setRecordingPreview('');
    pressedKeysRef.current.clear();
    candidateComboRef.current = '';
  };

  useEffect(() => {
    if (!open || !editingHotkey || !hotkeys) {
      return;
    }

    const updatePreviewFromPressed = () => {
      const ordered = orderHotkeyTokens(Array.from(pressedKeysRef.current));
      setRecordingPreview(ordered.join('+'));
    };

    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();

      if (event.key === 'Escape') {
        cancelHotkeyRecording();
        return;
      }

      const token = normalizeRecordedKey(event.key);
      if (!token) {
        return;
      }

      if (!isModifierKey(token)) {
        for (const key of Array.from(pressedKeysRef.current)) {
          if (!isModifierKey(key)) {
            pressedKeysRef.current.delete(key);
          }
        }
      }
      pressedKeysRef.current.add(token);
      const candidate = orderHotkeyTokens(Array.from(pressedKeysRef.current)).join('+');
      if (!isModifierKey(token)) {
        candidateComboRef.current = candidate;
      }
      setRecordingPreview(candidate);
    };

    const onKeyUp = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();

      const token = normalizeRecordedKey(event.key);
      if (!token) {
        return;
      }

      if (!isModifierKey(token)) {
        const combo = candidateComboRef.current || orderHotkeyTokens(Array.from(pressedKeysRef.current)).join('+');
        if (!combo) {
          return;
        }
        const editingKey = editingHotkey;
        const next = { ...hotkeys, [editingKey]: combo };
        cancelHotkeyRecording();
        const operationSeq = hotkeyRecordSeqRef.current;
        const isRecordingRequestActive = () => openRef.current && hotkeyRecordSeqRef.current === operationSeq;

        void (async () => {
          try {
            const conflicts = await clipboardApi.checkHotkeyConflicts(next);
            if (!isRecordingRequestActive()) {
              return;
            }
            setHotkeyConflicts(conflicts);
            if (conflicts.length > 0) {
              return;
            }

            const available = await clipboardApi.checkHotkeyAvailable(combo);
            if (!isRecordingRequestActive()) {
              return;
            }
            if (available === false) {
              const accepted = window.confirm(
                `快捷键 ${formatHotkeyLabel(combo)} 可能被其他应用占用，仍然保存吗？`
              );
              if (!isRecordingRequestActive()) {
                return;
              }
              if (!accepted) {
                setHotkeyConflicts([`快捷键可能被其他应用占用: ${formatHotkeyLabel(combo)}`]);
                return;
              }
            }

            const updated = await clipboardApi.updateHotkeys({ [editingKey]: combo });
            if (isRecordingRequestActive()) {
              setHotkeys(updated);
            }
          } catch {
            if (isRecordingRequestActive()) {
              setErrorMessage('快捷键保存失败，请稍后重试。');
            }
          }
        })();
        return;
      }

      pressedKeysRef.current.delete(token);
      updatePreviewFromPressed();
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [editingHotkey, hotkeys, open]);

  useEffect(() => {
    if (!open || !recordingFixedContentHotkey) {
      return;
    }

    const updatePreviewFromPressed = () => {
      const ordered = orderHotkeyTokens(Array.from(fixedContentPressedKeysRef.current));
      setFixedContentRecordingPreview(ordered.join('+'));
    };

    const cancelFixedRecording = () => {
      fixedContentHotkeyRecordSeqRef.current += 1;
      setRecordingFixedContentHotkey(false);
      setFixedContentRecordingPreview('');
      fixedContentPressedKeysRef.current.clear();
      fixedContentCandidateComboRef.current = '';
    };

    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();

      if (event.key === 'Escape') {
        cancelFixedRecording();
        return;
      }

      const token = normalizeRecordedKey(event.key);
      if (!token) {
        return;
      }

      if (!isModifierKey(token)) {
        for (const key of Array.from(fixedContentPressedKeysRef.current)) {
          if (!isModifierKey(key)) {
            fixedContentPressedKeysRef.current.delete(key);
          }
        }
      }

      fixedContentPressedKeysRef.current.add(token);
      const candidate = orderHotkeyTokens(Array.from(fixedContentPressedKeysRef.current)).join('+');
      if (!isModifierKey(token)) {
        fixedContentCandidateComboRef.current = candidate;
      }
      setFixedContentRecordingPreview(candidate);
    };

    const onKeyUp = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();

      const token = normalizeRecordedKey(event.key);
      if (!token) {
        return;
      }

      if (!isModifierKey(token)) {
        const combo =
          fixedContentCandidateComboRef.current ||
          orderHotkeyTokens(Array.from(fixedContentPressedKeysRef.current)).join('+');
        if (combo) {
          setFixedContentHotkey(combo);
          cancelFixedRecording();
        }
        return;
      }

      fixedContentPressedKeysRef.current.delete(token);
      updatePreviewFromPressed();
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [open, recordingFixedContentHotkey]);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
    >
      <DialogContent className="settings-dialog flex h-[600px] max-h-[calc(100vh-40px)] max-w-[820px] flex-col overflow-hidden rounded-[1.7rem] border border-slate-200 bg-[#f8fcfa] p-3 shadow-2xl">
        <DialogHeader className="settings-header mb-3 flex shrink-0 flex-row items-center justify-between gap-3 rounded-[1.35rem] border border-slate-200 bg-white/90 px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-teal-100 bg-teal-50 text-teal-800">
              <SlidersHorizontal className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-teal-700">ClipVault Settings</p>
              <DialogTitle className="mt-1 text-lg font-semibold tracking-tight text-slate-950">偏好设置</DialogTitle>
              <DialogDescription className="mt-1 text-sm text-slate-500">
                管理保留策略、隐私过滤、存储限制、快捷键和外观。
              </DialogDescription>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className="hidden rounded-full border border-teal-100 bg-teal-50 px-2.5 py-1 text-[11px] font-semibold text-teal-800 sm:inline-flex">
              本地优先
            </span>
            <DialogClose className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-500 transition-colors hover:border-teal-200 hover:text-teal-800">
              <X className="h-4 w-4" />
            </DialogClose>
          </div>
        </DialogHeader>

        <Tabs
          value={activeTab}
          onValueChange={(value) => setActiveTab(value as SettingsTab)}
          className="flex min-h-0 flex-1 flex-col"
        >
          <TabsList className="grid w-full shrink-0 grid-cols-5 rounded-[1.15rem] border border-teal-100 bg-teal-50/45 p-1">
            <TabsTrigger className="rounded-[0.95rem] font-semibold" value="general">常规</TabsTrigger>
            <TabsTrigger className="rounded-[0.95rem] font-semibold" value="privacy">隐私</TabsTrigger>
            <TabsTrigger className="rounded-[0.95rem] font-semibold" value="storage">存储</TabsTrigger>
            <TabsTrigger className="rounded-[0.95rem] font-semibold" value="hotkeys">快捷键</TabsTrigger>
            <TabsTrigger className="rounded-[0.95rem] font-semibold" value="about">关于</TabsTrigger>
          </TabsList>

          {errorMessage ? (
            <div className="mt-2 shrink-0 rounded-2xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {errorMessage}
            </div>
          ) : null}

          <TabsContent value="general" className="settings-tab-panel min-h-0 flex-1 space-y-3 overflow-y-auto pr-1 pt-2.5">
            <div className="rounded-[1.25rem] border border-slate-200 bg-white p-3.5">
              <div>
                <p className="text-sm font-semibold">主题模式</p>
                <p className="mt-1 text-xs text-muted-foreground">默认跟随系统，也可以固定为亮色或暗色。</p>
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-3">
                {THEME_MODE_OPTIONS.map((option) => {
                  const selected = safeSettings.themeMode === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      aria-label={`主题模式：${option.label}`}
                      className={cn(
                        'rounded-[1.1rem] border p-3 text-left transition-colors',
                        selected
                          ? 'border-teal-500 bg-teal-50 text-teal-950 ring-2 ring-teal-100'
                          : 'border-slate-200 bg-slate-50/60 text-slate-700 hover:border-teal-200 hover:bg-teal-50/45'
                      )}
                      onClick={() => update('themeMode', option.value)}
                    >
                      <span className="flex items-center gap-2 text-sm font-semibold">
                        {option.icon}
                        {option.label}
                      </span>
                      <span className="mt-1 block text-xs leading-5 text-muted-foreground">{option.description}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="grid min-h-[58px] grid-cols-[1fr_180px] items-center gap-4 rounded-[1.15rem] border border-slate-200 bg-white px-4 py-3">
              <div className="min-w-0">
                <span className="text-sm font-semibold">历史保留时长</span>
                <p className="mt-1 text-xs text-muted-foreground">仅清理超过时长的非收藏项；永久保留仍受最大条目数限制。</p>
              </div>
              <select
                className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm"
                value={safeSettings.retentionDays}
                onChange={(event) => update('retentionDays', Number(event.target.value))}
              >
                <option value={0}>永久保留</option>
                <option value={7}>7 天</option>
                <option value={14}>14 天</option>
                <option value={30}>30 天</option>
              </select>
            </div>
            <div className="grid min-h-[58px] grid-cols-[1fr_180px] items-center gap-4 rounded-[1.15rem] border border-slate-200 bg-white px-4 py-3">
              <span className="text-sm font-semibold">最大条目数</span>
              <Input
                type="number"
                min={MIN_MAX_ITEMS}
                max={MAX_MAX_ITEMS}
                value={maxItemsDraft}
                onChange={(event) => setMaxItemsDraft(event.target.value)}
                onBlur={commitMaxItemsDraft}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.currentTarget.blur();
                  }
                  if (event.key === 'Escape') {
                    setMaxItemsDraft(String(safeSettings.maxItems));
                    event.currentTarget.blur();
                  }
                }}
              />
            </div>
            <div className="grid min-h-[58px] grid-cols-[1fr_180px] items-center gap-4 rounded-[1.15rem] border border-slate-200 bg-white px-4 py-3">
              <span className="text-sm font-semibold">开机自启动</span>
              <div className="flex justify-end">
                <Switch
                  checked={safeSettings.launchOnStartup}
                  onCheckedChange={(checked) => update('launchOnStartup', checked)}
                />
              </div>
            </div>
            <Separator />
            <div className="space-y-2 rounded-[1.25rem] border border-orange-100 bg-[#fffaf4] p-4">
              <p className="text-sm font-semibold text-orange-900">清理历史</p>
              <p className="text-xs text-orange-700">只清空非收藏项，收藏项永久保留。</p>
              <Button
                variant="destructive"
                disabled={clearState === 'clearing'}
                onClick={() => {
                  void handleClearHistory();
                }}
              >
                {clearState === 'clearing' ? '清理中...' : '清空历史'}
              </Button>
              {clearMessage ? (
                <p className="rounded-xl bg-white/75 px-3 py-2 text-xs text-orange-800">{clearMessage}</p>
              ) : null}
            </div>
          </TabsContent>

          <TabsContent value="privacy" className="settings-tab-panel min-h-0 flex-1 space-y-3 overflow-y-auto pr-1 pt-2.5">
            <div className="grid min-h-[68px] grid-cols-[1fr_120px] items-center gap-4 rounded-[1.15rem] border border-slate-200 bg-white px-4 py-3">
              <div>
                <p className="text-sm font-semibold">启用敏感内容过滤</p>
                <p className="mt-1 text-xs text-muted-foreground">自动跳过密码、卡号、令牌等敏感内容。</p>
              </div>
              <div className="flex justify-end">
                <Switch
                  checked={safeSettings.enableSensitiveFilter}
                  onCheckedChange={(checked) => update('enableSensitiveFilter', checked)}
                />
              </div>
            </div>
            <div className="grid min-h-[68px] grid-cols-[1fr_120px] items-center gap-4 rounded-[1.15rem] border border-slate-200 bg-white px-4 py-3">
              <div>
                <p className="text-sm font-semibold">启用应用黑名单</p>
                <p className="mt-1 text-xs text-muted-foreground">在黑名单应用中复制的内容不会被记录。</p>
              </div>
              <div className="flex justify-end">
                <Switch
                  checked={safeSettings.enableBlacklist}
                  onCheckedChange={(checked) => update('enableBlacklist', checked)}
                />
              </div>
            </div>

            <div className="space-y-3 rounded-[1.25rem] border border-slate-200 bg-white p-4">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold">黑名单应用</p>
                <button
                  type="button"
                  className="text-xs font-semibold text-teal-700 hover:text-teal-900"
                  onClick={() => setShowBlacklistHelp((prev) => !prev)}
                >
                  {showBlacklistHelp ? '收起说明' : '使用说明'}
                </button>
              </div>
              {showBlacklistHelp ? (
                <div className="rounded-xl bg-white/80 p-3 text-xs leading-5 text-muted-foreground">
                  添加进程名或应用名即可，例如 chrome.exe、1Password、Bitwarden、KeePass。
                </div>
              ) : null}
              <div className="flex items-center gap-2">
                <Input
                  value={newAppName}
                  onChange={(event) => setNewAppName(event.target.value)}
                  placeholder="例如 chrome.exe 或 1Password"
                />
                <Button
                  onClick={addBlacklist}
                  disabled={!newAppName.trim()}
                  className="w-20"
                >
                  添加
                </Button>
              </div>
              <div className="max-h-44 space-y-2 overflow-auto pr-1">
                {blacklist.map((app) => (
                  <div
                    key={app.id}
                    className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50/60 px-3 py-2 text-sm"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      {app.isBuiltin ? <Badge>内置</Badge> : <Badge className="bg-teal-50 text-teal-700">自定义</Badge>}
                      <span className="truncate">{app.appName}</span>
                    </div>
                    {!app.isBuiltin ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-red-600 hover:bg-red-50"
                        onClick={() => removeBlacklist(app.id)}
                      >
                        删除
                      </Button>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          </TabsContent>

          <TabsContent value="storage" className="settings-tab-panel min-h-0 flex-1 space-y-3 overflow-y-auto pr-1 pt-2.5">
            <div className="space-y-3 rounded-[1.25rem] border border-teal-100 bg-white p-4">
              <div>
                <p className="text-sm font-semibold">历史备份</p>
                <p className="mt-1 text-xs text-muted-foreground">仅导入导出历史记录和富格式数据，不包含设置、黑名单或快捷键。</p>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <Button
                  type="button"
                  variant="outline"
                  className="gap-2 leading-none"
                  disabled={historyTransferBusy}
                  onClick={() => {
                    void handleExportHistory();
                  }}
                >
                  <Download className="block h-4 w-4 shrink-0" />
                  <span className="leading-none">{historyTransferBusy ? '处理中...' : '导出历史'}</span>
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="gap-2 leading-none"
                  disabled={historyTransferBusy}
                  onClick={() => {
                    void handleImportHistory();
                  }}
                >
                  <Upload className="block h-4 w-4 shrink-0" />
                  <span className="leading-none">{historyTransferBusy ? '处理中...' : '导入历史'}</span>
                </Button>
              </div>
              {historyTransferStatus ? (
                <p className="rounded-xl bg-teal-50 px-3 py-2 text-xs font-medium text-teal-800">{historyTransferStatus}</p>
              ) : null}
            </div>
            <div className="grid min-h-[58px] grid-cols-[1fr_180px] items-center gap-4 rounded-[1.15rem] border border-slate-200 bg-white px-4 py-3">
              <span className="text-sm font-semibold">文本限制（KB）</span>
              <Input
                type="number"
                min={10}
                max={1024}
                value={safeSettings.textLimitKb}
                onChange={(event) => update('textLimitKb', Number(event.target.value))}
              />
            </div>
            <div className="grid min-h-[58px] grid-cols-[1fr_180px] items-center gap-4 rounded-[1.15rem] border border-slate-200 bg-white px-4 py-3">
              <span className="text-sm font-semibold">图片压缩</span>
              <select
                className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm"
                value={safeSettings.imageCompression}
                onChange={(event) => update('imageCompression', event.target.value as AppSettings['imageCompression'])}
              >
                <option value="original">原图</option>
                <option value="high">高质量</option>
                <option value="medium">中质量</option>
              </select>
            </div>
          </TabsContent>

          <TabsContent value="hotkeys" className="settings-tab-panel min-h-0 flex-1 space-y-3 overflow-y-auto pr-1 pt-2.5 text-sm">
            <div className="rounded-[1.15rem] border border-slate-200 bg-white px-4 py-3 text-xs leading-5 text-muted-foreground">
              点击右侧快捷键重新录入。按 Esc 可取消录入；检测到冲突时不会保存。
            </div>

            <div className="space-y-3 rounded-[1.25rem] border border-slate-200 bg-white p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold">鼠标滚轮快捷键</p>
                  <p className="mt-1 text-xs text-muted-foreground">按住修饰键并滚轮浏览历史：向上更旧，向下更新。</p>
                </div>
                <Switch
                  checked={safeSettings.wheelShortcutEnabled}
                  onCheckedChange={(checked) => update('wheelShortcutEnabled', checked)}
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1 text-xs font-semibold text-muted-foreground">
                  <span>修饰键</span>
                  <select
                    className="h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-foreground"
                    value={safeSettings.wheelShortcutModifier}
                    disabled={!safeSettings.wheelShortcutEnabled}
                    onChange={(event) =>
                      update('wheelShortcutModifier', event.target.value as AppSettings['wheelShortcutModifier'])
                    }
                  >
                    {WHEEL_MODIFIER_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="space-y-1 text-xs font-semibold text-muted-foreground">
                  <span>生效范围</span>
                  <select
                    className="h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-foreground"
                    value={safeSettings.wheelShortcutScope}
                    disabled={!safeSettings.wheelShortcutEnabled}
                    onChange={(event) =>
                      update('wheelShortcutScope', event.target.value as AppSettings['wheelShortcutScope'])
                    }
                  >
                    {WHEEL_SCOPE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>

            <HotkeyGroup
              title="常规快捷键"
              keys={NORMAL_HOTKEY_KEYS}
              hotkeys={hotkeys}
              editingHotkey={editingHotkey}
              recordingPreview={recordingPreview}
              onRecord={startHotkeyRecording}
            />
            <HotkeyGroup
              title="历史快速复制"
              keys={QUICK_PASTE_HOTKEY_KEYS}
              hotkeys={hotkeys}
              editingHotkey={editingHotkey}
              recordingPreview={recordingPreview}
              onRecord={startHotkeyRecording}
            />

            <div className="space-y-3 rounded-[1.25rem] border border-slate-200 bg-white p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-black uppercase tracking-[0.16em] text-teal-700">固定快捷内容</p>
                  <p className="mt-1 text-xs text-muted-foreground">为常用文本绑定快捷键，触发后写入剪贴板并粘贴。</p>
                </div>
                <Button
                  size="sm"
                  onClick={openNewFixedContentForm}
                >
                  新增固定内容
                </Button>
              </div>

              <div className="rounded-[1.1rem] border border-teal-100 bg-teal-50/45 p-3">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <p className="text-xs font-black uppercase tracking-[0.16em] text-teal-700">试用示例</p>
                </div>
                <div className="grid gap-2 sm:grid-cols-3">
                  {FIXED_CONTENT_EXAMPLES.map((example) => (
                    <div
                      key={example.title}
                      className="flex min-h-[116px] flex-col justify-between rounded-lg border border-teal-100 bg-white px-3 py-2.5"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-slate-900">{example.title}</p>
                        <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-600">{example.content}</p>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="mt-2 w-full border-teal-100 bg-white text-teal-800 hover:bg-teal-50"
                        aria-label={`使用示例 ${example.title}`}
                        onClick={() => openPrefilledFixedContentForm(example.title, example.content)}
                      >
                        使用示例
                      </Button>
                    </div>
                  ))}
                </div>
              </div>

              {fixedContents.length > 0 ? (
                <div className="space-y-1">
                  {fixedContents.map((content) => (
                    <div
                      key={content.id}
                      className="grid gap-3 border-b border-slate-100 py-2 last:border-0 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold">{content.title}</p>
                        <p className="truncate text-xs text-muted-foreground">{content.content}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="rounded-xl border border-teal-100 bg-teal-50 px-3 py-1.5 font-mono text-xs font-bold text-teal-900">
                          {formatHotkeyLabel(content.hotkey)}
                        </span>
                        <Badge className={content.enabled ? 'bg-teal-50 text-teal-700' : 'bg-slate-100 text-slate-500'}>
                          {content.enabled ? '已启用' : '已停用'}
                        </Badge>
                      </div>
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`编辑固定内容 ${content.title}`}
                          onClick={() => openEditFixedContentForm(content)}
                        >
                          编辑
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-red-600 hover:bg-red-50"
                          aria-label={`删除固定内容 ${content.title}`}
                          onClick={() => {
                            void deleteFixedContent(content.id);
                          }}
                        >
                          删除
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="rounded-xl bg-slate-50 px-3 py-2 text-xs text-muted-foreground">还没有固定快捷内容。</p>
              )}

              {showFixedContentForm ? (
                <div className="space-y-3 border-t border-slate-100 pt-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label
                      htmlFor="fixed-content-title"
                      className="space-y-1 text-xs font-semibold text-muted-foreground"
                    >
                      <span>标题</span>
                      <Input
                        id="fixed-content-title"
                        value={fixedContentTitle}
                        onChange={(event) => setFixedContentTitle(event.target.value)}
                        placeholder="例如：常用回复"
                      />
                    </label>
                    <div className="space-y-1 text-xs font-semibold text-muted-foreground">
                      <span>快捷键</span>
                      <button
                        type="button"
                        aria-label={
                          fixedContentHotkey
                            ? `录制固定内容快捷键 ${formatHotkeyLabel(fixedContentHotkey)}`
                            : '录制固定内容快捷键'
                        }
                        className="flex h-10 w-full items-center justify-center rounded-xl border border-teal-100 bg-teal-50 px-3 font-mono text-xs font-bold text-teal-900 hover:border-teal-300"
                        onClick={startFixedContentHotkeyRecording}
                      >
                        {recordingFixedContentHotkey ? (
                          <span className="inline-flex items-center gap-1.5">
                            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-teal-700" />
                            <span>
                              {fixedContentRecordingPreview
                                ? formatHotkeyLabel(fixedContentRecordingPreview)
                                : '请按组合键...'}
                            </span>
                          </span>
                        ) : fixedContentHotkey ? (
                          formatHotkeyLabel(fixedContentHotkey)
                        ) : (
                          '录制固定内容快捷键'
                        )}
                      </button>
                    </div>
                  </div>
                  <label
                    htmlFor="fixed-content-body"
                    className="space-y-1 text-xs font-semibold text-muted-foreground"
                  >
                    <span>内容</span>
                    <textarea
                      id="fixed-content-body"
                      className="min-h-24 w-full resize-y rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-teal-300 focus:ring-2 focus:ring-teal-100"
                      value={fixedContentValue}
                      onChange={(event) => setFixedContentValue(event.target.value)}
                      placeholder="输入要粘贴的固定内容"
                    />
                  </label>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <label className="inline-flex items-center gap-2 text-xs font-semibold text-muted-foreground">
                      <Switch
                        checked={fixedContentEnabled}
                        onCheckedChange={setFixedContentEnabled}
                      />
                      <span>启用固定内容</span>
                    </label>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={resetFixedContentForm}
                      >
                        取消
                      </Button>
                      <Button
                        size="sm"
                        disabled={
                          savingFixedContent ||
                          !fixedContentTitle.trim() ||
                          !fixedContentValue.trim() ||
                          !fixedContentHotkey.trim()
                        }
                        onClick={() => {
                          void saveFixedContent();
                        }}
                      >
                        {savingFixedContent ? '保存中...' : '保存固定内容'}
                      </Button>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>

            {hotkeyConflicts.length > 0 ? (
              <div className="rounded-[1.15rem] border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-700">
                {hotkeyConflicts.map((item) => (
                  <p key={item}>{item}</p>
                ))}
              </div>
            ) : null}

            <div className="flex justify-end">
              <Button
                variant="ghost"
                size="sm"
                onClick={resetHotkeys}
              >
                恢复默认快捷键
              </Button>
            </div>
          </TabsContent>

          <TabsContent value="about" className="settings-tab-panel min-h-0 flex-1 space-y-3 overflow-y-auto pr-1 pt-2.5 text-sm">
            <div className="rounded-[1.25rem] border border-slate-200 bg-white p-4">
              <p className="font-black text-slate-950">ClipVault v2.1.4</p>
              <p className="mt-2 text-muted-foreground">当前缓存条目：{itemsCount}</p>
              <p className="mt-1 text-muted-foreground">数据默认保存在本地 Tauri 应用数据目录。</p>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

interface HotkeyGroupProps {
  title: string;
  keys: Array<keyof HotkeySettings>;
  hotkeys: HotkeySettings | null;
  editingHotkey: keyof HotkeySettings | null;
  recordingPreview: string;
  onRecord: (key: keyof HotkeySettings) => void;
}

function HotkeyGroup({
  title,
  keys,
  hotkeys,
  editingHotkey,
  recordingPreview,
  onRecord
}: HotkeyGroupProps): JSX.Element {
  return (
    <div className="space-y-2 rounded-[1.25rem] border border-slate-200 bg-white p-4">
      <p className="text-xs font-black uppercase tracking-[0.16em] text-teal-700">{title}</p>
      {keys.map((key) => {
        const value = hotkeys?.[key] ?? DEFAULT_HOTKEYS[key];
        return (
          <div
            key={key}
            className="flex items-center justify-between gap-3 border-b border-slate-100 py-2 last:border-0"
          >
            <div className="min-w-0">
              <p className="text-sm font-semibold">{HOTKEY_LABELS[key]}</p>
              <p className="text-xs text-muted-foreground">{HOTKEY_DESCRIPTIONS[key]}</p>
            </div>
            <button
              type="button"
              className="rounded-xl border border-teal-100 bg-teal-50 px-3 py-1.5 font-mono text-xs font-bold text-teal-900 hover:border-teal-300"
              onClick={() => onRecord(key)}
            >
              {editingHotkey === key ? (
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-teal-700" />
                  <span>{recordingPreview ? formatHotkeyLabel(recordingPreview) : '请按组合键...'}</span>
                </span>
              ) : (
                formatHotkeyLabel(value)
              )}
            </button>
          </div>
        );
      })}
    </div>
  );
}
