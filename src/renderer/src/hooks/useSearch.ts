import { useEffect } from 'react';
import { clipboardApi } from '@/lib/tauriApi';
import { parseRegexQuery } from '@/lib/search';
import { useClipboardStore } from '@/store/clipboardStore';

export function useSearch(): void {
  const query = useClipboardStore((state) => state.searchQuery);
  const setItems = useClipboardStore((state) => state.setItems);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (query.trim()) {
        const request = parseRegexQuery(query)
          ? clipboardApi.getHistory(300)
          : clipboardApi.searchItems(query);
        void request.then(setItems);
      } else {
        void clipboardApi.getHistory(300).then(setItems);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [query, setItems]);
}
