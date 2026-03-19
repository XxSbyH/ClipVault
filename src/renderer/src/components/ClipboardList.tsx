import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FixedSizeList as List, type ListChildComponentProps } from 'react-window';
import type { ClipboardItem as ClipboardItemType } from '@shared/types';
import { ClipboardItem } from '@/components/ClipboardItem';
import { EmptyState } from '@/components/EmptyState';
import { useClipboardStore } from '@/store/clipboardStore';

const ITEM_HEIGHT = 110;

interface RowData {
  items: ClipboardItemType[];
  selectedId: number | null;
  onPaste: (id: number) => void;
  onTogglePin: (id: number) => void;
  onToggleFavorite: (id: number) => void;
  onDelete: (id: number) => void;
  onSelect: (id: number) => void;
}

function filterItems(items: ClipboardItemType[], type: ReturnType<typeof useClipboardStore.getState>['selectedType']) {
  if (type === 'all') {
    return items;
  }
  if (type === 'favorite') {
    return items.filter((item) => item.isFavorite);
  }
  return items.filter((item) => item.contentType === type);
}

function Row({ index, style, data }: ListChildComponentProps<RowData>): JSX.Element {
  const item = data.items[index];
  return (
    <div style={style} className="px-1 py-[3px]">
      <ClipboardItem
        item={item}
        selected={data.selectedId === item.id}
        onPaste={data.onPaste}
        onTogglePin={data.onTogglePin}
        onToggleFavorite={data.onToggleFavorite}
        onDelete={data.onDelete}
        onSelect={data.onSelect}
      />
    </div>
  );
}

export function ClipboardList(): JSX.Element {
  const items = useClipboardStore((state) => state.items);
  const selectedType = useClipboardStore((state) => state.selectedType);
  const selectedItemId = useClipboardStore((state) => state.selectedItemId);
  const setSelectedItemId = useClipboardStore((state) => state.setSelectedItemId);
  const setItems = useClipboardStore((state) => state.setItems);
  const upsertItem = useClipboardStore((state) => state.upsertItem);
  const removeItem = useClipboardStore((state) => state.removeItem);
  const [height, setHeight] = useState(480);
  const listRef = useRef<List<RowData>>(null);

  const filteredItems = useMemo(() => filterItems(items, selectedType), [items, selectedType]);

  const selectedIndex = useMemo(
    () => filteredItems.findIndex((item) => item.id === selectedItemId),
    [filteredItems, selectedItemId]
  );

  useEffect(() => {
    const resize = () => {
      setHeight(Math.max(280, window.innerHeight - 215));
    };
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  const refreshHistory = useCallback(() => {
    void window.electron.getHistory(300).then(setItems);
  }, [setItems]);

  const onPaste = useCallback((id: number) => {
    void window.electron.pasteItem(id);
  }, []);

  const onTogglePin = useCallback(
    (id: number) => {
      void window.electron.togglePin(id).then((item) => {
        if (item) {
          upsertItem(item);
        } else {
          refreshHistory();
        }
      });
    },
    [refreshHistory, upsertItem]
  );

  const onToggleFavorite = useCallback(
    (id: number) => {
      void window.electron.toggleFavorite(id).then((item) => {
        if (item) {
          upsertItem(item);
        } else {
          refreshHistory();
        }
      });
    },
    [refreshHistory, upsertItem]
  );

  const onDelete = useCallback(
    (id: number) => {
      void window.electron.deleteItem(id).then((result) => {
        if (result.success) {
          removeItem(id);
        }
      });
    },
    [removeItem]
  );

  const onSelect = useCallback(
    (id: number) => {
      setSelectedItemId(id);
    },
    [setSelectedItemId]
  );

  useEffect(() => {
    if (filteredItems.length === 0) {
      setSelectedItemId(null);
      return;
    }
    if (!selectedItemId || !filteredItems.some((item) => item.id === selectedItemId)) {
      setSelectedItemId(filteredItems[0].id);
    }
  }, [filteredItems, selectedItemId, setSelectedItemId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        return;
      }
      if (event.key === 'Escape') {
        window.close();
        return;
      }
      if (filteredItems.length === 0) {
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        const next = selectedIndex < 0 ? 0 : Math.min(selectedIndex + 1, filteredItems.length - 1);
        const nextId = filteredItems[next]?.id;
        if (nextId) {
          setSelectedItemId(nextId);
          listRef.current?.scrollToItem(next, 'smart');
        }
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        const next = selectedIndex <= 0 ? 0 : selectedIndex - 1;
        const nextId = filteredItems[next]?.id;
        if (nextId) {
          setSelectedItemId(nextId);
          listRef.current?.scrollToItem(next, 'smart');
        }
      }
      if (event.key === 'Enter' && selectedItemId) {
        event.preventDefault();
        onPaste(selectedItemId);
      }
      if (event.key === 'Delete' && selectedItemId) {
        event.preventDefault();
        onDelete(selectedItemId);
      }
      if (event.ctrlKey && event.key.toLowerCase() === 'd' && selectedItemId) {
        event.preventDefault();
        onToggleFavorite(selectedItemId);
      }
      if (event.ctrlKey && event.key.toLowerCase() === 'p' && selectedItemId) {
        event.preventDefault();
        onTogglePin(selectedItemId);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [filteredItems, onDelete, onPaste, onToggleFavorite, onTogglePin, selectedIndex, selectedItemId, setSelectedItemId]);

  if (filteredItems.length === 0) {
    return <EmptyState />;
  }

  return (
    <List
      ref={listRef}
      width="100%"
      height={height}
      itemCount={filteredItems.length}
      itemSize={ITEM_HEIGHT}
      itemData={{
        items: filteredItems,
        selectedId: selectedItemId,
        onPaste,
        onTogglePin,
        onToggleFavorite,
        onDelete,
        onSelect
      }}
    >
      {Row}
    </List>
  );
}
