import { useEffect, useRef } from 'react';
import { Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { clipboardApi } from '@/lib/tauriApi';
import { useClipboardStore } from '@/store/clipboardStore';

export function SearchBar(): JSX.Element {
  const searchQuery = useClipboardStore((state) => state.searchQuery);
  const setSearchQuery = useClipboardStore((state) => state.setSearchQuery);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const offFocus = clipboardApi.onFocusSearch(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => {
      offFocus();
    };
  }, []);

  return (
    <div className="search-command relative">
      <Search className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-teal-700" />
      <input
        ref={inputRef}
        value={searchQuery}
        onChange={(event) => setSearchQuery(event.target.value)}
        placeholder="搜索文本、链接、代码、颜色或文件路径"
        className="h-[52px] w-full rounded-2xl border border-teal-100 bg-white/88 py-3 pl-12 pr-24 text-[15px] font-semibold text-slate-950 shadow-inner outline-none transition focus:border-teal-400 focus:bg-white focus:ring-4 focus:ring-teal-100"
      />
      <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1.5">
        {searchQuery ? (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 rounded-full hover:bg-orange-50 hover:text-orange-700"
            aria-label="清空搜索"
            onClick={() => setSearchQuery('')}
          >
            <X className="h-4 w-4" />
          </Button>
        ) : null}
        <button
          type="button"
          className="rounded-full border border-teal-100 bg-teal-50 px-2.5 py-1 text-[11px] font-bold text-teal-800"
          onClick={() => inputRef.current?.focus()}
        >
          Ctrl+F
        </button>
      </div>
    </div>
  );
}
