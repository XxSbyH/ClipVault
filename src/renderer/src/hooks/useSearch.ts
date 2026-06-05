import { useEffect } from 'react';
import { clipboardApi } from '@/lib/tauriApi';
import { useClipboardStore } from '@/store/clipboardStore';

export function useSearch(): void {
  const query = useClipboardStore((state) => state.searchQuery);
  const setItems = useClipboardStore((state) => state.setItems);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (query.trim()) {
        void clipboardApi.searchItems(query).then(setItems);
      } else {
        void clipboardApi.getHistory(300).then(setItems);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [query, setItems]);
}
