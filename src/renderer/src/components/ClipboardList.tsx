import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FixedSizeList as List, type ListChildComponentProps } from 'react-window';
import type { ClipboardItem as ClipboardItemType } from '@shared/types';
import { ClipboardItem } from '@/components/ClipboardItem';
import { EmptyState } from '@/components/EmptyState';
import { clipboardApi } from '@/lib/tauriApi';
import { useClipboardStore } from '@/store/clipboardStore';

const ITEM_HEIGHT = 78;

interface RowData {
  items: ClipboardItemType[];
  selectedId: number | null;
  onCopy: (id: number) => void;
  onTogglePin: (id: number) => void;
  onToggleFavorite: (id: number) => void;
  onDelete: (id: number) => void;
  onSelect: (id: number) => void;
}

function itemMatchesQuery(item: ClipboardItemType, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return true;
  }
  return [item.preview, item.content, item.filePath, item.metadata.fileName]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .some((value) => value.toLowerCase().includes(needle));
}

function filterItems(
  items: ClipboardItemType[],
  type: ReturnType<typeof useClipboardStore.getState>['selectedType'],
  query: string
) {
  const searchedItems = query.trim() ? items.filter((item) => itemMatchesQuery(item, query)) : items;
  if (query.trim()) {
    return searchedItems;
  }
  if (type === 'all') {
    return searchedItems;
  }
  if (type === 'favorite') {
    return searchedItems.filter((item) => item.isFavorite);
  }
  return searchedItems.filter((item) => item.contentType === type);
}

function Row({ index, style, data }: ListChildComponentProps<RowData>): JSX.Element {
  const item = data.items[index];
  return (
    <div
      style={style}
      className="px-1 py-[5px]"
    >
      <ClipboardItem
        item={item}
        selected={data.selectedId === item.id}
        onCopy={data.onCopy}
        onTogglePin={data.onTogglePin}
        onToggleFavorite={data.onToggleFavorite}
        onDelete={data.onDelete}
        onSelect={data.onSelect}
      />
    </div>
  );
}

function shouldIgnoreGlobalShortcut(event: KeyboardEvent): boolean {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tagName = target.tagName.toLowerCase();
  if (['input', 'textarea', 'select', 'button'].includes(tagName)) {
    return true;
  }
  if (target.isContentEditable) {
    return true;
  }
  return Boolean(target.closest('[role="dialog"]'));
}

export function ClipboardList(): JSX.Element {
  const items = useClipboardStore((state) => state.items);
  const searchQuery = useClipboardStore((state) => state.searchQuery);
  const selectedType = useClipboardStore((state) => state.selectedType);
  const selectedItemId = useClipboardStore((state) => state.selectedItemId);
  const setSelectedItemId = useClipboardStore((state) => state.setSelectedItemId);
  const setItems = useClipboardStore((state) => state.setItems);
  const upsertItem = useClipboardStore((state) => state.upsertItem);
  const removeItem = useClipboardStore((state) => state.removeItem);
  const [height, setHeight] = useState(360);
  const listRef = useRef<List<RowData>>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const copyQueueRef = useRef<Promise<void>>(Promise.resolve());
  const copyRequestSeqRef = useRef(0);

  const filteredItems = useMemo(() => filterItems(items, selectedType, searchQuery), [items, searchQuery, selectedType]);

  const selectedIndex = useMemo(
    () => filteredItems.findIndex((item) => item.id === selectedItemId),
    [filteredItems, selectedItemId]
  );

  useEffect(() => {
    const measure = () => {
      const measured = containerRef.current?.clientHeight ?? 0;
      setHeight(Math.max(260, measured || window.innerHeight - 300));
    };
    measure();
    const resizeObserver =
      typeof ResizeObserver !== 'undefined' && containerRef.current
        ? new ResizeObserver(measure)
        : null;
    if (containerRef.current && resizeObserver) {
      resizeObserver.observe(containerRef.current);
    }
    window.addEventListener('resize', measure);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  const refreshHistory = useCallback(() => {
    void clipboardApi.getHistory(300).then(setItems);
  }, [setItems]);

  const onCopy = useCallback(
    (id: number) => {
      const seq = copyRequestSeqRef.current + 1;
      copyRequestSeqRef.current = seq;
      setSelectedItemId(id);
      copyQueueRef.current = copyQueueRef.current.catch(() => undefined).then(async () => {
        if (seq !== copyRequestSeqRef.current) {
          return;
        }
        const result = await clipboardApi.copyItem(id);
        if (result.success && result.item) {
          upsertItem(result.item);
          if (seq === copyRequestSeqRef.current) {
            setSelectedItemId(result.item.id);
          }
        }
      });
    },
    [setSelectedItemId, upsertItem]
  );

  const onTogglePin = useCallback(
    (id: number) => {
      void clipboardApi.togglePin(id).then((item) => {
        if (item) {
          const stillExists = useClipboardStore.getState().items.some((current) => current.id === id);
          if (stillExists) {
            upsertItem(item);
          }
        } else {
          refreshHistory();
        }
      });
    },
    [refreshHistory, upsertItem]
  );

  const onToggleFavorite = useCallback(
    (id: number) => {
      void clipboardApi.toggleFavorite(id).then((item) => {
        if (item) {
          const stillExists = useClipboardStore.getState().items.some((current) => current.id === id);
          if (stillExists) {
            upsertItem(item);
          }
        } else {
          refreshHistory();
        }
      });
    },
    [refreshHistory, upsertItem]
  );

  const onDelete = useCallback(
    (id: number) => {
      void clipboardApi.deleteItem(id).then((result) => {
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
      if (shouldIgnoreGlobalShortcut(event)) {
        return;
      }
      if (event.ctrlKey && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        return;
      }
      if (event.key === 'Escape') {
        void clipboardApi.hideWindow();
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
        onCopy(selectedItemId);
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
  }, [filteredItems, onCopy, onDelete, onToggleFavorite, onTogglePin, selectedIndex, selectedItemId, setSelectedItemId]);

  return (
    <div
      ref={containerRef}
      className="h-full min-h-[260px]"
    >
      {filteredItems.length === 0 ? (
        <EmptyState />
      ) : (
        <List
          ref={listRef}
          width="100%"
          height={height}
          itemCount={filteredItems.length}
          itemSize={ITEM_HEIGHT}
          itemData={{
            items: filteredItems,
            selectedId: selectedItemId,
            onCopy,
            onTogglePin,
            onToggleFavorite,
            onDelete,
            onSelect
          }}
        >
          {Row}
        </List>
      )}
    </div>
  );
}
