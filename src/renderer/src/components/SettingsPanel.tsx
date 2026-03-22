import { useEffect, useMemo, useRef, useState } from 'react';
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
import { useClipboardStore } from '@/store/clipboardStore';

interface SettingsPanelProps {
  open: boolean;
  initialTab?: 'general' | 'hotkeys';
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
  clear: '清空历史（保留收藏项）',
  quickPastePrev: '无需打开面板，直接粘贴更早的内容',
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
const DISPLAY_TOKEN_MAP: Record<string, string> = {
  CommandOrControl: 'Ctrl',
  Command: 'Cmd',
  Meta: 'Win',
  Super: 'Win',
  Left: '←',
  Right: '→',
  Up: '↑',
  Down: '↓'
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

async function saveSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): Promise<AppSettings> {
  return window.electron.updateSetting(key, value);
}

export function SettingsPanel({ open, initialTab = 'general', onOpenChange }: SettingsPanelProps): JSX.Element {
  const settings = useClipboardStore((state) => state.settings);
  const setSettings = useClipboardStore((state) => state.setSettings);
  const setItems = useClipboardStore((state) => state.setItems);
  const itemsCount = useClipboardStore((state) => state.items.length);

  const [blacklist, setBlacklist] = useState<BlacklistApp[]>([]);
  const [newAppName, setNewAppName] = useState('');
  const [activeTab, setActiveTab] = useState('general');
  const [showBlacklistHelp, setShowBlacklistHelp] = useState(false);
  const [hotkeys, setHotkeys] = useState<HotkeySettings | null>(null);
  const [editingHotkey, setEditingHotkey] = useState<keyof HotkeySettings | null>(null);
  const [hotkeyConflicts, setHotkeyConflicts] = useState<string[]>([]);
  const [recordingPreview, setRecordingPreview] = useState('');
  const [clearState, setClearState] = useState<'idle' | 'clearing' | 'success' | 'error'>('idle');
  const [clearMessage, setClearMessage] = useState('');
  const pressedKeysRef = useRef<Set<string>>(new Set());
  const candidateComboRef = useRef<string>('');
  const clearFeedbackTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!open) {
      setEditingHotkey(null);
      setRecordingPreview('');
      pressedKeysRef.current.clear();
      candidateComboRef.current = '';
      setClearState('idle');
      setClearMessage('');
      return;
    }
    setActiveTab(initialTab);
    void window.electron.getSettings().then(setSettings);
    void window.electron.listBlacklist().then(setBlacklist);
    void window.electron.getHotkeys().then(setHotkeys);
  }, [open, initialTab, setSettings]);

  useEffect(() => {
    return () => {
      if (clearFeedbackTimerRef.current) {
        window.clearTimeout(clearFeedbackTimerRef.current);
        clearFeedbackTimerRef.current = null;
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
        launchOnStartup: false,
        wheelShortcutEnabled: true,
        wheelShortcutModifier: 'ctrl',
        wheelShortcutScope: 'global'
      },
    [settings]
  );

  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    void saveSetting(key, value).then(setSettings);
  };

  const handleClearHistory = async () => {
    const accepted = confirm('确认清空非收藏历史吗？');
    if (!accepted) {
      return;
    }

    if (clearFeedbackTimerRef.current) {
      window.clearTimeout(clearFeedbackTimerRef.current);
      clearFeedbackTimerRef.current = null;
    }

    setClearState('clearing');
    setClearMessage('正在清理历史，请稍候...');

    try {
      const result = await window.electron.clearHistory();
      if (!result.success) {
        throw new Error(result.error || 'clear-history-failed');
      }
      const latestItems = await window.electron.getHistory(300);
      setItems(latestItems);
      const removedCount = Math.max(0, result.deleted ?? 0);
      setClearState('success');
      setClearMessage(
        removedCount > 0
          ? `清理完成，已清除 ${removedCount} 条非收藏记录`
          : '清理完成，当前没有可清理的非收藏记录'
      );
    } catch {
      setClearState('error');
      setClearMessage('清理失败，请重试');
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
    void window.electron.addBlacklist(appName).then((item) => {
      setBlacklist((prev) => [...prev, item]);
      setNewAppName('');
    });
  };

  const removeBlacklist = (id: number) => {
    void window.electron.removeBlacklist(id).then(() => {
      setBlacklist((prev) => prev.filter((item) => item.id !== id));
    });
  };

  const resetHotkeys = () => {
    setEditingHotkey(null);
    setRecordingPreview('');
    pressedKeysRef.current.clear();
    candidateComboRef.current = '';
    setHotkeyConflicts([]);
    void window.electron.updateHotkeys(DEFAULT_HOTKEYS).then(setHotkeys);
  };

  const cancelHotkeyRecording = () => {
    setEditingHotkey(null);
    setRecordingPreview('');
    pressedKeysRef.current.clear();
    candidateComboRef.current = '';
  };

  const startHotkeyRecording = (key: keyof HotkeySettings) => {
    setHotkeyConflicts([]);
    setEditingHotkey(key);
    setRecordingPreview('');
    pressedKeysRef.current.clear();
    candidateComboRef.current = '';
  };

  useEffect(() => {
    if (!editingHotkey || !hotkeys) {
      return;
    }

    const updatePreviewFromPressed = () => {
      const ordered = orderHotkeyTokens(Array.from(pressedKeysRef.current));
      const preview = ordered.join('+');
      setRecordingPreview(preview);
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

        void window.electron.checkHotkeyConflicts(next).then((conflicts) => {
          setHotkeyConflicts(conflicts);
          if (conflicts.length > 0) {
            return;
          }
          void window.electron.checkHotkeyAvailable(combo).then((available) => {
            if (!available) {
              const accepted = confirm(`快捷键 ${formatHotkeyLabel(combo)} 可能被其他应用占用，仍然保存吗？`);
              if (!accepted) {
                setHotkeyConflicts([`快捷键可能被其他应用占用: ${formatHotkeyLabel(combo)}`]);
                return;
              }
            }
            void window.electron.updateHotkeys({ [editingKey]: combo }).then(setHotkeys);
          });
        });
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
  }, [editingHotkey, hotkeys]);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
    >
      <DialogContent className="max-h-[90vh] overflow-auto">
        <DialogHeader className="flex flex-row items-start justify-between gap-2">
          <div className="space-y-1">
            <DialogTitle>设置</DialogTitle>
            <DialogDescription>管理保留策略、隐私和存储行为</DialogDescription>
          </div>
          <DialogClose />
        </DialogHeader>

        <Tabs
          value={activeTab}
          onValueChange={setActiveTab}
        >
          <TabsList className="grid w-full grid-cols-5">
            <TabsTrigger value="general">常规</TabsTrigger>
            <TabsTrigger value="privacy">隐私</TabsTrigger>
            <TabsTrigger value="storage">存储</TabsTrigger>
            <TabsTrigger value="hotkeys">快捷键</TabsTrigger>
            <TabsTrigger value="about">关于</TabsTrigger>
          </TabsList>

          <TabsContent value="general" className="space-y-4">
            <div className="grid grid-cols-[1fr_160px] items-center gap-4 py-1">
              <span className="text-sm font-medium">保留天数</span>
              <div className="flex w-40 justify-end">
                <select
                  className="h-9 w-40 rounded-md border border-input bg-background px-3 text-sm"
                  value={safeSettings.retentionDays}
                  onChange={(event) => update('retentionDays', Number(event.target.value))}
                >
                  <option value={7}>7 天</option>
                  <option value={14}>14 天</option>
                  <option value={30}>30 天</option>
                  <option value={3650}>永久</option>
                </select>
              </div>
            </div>
            <div className="grid grid-cols-[1fr_160px] items-center gap-4 py-1">
              <span className="text-sm font-medium">最大条目数</span>
              <div className="flex w-40 justify-end">
                <Input
                  type="number"
                  min={100}
                  max={10000}
                  value={safeSettings.maxItems}
                  onChange={(event) => update('maxItems', Number(event.target.value))}
                  className="w-40"
                />
              </div>
            </div>
            <div className="grid grid-cols-[1fr_160px] items-center gap-4 py-1">
              <span className="text-sm font-medium">开机自启动</span>
              <div className="flex w-40 justify-end">
                <Switch
                  checked={safeSettings.launchOnStartup}
                  onCheckedChange={(checked) => update('launchOnStartup', checked)}
                />
              </div>
            </div>
            <Separator />
            <Button
              variant="destructive"
              disabled={clearState === 'clearing'}
              onClick={() => {
                void handleClearHistory();
              }}
            >
              {clearState === 'clearing' ? '清理中...' : '清空历史（保留收藏）'}
            </Button>
            {clearState === 'clearing' ? (
              <div className="space-y-2 rounded-md border border-border bg-muted/40 px-3 py-2">
                <p className="text-xs text-muted-foreground">{clearMessage}</p>
                <div className="h-1.5 w-full overflow-hidden rounded bg-muted">
                  <div className="h-full w-1/3 animate-pulse rounded bg-primary" />
                </div>
              </div>
            ) : null}
            {clearState === 'success' ? (
              <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
                {clearMessage}
              </div>
            ) : null}
            {clearState === 'error' ? (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                {clearMessage}
              </div>
            ) : null}
          </TabsContent>

          <TabsContent value="privacy" className="space-y-4">
            <div className="grid grid-cols-[1fr_160px] items-center gap-4 border-b border-border py-3">
              <div className="min-w-0 pr-4">
                <p className="text-sm font-medium">启用敏感内容过滤</p>
                <p className="mt-1 text-xs text-muted-foreground">自动跳过密码、卡号等敏感内容</p>
              </div>
              <div className="flex w-40 justify-end">
                <Switch
                  checked={safeSettings.enableSensitiveFilter}
                  onCheckedChange={(checked) => update('enableSensitiveFilter', checked)}
                />
              </div>
            </div>
            <div className="grid grid-cols-[1fr_160px] items-center gap-4 border-b border-border py-3">
              <div className="min-w-0 pr-4">
                <p className="text-sm font-medium">启用应用黑名单</p>
                <p className="mt-1 text-xs text-muted-foreground">黑名单应用中的复制内容不会记录</p>
              </div>
              <div className="flex w-40 justify-end">
                <Switch
                  checked={safeSettings.enableBlacklist}
                  onCheckedChange={(checked) => update('enableBlacklist', checked)}
                />
              </div>
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">黑名单应用</p>
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => setShowBlacklistHelp((prev) => !prev)}
                >
                  {showBlacklistHelp ? '收起' : '使用说明'}
                </button>
              </div>
              {showBlacklistHelp ? (
                <div className="rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
                  <p className="font-medium text-foreground">添加示例</p>
                  <p className="mt-1">`chrome.exe`、`1Password`、`网上银行`</p>
                  <p className="mt-2 text-amber-600">提示：可在任务管理器查看进程名</p>
                </div>
              ) : null}
              <div className="flex items-center gap-2">
                <Input
                  value={newAppName}
                  onChange={(event) => setNewAppName(event.target.value)}
                  placeholder="例如：chrome.exe 或 1Password"
                />
                <Button
                  onClick={addBlacklist}
                  disabled={!newAppName.trim()}
                  className="h-10 w-20 shrink-0 whitespace-nowrap px-0"
                >
                  添加
                </Button>
              </div>
              <div className="max-h-40 space-y-2 overflow-auto pr-1">
                {blacklist.map((app) => (
                  <div
                    key={app.id}
                    className="flex items-center justify-between rounded border border-border px-3 py-2 text-sm"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      {app.isBuiltin ? <Badge>内置</Badge> : <Badge className="bg-primary/10 text-primary">自定义</Badge>}
                      <span className="truncate">{app.appName}</span>
                    </div>
                    {!app.isBuiltin ? (
                      <Button
                        variant="ghost"
                        size="sm"
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

          <TabsContent value="storage" className="space-y-4">
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm">文本限制（KB）</span>
              <Input
                type="number"
                min={10}
                max={1024}
                value={safeSettings.textLimitKb}
                onChange={(event) => update('textLimitKb', Number(event.target.value))}
                className="w-40"
              />
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm">图片压缩</span>
              <select
                className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                value={safeSettings.imageCompression}
                onChange={(event) => update('imageCompression', event.target.value as AppSettings['imageCompression'])}
              >
                <option value="original">原图</option>
                <option value="high">高质量</option>
                <option value="medium">中质量</option>
              </select>
            </div>
          </TabsContent>

          <TabsContent value="hotkeys" className="space-y-3 text-sm">
            <div className="space-y-1 rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
              <p>点击右侧快捷键可重新录入，按下新组合后自动保存。</p>
              <p>按 `Esc` 可取消录入，若检测到冲突将不会保存。</p>
            </div>

            <div className="space-y-3 rounded-lg border border-border/70 bg-muted/20 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <p className="text-sm font-medium">鼠标滚轮快捷键</p>
                  <p className="text-xs text-muted-foreground">按住修饰键并滚轮浏览历史：向上=更旧，向下=更新</p>
                </div>
                <Switch
                  checked={safeSettings.wheelShortcutEnabled}
                  onCheckedChange={(checked) => update('wheelShortcutEnabled', checked)}
                />
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1 text-xs text-muted-foreground">
                  <span>修饰键</span>
                  <select
                    className="h-9 w-full rounded-md border border-input bg-background px-2.5 text-sm text-foreground"
                    value={safeSettings.wheelShortcutModifier}
                    onChange={(event) =>
                      update('wheelShortcutModifier', event.target.value as AppSettings['wheelShortcutModifier'])
                    }
                    disabled={!safeSettings.wheelShortcutEnabled}
                  >
                    {WHEEL_MODIFIER_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="space-y-1 text-xs text-muted-foreground">
                  <span>生效范围</span>
                  <select
                    className="h-9 w-full rounded-md border border-input bg-background px-2.5 text-sm text-foreground"
                    value={safeSettings.wheelShortcutScope}
                    onChange={(event) =>
                      update('wheelShortcutScope', event.target.value as AppSettings['wheelShortcutScope'])
                    }
                    disabled={!safeSettings.wheelShortcutEnabled}
                  >
                    {WHEEL_SCOPE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              {safeSettings.wheelShortcutEnabled ? (
                <div className="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-2 text-xs text-amber-700">
                  提示：在浏览器中，{WHEEL_MODIFIER_OPTIONS.find((item) => item.value === safeSettings.wheelShortcutModifier)?.label}
                  +滚轮可能影响页面缩放，可改为其他修饰键或切到“仅面板打开时”。
                </div>
              ) : null}
            </div>

            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">常规快捷键</p>
              {NORMAL_HOTKEY_KEYS.map((key) => {
                const value = hotkeys?.[key] ?? DEFAULT_HOTKEYS[key];
                return (
                  <div
                    key={key}
                    className="flex items-center justify-between gap-3 border-b border-border py-2"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{HOTKEY_LABELS[key]}</p>
                      <p className="text-xs text-muted-foreground">{HOTKEY_DESCRIPTIONS[key]}</p>
                    </div>
                    <button
                      type="button"
                      className="rounded-md border border-border px-3 py-1 font-mono text-xs hover:border-primary/40"
                      onClick={() => startHotkeyRecording(key)}
                    >
                      {editingHotkey === key ? (
                        <span className="inline-flex items-center gap-1.5">
                          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
                          <span>{recordingPreview ? formatHotkeyLabel(recordingPreview) : '请按组合键...'}</span>
                        </span>
                      ) : formatHotkeyLabel(value)}
                    </button>
                  </div>
                );
              })}
            </div>

            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">快速粘贴</p>
              {QUICK_PASTE_HOTKEY_KEYS.map((key) => {
                const value = hotkeys?.[key] ?? DEFAULT_HOTKEYS[key];
                return (
                  <div
                    key={key}
                    className="flex items-center justify-between gap-3 border-b border-border py-2"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{HOTKEY_LABELS[key]}</p>
                      <p className="text-xs text-muted-foreground">{HOTKEY_DESCRIPTIONS[key]}</p>
                    </div>
                    <button
                      type="button"
                      className="rounded-md border border-border px-3 py-1 font-mono text-xs hover:border-primary/40"
                      onClick={() => startHotkeyRecording(key)}
                    >
                      {editingHotkey === key ? (
                        <span className="inline-flex items-center gap-1.5">
                          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
                          <span>{recordingPreview ? formatHotkeyLabel(recordingPreview) : '请按组合键...'}</span>
                        </span>
                      ) : formatHotkeyLabel(value)}
                    </button>
                  </div>
                );
              })}
            </div>

            {hotkeyConflicts.length > 0 ? (
              <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-xs text-red-600">
                {hotkeyConflicts.map((item) => (
                  <p key={item}>• {item}</p>
                ))}
              </div>
            ) : null}

            <div className="flex justify-end">
              <Button
                variant="ghost"
                size="sm"
                onClick={resetHotkeys}
              >
                恢复默认设置
              </Button>
            </div>
          </TabsContent>

          <TabsContent value="about" className="space-y-2 text-sm">
            <p>ClipVault v0.1.0</p>
            <p>当前缓存条目: {itemsCount}</p>
            <p>数据默认保存在本地 `userData/clipboard.db`</p>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
