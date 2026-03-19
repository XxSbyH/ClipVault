import { useEffect, useState } from 'react';
import { ClipboardList } from '@/components/ClipboardList';
import { SearchBar } from '@/components/SearchBar';
import { SettingsPanel } from '@/components/SettingsPanel';
import { TitleBar } from '@/components/TitleBar';
import { TypeFilter } from '@/components/TypeFilter';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { useClipboardData } from '@/hooks/useClipboard';
import { useSearch } from '@/hooks/useSearch';

export default function App(): JSX.Element {
  useClipboardData();
  useSearch();

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'general' | 'hotkeys'>('general');
  const [monitoring, setMonitoring] = useState(true);

  useEffect(() => {
    const offOpenSettings = window.electron.onOpenSettings(() => {
      setSettingsTab('general');
      setSettingsOpen(true);
    });
    const offOpenHotkeys = window.electron.onOpenHotkeys(() => {
      setSettingsTab('hotkeys');
      setSettingsOpen(true);
    });
    return () => {
      offOpenSettings();
      offOpenHotkeys();
    };
  }, []);

  return (
    <div className="app-shell flex h-full flex-col bg-background">
      <div className="flex-shrink-0 border-b border-border bg-card">
        <TitleBar />
      </div>
      <header className="flex-shrink-0 space-y-3 border-b border-border bg-card/70 px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <SearchBar />
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setSettingsTab('general');
              setSettingsOpen(true);
            }}
          >
            设置
          </Button>
          <Button
            variant={monitoring ? 'outline' : 'destructive'}
            size="sm"
            onClick={() => {
              void window.electron.toggleMonitoring().then(setMonitoring);
            }}
          >
            {monitoring ? '暂停' : '恢复'}
          </Button>
        </div>
        <TypeFilter />
      </header>

      <Separator className="opacity-60" />

      <main className="main-content flex-1 overflow-hidden px-3 py-2">
        <ClipboardList />
      </main>

      <SettingsPanel
        open={settingsOpen}
        initialTab={settingsTab}
        onOpenChange={setSettingsOpen}
      />
    </div>
  );
}
