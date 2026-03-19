import { useEffect } from 'react';
import { useClipboardStore } from '@/store/clipboardStore';

export function useSearch(): void {
  const query = useClipboardStore((state) => state.searchQuery);
  const setItems = useClipboardStore((state) => state.setItems);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (query.trim()) {
        void window.electron.searchItems(query).then(setItems);
      } else {
        void window.electron.getHistory(300).then(setItems);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [query, setItems]);
}
