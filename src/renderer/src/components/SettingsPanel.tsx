import { useEffect, useMemo, useRef, useState } from 'react';
import { Monitor, Moon, Sun, X } from 'lucide-react';
import { DEFAULT_HOTKEYS, type AppSettings, type BlacklistApp, type HotkeySettings } from '@shared/types';
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
import { cn } from '@/lib/utils';
import { useClipboardStore } from '@/store/clipboardStore';

type SettingsTab = 'general' | 'privacy' | 'storage' | 'hotkeys' | 'about';

interface SettingsPanelProps {
  open: boolean;
  initialTab?: SettingsTab;
  onOpenChange: (open: boolean) => void;
}

const HOTKEY_LABELS: Record<keyof HotkeySettings, string> = {
  openPanel: '打开/隐藏面板',
  search: '聚焦搜索',
  pause: '暂停/恢复监听',
  clear: '清空历史',
  quickPastePrev: '快速粘贴上一项',
  quickPasteNext: '快速粘贴下一项'
};

const HOTKEY_DESCRIPTIONS: Record<keyof HotkeySettings, string> = {
  openPanel: '显示或隐藏主面板',
  search: '打开面板并自动聚焦搜索框',
  pause: '临时暂停或恢复剪贴板监听',
  clear: '清空非收藏历史记录',
  quickPastePrev: '无需打开面板，直接粘贴更旧的内容',
  quickPasteNext: '无需打开面板，向更新的历史前进'
};

const NORMAL_HOTKEY_KEYS: Array<keyof HotkeySettings> = ['openPanel', 'search', 'pause', 'clear'];
const QUICK_PASTE_HOTKEY_KEYS: Array<keyof HotkeySettings> = ['quickPastePrev', 'quickPasteNext'];
const MODIFIER_KEYS = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const;
type ModifierKey = (typeof MODIFIER_KEYS)[number];

const WHEEL_MODIFIER_OPTIONS: Array<{ value: AppSettings['wheelShortcutModifier']; label: string }> = [
  { value: 'ctrl', label: 'Ctrl' },
  { value: 'alt', label: 'Alt' },
  { value: 'shift', label: 'Shift' },
  { value: 'ctrl+alt', label: 'Ctrl+Alt' }
];

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

export function SettingsPanel({ open, initialTab = 'general', onOpenChange }: SettingsPanelProps): JSX.Element {
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
  const [errorMessage, setErrorMessage] = useState('');
  const [clearState, setClearState] = useState<'idle' | 'clearing' | 'success' | 'error'>('idle');
  const [clearMessage, setClearMessage] = useState('');
  const pressedKeysRef = useRef<Set<string>>(new Set());
  const candidateComboRef = useRef('');
  const clearFeedbackTimerRef = useRef<number | null>(null);
  const settingsUpdateSeqRef = useRef<Partial<Record<keyof AppSettings, number>>>({});
  const hotkeyRecordSeqRef = useRef(0);
  const openRef = useRef(open);

  useEffect(() => {
    openRef.current = open;
    if (!open) {
      hotkeyRecordSeqRef.current += 1;
      setEditingHotkey(null);
      setRecordingPreview('');
      pressedKeysRef.current.clear();
      candidateComboRef.current = '';
      setErrorMessage('');
      setClearState('idle');
      setClearMessage('');
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
    return () => {
      if (clearFeedbackTimerRef.current) {
        window.clearTimeout(clearFeedbackTimerRef.current);
      }
    };
  }, []);

  const safeSettings = useMemo<AppSettings>(
    () =>
      settings ?? {
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
      },
    [settings]
  );

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
      const latestItems = await clipboardApi.getHistory(300);
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

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
    >
      <DialogContent className="settings-dialog max-h-[90vh] max-w-[860px] overflow-auto rounded-[1.65rem] border border-slate-200 bg-[#f7fbf8] p-4 shadow-2xl">
        <DialogHeader className="settings-header mb-4 flex flex-row items-center justify-between gap-3 rounded-[1.35rem] border border-slate-200 bg-white px-4 py-3">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-teal-700">ClipVault Settings</p>
            <DialogTitle className="mt-1 text-lg font-semibold tracking-tight text-slate-950">偏好设置</DialogTitle>
            <DialogDescription className="mt-1 text-sm text-slate-500">
              管理保留策略、隐私过滤、存储限制、快捷键和外观。
            </DialogDescription>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className="hidden rounded-full border border-teal-100 bg-teal-50 px-3 py-1 text-xs font-semibold text-teal-800 sm:inline-flex">
              本地优先
            </span>
            <DialogClose className="shrink-0 rounded-full border border-slate-200 bg-white">
              <X className="h-4 w-4" />
            </DialogClose>
          </div>
        </DialogHeader>

        <Tabs
          value={activeTab}
          onValueChange={(value) => setActiveTab(value as SettingsTab)}
        >
          <TabsList className="grid w-full grid-cols-5 rounded-2xl border border-slate-200 bg-white p-1">
            <TabsTrigger className="rounded-xl font-medium" value="general">常规</TabsTrigger>
            <TabsTrigger className="rounded-xl font-medium" value="privacy">隐私</TabsTrigger>
            <TabsTrigger className="rounded-xl font-medium" value="storage">存储</TabsTrigger>
            <TabsTrigger className="rounded-xl font-medium" value="hotkeys">快捷键</TabsTrigger>
            <TabsTrigger className="rounded-xl font-medium" value="about">关于</TabsTrigger>
          </TabsList>

          {errorMessage ? (
            <div className="rounded-2xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {errorMessage}
            </div>
          ) : null}

          <TabsContent value="general" className="space-y-3 pt-3">
            <div className="rounded-2xl border border-slate-200 bg-white p-3">
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
                        'rounded-2xl border p-3 text-left transition-colors',
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
            <div className="grid grid-cols-[1fr_180px] items-center gap-4 rounded-2xl border border-slate-200 bg-white p-3">
              <span className="text-sm font-semibold">保留时长</span>
              <select
                className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm"
                value={safeSettings.retentionDays}
                onChange={(event) => update('retentionDays', Number(event.target.value))}
              >
                <option value={7}>7 天</option>
                <option value={14}>14 天</option>
                <option value={30}>30 天</option>
                <option value={3650}>永久</option>
              </select>
            </div>
            <div className="grid grid-cols-[1fr_180px] items-center gap-4 rounded-2xl border border-slate-200 bg-white p-3">
              <span className="text-sm font-semibold">最大条目数</span>
              <Input
                type="number"
                min={100}
                max={10000}
                value={safeSettings.maxItems}
                onChange={(event) => update('maxItems', Number(event.target.value))}
              />
            </div>
            <div className="grid grid-cols-[1fr_180px] items-center gap-4 rounded-2xl border border-slate-200 bg-white p-3">
              <span className="text-sm font-semibold">开机自启动</span>
              <div className="flex justify-end">
                <Switch
                  checked={safeSettings.launchOnStartup}
                  onCheckedChange={(checked) => update('launchOnStartup', checked)}
                />
              </div>
            </div>
            <Separator />
            <div className="space-y-2 rounded-2xl border border-orange-100 bg-orange-50/50 p-3">
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

          <TabsContent value="privacy" className="space-y-3 pt-3">
            <div className="grid grid-cols-[1fr_120px] items-center gap-4 rounded-2xl border border-slate-200 bg-white p-3">
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
            <div className="grid grid-cols-[1fr_120px] items-center gap-4 rounded-2xl border border-slate-200 bg-white p-3">
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

            <div className="space-y-3 rounded-2xl border border-slate-200 bg-white p-3">
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

          <TabsContent value="storage" className="space-y-3 pt-3">
            <div className="grid grid-cols-[1fr_180px] items-center gap-4 rounded-2xl border border-slate-200 bg-white p-3">
              <span className="text-sm font-semibold">文本限制（KB）</span>
              <Input
                type="number"
                min={10}
                max={1024}
                value={safeSettings.textLimitKb}
                onChange={(event) => update('textLimitKb', Number(event.target.value))}
              />
            </div>
            <div className="grid grid-cols-[1fr_180px] items-center gap-4 rounded-2xl border border-slate-200 bg-white p-3">
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

          <TabsContent value="hotkeys" className="space-y-3 pt-3 text-sm">
            <div className="rounded-2xl border border-slate-200 bg-white p-3 text-xs leading-5 text-muted-foreground">
              点击右侧快捷键重新录入。按 Esc 可取消录入；检测到冲突时不会保存。
            </div>

            <div className="space-y-3 rounded-2xl border border-slate-200 bg-white p-3">
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
              title="快速粘贴"
              keys={QUICK_PASTE_HOTKEY_KEYS}
              hotkeys={hotkeys}
              editingHotkey={editingHotkey}
              recordingPreview={recordingPreview}
              onRecord={startHotkeyRecording}
            />

            {hotkeyConflicts.length > 0 ? (
              <div className="rounded-2xl border border-red-200 bg-red-50 p-3 text-xs text-red-700">
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

          <TabsContent value="about" className="space-y-3 pt-3 text-sm">
            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <p className="font-black text-slate-950">ClipVault v0.1.0</p>
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
    <div className="space-y-2 rounded-2xl border border-slate-200 bg-white p-3">
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
