import type { ReactNode } from 'react';
import { Activity, Keyboard, PauseCircle, PlayCircle, Settings, Sparkles } from 'lucide-react';
import { ClipboardDetail } from '@/components/ClipboardDetail';
import { SearchBar } from '@/components/SearchBar';
import { TitleBar } from '@/components/TitleBar';
import { TypeFilter } from '@/components/TypeFilter';
import { Button } from '@/components/ui/button';
import { useClipboardStore } from '@/store/clipboardStore';

interface CommandPanelShellProps {
  monitoring: boolean;
  onToggleMonitoring: () => void;
  onOpenSettings: () => void;
  children: ReactNode;
}

export function CommandPanelShell({
  monitoring,
  onToggleMonitoring,
  onOpenSettings,
  children
}: CommandPanelShellProps): JSX.Element {
  const items = useClipboardStore((state) => state.items);
  const selectedType = useClipboardStore((state) => state.selectedType);
  const selectedItemId = useClipboardStore((state) => state.selectedItemId);
  const selectedItem = items.find((item) => item.id === selectedItemId);
  const favoriteCount = items.filter((item) => item.isFavorite).length;
  const pinnedCount = items.filter((item) => item.isPinned).length;

  return (
    <div className="app-shell relative flex h-full flex-col overflow-hidden bg-background text-foreground">
      <div className="panel-ambient panel-ambient-a" />
      <div className="panel-ambient panel-ambient-b" />

      <TitleBar />

      <section className="relative z-10 flex min-h-0 flex-1 flex-col px-3 pb-3">
        <header className="command-header no-drag mt-3 rounded-[1.35rem] border border-white/70 bg-white/80 p-3 shadow-[0_22px_60px_rgba(15,118,110,0.13)] backdrop-blur-xl">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-teal-700 text-white shadow-sm">
                  <Sparkles className="h-4 w-4" />
                </span>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-teal-700">ClipVault</p>
                  <h1 className="text-lg font-black tracking-[-0.03em] text-slate-950">剪贴板指挥面板</h1>
                </div>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              <Button
                variant={monitoring ? 'outline' : 'destructive'}
                size="sm"
                className="gap-1.5 rounded-full"
                onClick={onToggleMonitoring}
              >
                {monitoring ? <PauseCircle className="h-3.5 w-3.5" /> : <PlayCircle className="h-3.5 w-3.5" />}
                {monitoring ? '暂停' : '恢复'}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 rounded-full"
                onClick={onOpenSettings}
              >
                <Settings className="h-3.5 w-3.5" />
                设置
              </Button>
            </div>
          </div>

          <SearchBar />
          <div className="mt-3">
            <TypeFilter />
          </div>
        </header>

        <main className="no-drag mt-3 grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_auto] gap-3">
          <section className="list-surface min-h-0 overflow-hidden rounded-[1.35rem] border border-white/70 bg-white/72 p-2 shadow-[0_18px_50px_rgba(15,118,110,0.10)] backdrop-blur-xl">
            {children}
          </section>
          <ClipboardDetail />
        </main>

        <footer className="no-drag mt-3 flex items-center justify-between gap-3 rounded-2xl border border-teal-100/80 bg-white/62 px-3 py-2 text-[11px] text-muted-foreground shadow-sm backdrop-blur-xl">
          <div className="flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-teal-100 text-teal-700">
              <Activity className="h-3.5 w-3.5" />
            </span>
            <span>{monitoring ? '正在监听剪贴板' : '监听已暂停'}</span>
            <span className="hidden sm:inline">共 {items.length} 条</span>
            <span className="hidden sm:inline">收藏 {favoriteCount}</span>
            <span className="hidden sm:inline">置顶 {pinnedCount}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Keyboard className="h-3.5 w-3.5" />
            <span>Enter 粘贴</span>
            <span className="hidden sm:inline">Delete 删除</span>
            <span className="hidden sm:inline">{selectedItem ? `当前: ${selectedItem.preview.slice(0, 16)}` : selectedType}</span>
          </div>
        </footer>
      </section>
    </div>
  );
}
