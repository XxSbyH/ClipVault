import React from 'react';
import ReactDOM from 'react-dom/client';
import { useEffect } from 'react';
import type { AppSettings } from '@shared/types';
import { QuickSearchOverlay } from '@/components/QuickSearchOverlay';
import { useThemeMode } from '@/hooks/useThemeMode';
import { clipboardApi } from '@/lib/tauriApi';
import { useClipboardStore } from '@/store/clipboardStore';
import '@/styles.css';

document.body.classList.add('quick-search-window');

function SearchApp(): JSX.Element {
  const setSettings = useClipboardStore((state) => state.setSettings);
  useThemeMode();

  useEffect(() => {
    void clipboardApi.getSettings().then((settings: AppSettings) => {
      setSettings(settings);
    });
  }, [setSettings]);

  return <QuickSearchOverlay />;
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <SearchApp />
  </React.StrictMode>
);
