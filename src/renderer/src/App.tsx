import { useEffect, useState } from 'react';
import { ClipboardList } from '@/components/ClipboardList';
import { CommandPanelShell } from '@/components/CommandPanelShell';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { SettingsPanel } from '@/components/SettingsPanel';
import { useClipboardData } from '@/hooks/useClipboard';
import { useSearch } from '@/hooks/useSearch';
import { useThemeMode } from '@/hooks/useThemeMode';
import { clipboardApi } from '@/lib/tauriApi';
import { checkForUpdateOnStartup } from '@/lib/updater';

type SettingsTab = 'general' | 'privacy' | 'storage' | 'hotkeys' | 'about';
type FixedContentPrefill = { title: string; content: string; nonce: number };

export default function App(): JSX.Element {
  useClipboardData();
  useSearch();
  useThemeMode();

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general');
  const [fixedContentPrefill, setFixedContentPrefill] = useState<FixedContentPrefill | null>(null);
  const [monitoring, setMonitoring] = useState(true);

  useEffect(() => {
    void checkForUpdateOnStartup();
  }, []);

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
        <ClipboardList
          onAddFixedContent={(prefill) => {
            setFixedContentPrefill((current) => ({
              ...prefill,
              nonce: (current?.nonce ?? 0) + 1
            }));
            setSettingsTab('hotkeys');
            setSettingsOpen(true);
          }}
        />
      </CommandPanelShell>

      <SettingsPanel
        open={settingsOpen}
        initialTab={settingsTab}
        prefillFixedContent={fixedContentPrefill}
        onOpenChange={setSettingsOpen}
      />
    </ErrorBoundary>
  );
}
