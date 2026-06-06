import type { ReactNode } from 'react';
import { Activity, ClipboardList, PauseCircle, PlayCircle, Search, Settings } from 'lucide-react';
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

      <section className="relative z-10 flex min-h-0 flex-1 flex-col px-4 pb-4">
        <div className="command-console no-drag mt-3 flex min-h-0 flex-1 flex-col overflow-hidden rounded-[1.65rem] border border-slate-200/80 bg-white p-3">
          <header className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-4 border-b border-slate-100 pb-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2.5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl border border-teal-100 bg-teal-50 text-teal-800">
                  <ClipboardList className="h-4 w-4" />
                </span>
                <div className="min-w-0">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.26em] text-teal-700">
                    ClipVault
                  </p>
                  <h1 className="truncate text-[19px] font-semibold tracking-tight text-slate-950">
                    剪贴板工作台
                  </h1>
                </div>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] font-medium text-slate-500">
                <span
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full border px-2 py-1',
                    monitoring
                      ? 'border-teal-100 bg-teal-50 text-teal-800'
                      : 'border-orange-100 bg-orange-50 text-orange-700'
                  )}
                >
                  <Activity className="h-3.5 w-3.5" />
                  {monitoring ? '监听中' : '已暂停'}
                </span>
                <span>历史 {items.length}</span>
                <span>收藏 {favoriteCount}</span>
                <span>置顶 {pinnedCount}</span>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-1.5">
              <Button
                variant={monitoring ? 'outline' : 'destructive'}
                size="sm"
                className="h-8 gap-1.5 rounded-full px-3 text-xs"
                onClick={onToggleMonitoring}
              >
                {monitoring ? <PauseCircle className="h-3.5 w-3.5" /> : <PlayCircle className="h-3.5 w-3.5" />}
                {monitoring ? '暂停' : '恢复'}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 rounded-full px-3 text-xs"
                onClick={onOpenSettings}
              >
                <Settings className="h-3.5 w-3.5" />
                设置
              </Button>
            </div>
          </header>

          <div className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto] gap-3 py-3">
            <SearchBar />
            <div className="hidden items-center gap-1 rounded-2xl border border-slate-200 bg-slate-50 px-3 text-[11px] font-medium text-slate-500 md:flex">
              <Search className="h-3.5 w-3.5" />
              Ctrl+F
            </div>
          </div>

          <TypeFilter />

          <main className="mt-3 grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_300px] gap-3">
            <section className="list-surface min-h-0 overflow-hidden rounded-[1.35rem] border border-slate-200 bg-[#f8fbfa] p-1.5">
              {children}
            </section>
            <ClipboardDetail />
          </main>
        </div>
      </section>
    </div>
  );
}
