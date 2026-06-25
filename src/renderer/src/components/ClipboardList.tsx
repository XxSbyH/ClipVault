import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FixedSizeList as List, type ListChildComponentProps } from 'react-window';
import type { ClipboardItem as ClipboardItemType, SpecialPasteAction } from '@shared/types';
import { ClipboardItemContextMenu } from '@/components/ClipboardItemContextMenu';
import { ClipboardItem } from '@/components/ClipboardItem';
import { EmptyState } from '@/components/EmptyState';
import { TextWorkbenchDialog } from '@/components/TextWorkbenchDialog';
import { clipboardApi } from '@/lib/tauriApi';
import { getHistoryFetchLimit } from '@/lib/historyLimit';
import { itemMatchesSearchQuery } from '@/lib/search';
import { useClipboardStore } from '@/store/clipboardStore';

const ITEM_HEIGHT = 78;

interface RowData {
  items: ClipboardItemType[];
  selectedId: number | null;
  onPaste: (id: number) => void;
  onTogglePin: (id: number) => void;
  onToggleFavorite: (id: number) => void;
  onDelete: (id: number) => void;
  onSelect: (id: number) => void;
  onContextMenu: (item: ClipboardItemType, x: number, y: number) => void;
}

interface FixedContentPrefill {
  title: string;
  content: string;
}

interface ClipboardListProps {
  onAddFixedContent?: (prefill: FixedContentPrefill) => void;
}

interface ContextMenuState {
  itemId: number;
  x: number;
  y: number;
}

function filterItems(
  items: ClipboardItemType[],
  type: ReturnType<typeof useClipboardStore.getState>['selectedType'],
  query: string
) {
  const searchedItems = query.trim() ? items.filter((item) => itemMatchesSearchQuery(item, query)) : items;
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
        onPaste={data.onPaste}
        onTogglePin={data.onTogglePin}
        onToggleFavorite={data.onToggleFavorite}
        onDelete={data.onDelete}
        onSelect={data.onSelect}
        onContextMenu={data.onContextMenu}
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

function fixedContentTitleFromItem(item: ClipboardItemType, content: string): string {
  const firstLine = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return (firstLine || item.preview || '固定内容').slice(0, 48);
}

export function ClipboardList({ onAddFixedContent }: ClipboardListProps = {}): JSX.Element {
  const items = useClipboardStore((state) => state.items);
  const searchQuery = useClipboardStore((state) => state.searchQuery);
  const selectedType = useClipboardStore((state) => state.selectedType);
  const selectedItemId = useClipboardStore((state) => state.selectedItemId);
  const setSelectedItemId = useClipboardStore((state) => state.setSelectedItemId);
  const setItems = useClipboardStore((state) => state.setItems);
  const upsertItem = useClipboardStore((state) => state.upsertItem);
  const settings = useClipboardStore((state) => state.settings);
  const removeItem = useClipboardStore((state) => state.removeItem);
  const [height, setHeight] = useState(360);
  const listRef = useRef<List<RowData>>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const copyQueueRef = useRef<Promise<void>>(Promise.resolve());
  const copyRequestSeqRef = useRef(0);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [workbenchItemId, setWorkbenchItemId] = useState<number | null>(null);

  const filteredItems = useMemo(() => filterItems(items, selectedType, searchQuery), [items, searchQuery, selectedType]);

  const contextMenuItem = useMemo(
    () => (contextMenu ? items.find((item) => item.id === contextMenu.itemId) ?? null : null),
    [contextMenu, items]
  );

  const workbenchItem = useMemo(
    () => (workbenchItemId ? items.find((item) => item.id === workbenchItemId) ?? null : null),
    [items, workbenchItemId]
  );

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
    void clipboardApi.getHistory(getHistoryFetchLimit(settings)).then(setItems);
  }, [setItems, settings]);

  const selectHistoryItem = useCallback(
    (id: number) => {
      setSelectedItemId(id);
      void clipboardApi.setQuickPasteCursor(id).catch(() => undefined);
    },
    [setSelectedItemId]
  );

  const onPaste = useCallback(
    (id: number) => {
      selectHistoryItem(id);
      void clipboardApi.pasteItem(id);
    },
    [selectHistoryItem]
  );

  const onCopy = useCallback(
    (id: number) => {
      const seq = copyRequestSeqRef.current + 1;
      copyRequestSeqRef.current = seq;
      selectHistoryItem(id);
      copyQueueRef.current = copyQueueRef.current.catch(() => undefined).then(async () => {
        if (seq !== copyRequestSeqRef.current) {
          return;
        }
        const result = await clipboardApi.copyItem(id);
        if (result.success && result.item) {
          upsertItem(result.item);
          if (seq === copyRequestSeqRef.current) {
            selectHistoryItem(result.item.id);
          }
        }
      });
    },
    [selectHistoryItem, upsertItem]
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
      selectHistoryItem(id);
    },
    [selectHistoryItem]
  );

  const openContextMenu = useCallback((item: ClipboardItemType, x: number, y: number) => {
    setContextMenu({ itemId: item.id, x, y });
  }, []);

  const onSpecialPaste = useCallback(
    (item: ClipboardItemType, action: SpecialPasteAction) => {
      setContextMenu(null);
      selectHistoryItem(item.id);
      void clipboardApi.specialPasteItem(item.id, action).then((result) => {
        if (result.success && result.item) {
          upsertItem(result.item);
          selectHistoryItem(result.item.id);
        }
      });
    },
    [selectHistoryItem, upsertItem]
  );

  const openWorkbench = useCallback((item: ClipboardItemType) => {
    setContextMenu(null);
    setWorkbenchItemId(item.id);
  }, []);

  const addFixedContentFromItem = useCallback(
    (item: ClipboardItemType, content = item.content ?? item.preview) => {
      setContextMenu(null);
      const prefill = {
        title: fixedContentTitleFromItem(item, content),
        content
      };
      onAddFixedContent?.(prefill);
    },
    [onAddFixedContent]
  );

  const saveCurrentTextItem = useCallback(
    async (item: ClipboardItemType, content: string) => {
      const updated = await clipboardApi.updateTextItem(item.id, content);
      upsertItem(updated);
      selectHistoryItem(updated.id);
    },
    [selectHistoryItem, upsertItem]
  );

  const saveNewTextItem = useCallback(
    async (content: string) => {
      const item = await clipboardApi.createTextItem(content);
      upsertItem(item);
      selectHistoryItem(item.id);
    },
    [selectHistoryItem, upsertItem]
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
    if (selectedIndex >= 0) {
      listRef.current?.scrollToItem(selectedIndex, 'smart');
    }
  }, [selectedIndex]);

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
        if (contextMenu) {
          setContextMenu(null);
          return;
        }
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
        onPaste(selectedItemId);
      }
      if (event.ctrlKey && event.key.toLowerCase() === 'c' && selectedItemId) {
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
  }, [
    contextMenu,
    filteredItems,
    onCopy,
    onDelete,
    onPaste,
    onToggleFavorite,
    onTogglePin,
    selectedIndex,
    selectedItemId,
    setSelectedItemId
  ]);

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
            onPaste,
            onTogglePin,
            onToggleFavorite,
            onDelete,
            onSelect,
            onContextMenu: openContextMenu
          }}
        >
          {Row}
        </List>
      )}
      {contextMenu && contextMenuItem ? (
        <ClipboardItemContextMenu
          item={contextMenuItem}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          onSpecialPaste={onSpecialPaste}
          onEdit={openWorkbench}
          onAddFixedContent={(item) => addFixedContentFromItem(item)}
          onDelete={(id) => {
            setContextMenu(null);
            onDelete(id);
          }}
        />
      ) : null}
      <TextWorkbenchDialog
        open={Boolean(workbenchItem)}
        item={workbenchItem}
        onOpenChange={(open) => {
          if (!open) {
            setWorkbenchItemId(null);
          }
        }}
        onSaveCurrent={saveCurrentTextItem}
        onSaveNew={saveNewTextItem}
      />
    </div>
  );
}
