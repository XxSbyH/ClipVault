import type { ReactNode } from 'react';
import { Activity, PauseCircle, PlayCircle, Search, Settings } from 'lucide-react';
import { ClipboardDetail } from '@/components/ClipboardDetail';
import { SearchBar } from '@/components/SearchBar';
import { TitleBar } from '@/components/TitleBar';
import { TypeFilter } from '@/components/TypeFilter';
import { Button } from '@/components/ui/button';
import { useClipboardStore } from '@/store/clipboardStore';
import { cn } from '@/lib/utils';

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
  const favoriteCount = items.filter((item) => item.isFavorite).length;
  const pinnedCount = items.filter((item) => item.isPinned).length;

  return (
    <div className="app-shell relative flex h-full flex-col overflow-hidden bg-background text-foreground">
      <TitleBar />

      <section className="relative z-10 flex min-h-0 flex-1 flex-col px-3 pb-3">
        <div className="command-console no-drag flex min-h-0 flex-1 flex-col overflow-hidden rounded-[1.55rem] border border-slate-200/80 bg-white/95 p-2.5 shadow-sm">
          <header className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-100 pb-2">
            <div className="flex min-w-0 items-center gap-2 text-[11px] font-semibold text-slate-500">
              <span
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1',
                  monitoring
                    ? 'border-teal-100 bg-teal-50 text-teal-800'
                    : 'border-orange-100 bg-orange-50 text-orange-700'
                )}
              >
                <Activity className="h-3.5 w-3.5" />
                {monitoring ? '监听中' : '已暂停'}
              </span>
              <span className="hidden rounded-full bg-slate-50 px-2.5 py-1 sm:inline-flex">历史 {items.length}</span>
              <span className="hidden rounded-full bg-slate-50 px-2.5 py-1 sm:inline-flex">收藏 {favoriteCount}</span>
              <span className="hidden rounded-full bg-slate-50 px-2.5 py-1 md:inline-flex">置顶 {pinnedCount}</span>
            </div>

            <div className="flex shrink-0 items-center gap-1.5">
              <Button
                variant={monitoring ? 'outline' : 'destructive'}
                size="sm"
                className="h-7 gap-1.5 rounded-full px-2.5 text-[11px]"
                onClick={onToggleMonitoring}
              >
                {monitoring ? <PauseCircle className="h-3.5 w-3.5" /> : <PlayCircle className="h-3.5 w-3.5" />}
                {monitoring ? '暂停' : '恢复'}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 rounded-full px-2.5 text-[11px]"
                onClick={onOpenSettings}
              >
                <Settings className="h-3.5 w-3.5" />
                设置
              </Button>
            </div>
          </header>

          <div className="mt-2 grid shrink-0 grid-cols-[minmax(210px,1fr)_minmax(300px,420px)_auto] items-center gap-2 rounded-2xl border border-slate-200 bg-[#f8fbfa] p-1.5">
            <SearchBar />
            <TypeFilter />
            <div className="hidden h-9 items-center gap-1 rounded-xl border border-slate-200 bg-white px-2.5 text-[11px] font-semibold text-slate-500 md:flex">
              <Search className="h-3.5 w-3.5" />
              Ctrl+F
            </div>
          </div>

          <main className="mt-2 grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_300px] gap-2.5">
            <section className="list-surface min-h-0 overflow-hidden rounded-[1.3rem] border border-slate-200 bg-[#f8fbfa] p-1">
              {children}
            </section>
            <ClipboardDetail />
          </main>
        </div>
      </section>
    </div>
  );
}
