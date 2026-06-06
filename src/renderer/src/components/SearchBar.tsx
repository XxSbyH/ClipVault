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
      <Search className="pointer-events-none absolute left-3.5 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-slate-400" />
      <input
        ref={inputRef}
        value={searchQuery}
        onChange={(event) => setSearchQuery(event.target.value)}
        placeholder="搜索文本、链接、代码、颜色或文件路径"
        className="h-11 w-full rounded-2xl border border-slate-200 bg-white py-2.5 pl-10 pr-12 text-sm font-medium text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-teal-400 focus:ring-4 focus:ring-teal-50"
      />
      <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center">
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
      </div>
    </div>
  );
}
