import { useEffect, useState } from 'react';
import { ClipboardList } from '@/components/ClipboardList';
import { CommandPanelShell } from '@/components/CommandPanelShell';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { SettingsPanel } from '@/components/SettingsPanel';
import { useClipboardData } from '@/hooks/useClipboard';
import { useSearch } from '@/hooks/useSearch';
import { clipboardApi } from '@/lib/tauriApi';

type SettingsTab = 'general' | 'privacy' | 'storage' | 'hotkeys' | 'about';

export default function App(): JSX.Element {
  useClipboardData();
  useSearch();

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general');
  const [monitoring, setMonitoring] = useState(true);

  useEffect(() => {
    const offOpenSettings = clipboardApi.onOpenSettings(() => {
      setSettingsTab('general');
      setSettingsOpen(true);
    });
    const offOpenHotkeys = clipboardApi.onOpenHotkeys(() => {
      setSettingsTab('hotkeys');
      setSettingsOpen(true);
    });
    return () => {
      offOpenSettings();
      offOpenHotkeys();
    };
  }, []);

  return (
    <ErrorBoundary>
      <CommandPanelShell
        monitoring={monitoring}
        onToggleMonitoring={() => {
          void clipboardApi.toggleMonitoring().then(setMonitoring);
        }}
        onOpenSettings={() => {
          setSettingsTab('general');
          setSettingsOpen(true);
        }}
      >
        <ClipboardList />
      </CommandPanelShell>

      <SettingsPanel
        open={settingsOpen}
        initialTab={settingsTab}
        onOpenChange={setSettingsOpen}
      />
    </ErrorBoundary>
  );
}
