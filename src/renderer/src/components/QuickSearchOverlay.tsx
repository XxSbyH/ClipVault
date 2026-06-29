import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Code2,
  Copy,
  FileText,
  Folder,
  Image as ImageIcon,
  Link2,
  Mail,
  Palette,
  Search
} from 'lucide-react';
import type { ClipboardContentType, ClipboardItem } from '@shared/types';
import { clipboardApi } from '@/lib/tauriApi';
import { cn } from '@/lib/utils';

const QUICK_SEARCH_LIMIT = 20;

const TYPE_META: Record<ClipboardContentType, { label: string; icon: JSX.Element; className: string }> = {
  text: {
    label: '文本',
    icon: <FileText className="h-4 w-4" />,
    className: 'bg-slate-50 text-slate-700'
  },
  image: {
    label: '图片',
    icon: <ImageIcon className="h-4 w-4" />,
    className: 'bg-teal-50 text-teal-800'
  },
  file: {
    label: '文件',
    icon: <Folder className="h-4 w-4" />,
    className: 'bg-amber-50 text-amber-800'
  },
  url: {
    label: '链接',
    icon: <Link2 className="h-4 w-4" />,
    className: 'bg-sky-50 text-sky-800'
  },
  code: {
    label: '代码',
    icon: <Code2 className="h-4 w-4" />,
    className: 'bg-indigo-50 text-indigo-800'
  },
  color: {
    label: '颜色',
    icon: <Palette className="h-4 w-4" />,
    className: 'bg-pink-50 text-pink-800'
  },
  email: {
    label: '邮箱',
    icon: <Mail className="h-4 w-4" />,
    className: 'bg-emerald-50 text-emerald-800'
  }
};

function itemText(item: ClipboardItem): string {
  return item.preview || item.content || item.filePath || '空内容';
}

export function QuickSearchOverlay(): JSX.Element {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<ClipboardItem[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const selectedOptionRef = useRef<HTMLButtonElement | null>(null);
  const requestSeqRef = useRef(0);

  const selectedItem = items[selectedIndex] ?? null;

  const loadItems = useCallback((nextQuery: string) => {
    const seq = requestSeqRef.current + 1;
    requestSeqRef.current = seq;
    setLoading(true);
    const request = nextQuery.trim()
      ? clipboardApi.searchItems(nextQuery.trim(), QUICK_SEARCH_LIMIT)
      : clipboardApi.getHistory(QUICK_SEARCH_LIMIT);

    void request
      .then((nextItems) => {
        if (seq !== requestSeqRef.current) {
          return;
        }
        setItems(nextItems);
        setSelectedIndex(0);
      })
      .finally(() => {
        if (seq === requestSeqRef.current) {
          setLoading(false);
        }
      });
  }, []);

  const resetSearch = useCallback(() => {
    setQuery('');
    loadItems('');
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [loadItems]);

  const hide = useCallback(() => {
    void clipboardApi.hideSearchWindow();
  }, []);

  const pasteSelected = useCallback(
    async (item: ClipboardItem | null) => {
      if (!item) {
        return;
      }
      const result = await clipboardApi.pasteItem(item.id);
      if (result.success) {
        await clipboardApi.hideSearchWindow();
      }
    },
    []
  );

  const copySelected = useCallback(
    async (item: ClipboardItem | null) => {
      if (!item) {
        return;
      }
      const result = await clipboardApi.copyItem(item.id);
      if (result.success) {
        await clipboardApi.hideSearchWindow();
      }
    },
    []
  );

  useEffect(() => {
    loadItems(query);
  }, [loadItems, query]);

  useEffect(() => {
    inputRef.current?.focus();
    const offOpen = clipboardApi.onQuickSearchOpened(resetSearch);
    return () => {
      offOpen();
    };
  }, [resetSearch]);

  useEffect(() => {
    selectedOptionRef.current?.scrollIntoView({ block: 'nearest' });
  }, [items, selectedIndex]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        hide();
        return;
      }
      if (items.length === 0) {
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelectedIndex((current) => Math.min(current + 1, items.length - 1));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelectedIndex((current) => Math.max(current - 1, 0));
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        void pasteSelected(selectedItem);
        return;
      }
      if (event.ctrlKey && event.key.toLowerCase() === 'c') {
        event.preventDefault();
        void copySelected(selectedItem);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [copySelected, hide, items.length, pasteSelected, selectedItem]);

  return (
    <main
      data-testid="quick-search-backdrop"
      className="quick-search-root flex h-full w-full items-start justify-end bg-transparent px-4 pb-2 pt-5 text-slate-950"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          hide();
        }
      }}
    >
      <section className="no-drag flex max-h-[276px] min-h-[214px] w-full max-w-[496px] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl shadow-slate-900/10">
        <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-slate-100 px-3">
          <Search className="h-5 w-5 text-teal-700" />
          <input
            ref={inputRef}
            aria-label="搜索剪贴板历史"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索剪贴板历史"
            className="h-9 min-w-0 flex-1 bg-transparent text-sm font-semibold text-slate-950 outline-none placeholder:text-slate-400"
          />
          <span className="rounded-full bg-slate-50 px-2 py-1 text-[11px] font-semibold text-slate-500">
            {loading ? '搜索中' : `${items.length} 项`}
          </span>
        </div>

        {items.length === 0 ? (
          <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center">
            <div>
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-teal-50 text-teal-700">
                <Search className="h-5 w-5" />
              </div>
              <p className="mt-3 text-sm font-black text-slate-900">没有匹配项</p>
              <p className="mt-1 text-xs leading-5 text-slate-500">换个关键词试试，或按 Esc 关闭。</p>
            </div>
          </div>
        ) : (
          <div
            role="listbox"
            aria-label="搜索结果"
            className="min-h-0 flex-1 overflow-y-auto p-2"
          >
            {items.map((item, index) => {
              const meta = TYPE_META[item.contentType];
              const selected = index === selectedIndex;
              return (
                <button
                  key={item.id}
                  ref={selected ? selectedOptionRef : undefined}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  aria-label={`${meta.label} ${itemText(item)}`}
                  className={cn(
                    'grid h-10 w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-xl px-2.5 text-left transition',
                    selected ? 'bg-teal-50 ring-1 ring-teal-200' : 'hover:bg-slate-50'
                  )}
                  onClick={() => setSelectedIndex(index)}
                  onDoubleClick={() => {
                    setSelectedIndex(index);
                    void pasteSelected(item);
                  }}
                >
                  <span className={cn('flex h-8 w-8 items-center justify-center rounded-lg', meta.className)}>
                    {meta.icon}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-bold text-slate-950">{itemText(item)}</span>
                    <span className="block truncate text-[11px] font-medium text-slate-500">
                      {meta.label}
                      {item.isPinned ? ' · 置顶' : ''}
                      {item.isFavorite ? ' · 收藏' : ''}
                    </span>
                  </span>
                  <Copy className="h-3.5 w-3.5 text-slate-300" />
                </button>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}
