import { useEffect } from 'react';
import { clipboardApi } from '@/lib/tauriApi';
import { getHistoryFetchLimit } from '@/lib/historyLimit';
import { parseRegexQuery } from '@/lib/search';
import { useClipboardStore } from '@/store/clipboardStore';

export function useSearch(): void {
  const query = useClipboardStore((state) => state.searchQuery);
  const setItems = useClipboardStore((state) => state.setItems);
  const settings = useClipboardStore((state) => state.settings);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (query.trim()) {
        const request = parseRegexQuery(query)
          ? clipboardApi.getHistory(getHistoryFetchLimit(settings))
          : clipboardApi.searchItems(query);
        void request.then(setItems);
      } else {
        void clipboardApi.getHistory(getHistoryFetchLimit(settings)).then(setItems);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [query, setItems, settings]);
}
