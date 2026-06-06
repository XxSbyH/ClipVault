import { useEffect } from 'react';
import type { AppSettings } from '@shared/types';
import { useClipboardStore } from '@/store/clipboardStore';

const SYSTEM_DARK_QUERY = '(prefers-color-scheme: dark)';

function resolveIsDark(themeMode: AppSettings['themeMode'], media: MediaQueryList): boolean {
  return themeMode === 'dark' || (themeMode === 'system' && media.matches);
}

export function useThemeMode(): void {
  const themeMode = useClipboardStore((state) => state.settings?.themeMode ?? 'system');

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') {
      const root = document.documentElement;
      const isDark = themeMode === 'dark';
      root.classList.toggle('dark', isDark);
      root.dataset.theme = isDark ? 'dark' : 'light';
      root.dataset.themeMode = themeMode;
      return;
    }

    const media = window.matchMedia(SYSTEM_DARK_QUERY);
    const root = document.documentElement;
    const applyTheme = () => {
      const isDark = resolveIsDark(themeMode, media);
      root.classList.toggle('dark', isDark);
      root.dataset.theme = isDark ? 'dark' : 'light';
      root.dataset.themeMode = themeMode;
    };

    applyTheme();

    if (themeMode !== 'system') {
      return;
    }

    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', applyTheme);
      return () => media.removeEventListener('change', applyTheme);
    }

    media.addListener(applyTheme);
    return () => media.removeListener(applyTheme);
  }, [themeMode]);
}
