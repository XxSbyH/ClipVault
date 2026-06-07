import { Code2, FileText, Image as ImageIcon, Link2, Star, Rows3 } from 'lucide-react';
import type { FilterType } from '@shared/types';
import { cn } from '@/lib/utils';
import { useClipboardStore } from '@/store/clipboardStore';

const FILTERS: Array<{ value: FilterType; label: string; icon: JSX.Element }> = [
  { value: 'all', label: '全部', icon: <Rows3 className="h-3.5 w-3.5" /> },
  { value: 'text', label: '文本', icon: <FileText className="h-3.5 w-3.5" /> },
  { value: 'image', label: '图片', icon: <ImageIcon className="h-3.5 w-3.5" /> },
  { value: 'code', label: '代码', icon: <Code2 className="h-3.5 w-3.5" /> },
  { value: 'url', label: '链接', icon: <Link2 className="h-3.5 w-3.5" /> },
  { value: 'favorite', label: '收藏', icon: <Star className="h-3.5 w-3.5" /> }
];

export function TypeFilter(): JSX.Element {
  const items = useClipboardStore((state) => state.items);
  const selectedType = useClipboardStore((state) => state.selectedType);
  const setSelectedType = useClipboardStore((state) => state.setSelectedType);

  const countByType: Record<FilterType, number> = {
    all: items.length,
    text: items.filter((item) => item.contentType === 'text').length,
    image: items.filter((item) => item.contentType === 'image').length,
    code: items.filter((item) => item.contentType === 'code').length,
    url: items.filter((item) => item.contentType === 'url').length,
    favorite: items.filter((item) => item.isFavorite).length
  };

  return (
    <div className="filter-strip flex w-full min-w-0 gap-1 overflow-x-auto rounded-xl bg-transparent">
      {FILTERS.map((filter) => {
        const selected = selectedType === filter.value;
        return (
          <button
            key={filter.value}
            type="button"
            className={cn(
              'flex h-9 min-w-[58px] shrink-0 items-center justify-center gap-1 rounded-xl border px-2 text-[11px] font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-400',
              selected
                ? 'border-teal-700 bg-white text-teal-900 shadow-sm'
                : 'border-transparent bg-white/55 text-slate-500 hover:bg-white hover:text-slate-900'
            )}
            aria-pressed={selected}
            onClick={() => setSelectedType(filter.value)}
          >
            {filter.icon}
            <span>{filter.label}</span>
            <span
              className={cn(
                'rounded-full px-1 py-0.5 text-[10px]',
                selected ? 'bg-teal-50 text-teal-800' : 'bg-white text-slate-500'
              )}
            >
              {countByType[filter.value]}
            </span>
          </button>
        );
      })}
    </div>
  );
}
