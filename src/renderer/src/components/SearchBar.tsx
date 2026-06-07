import { useEffect, useRef } from 'react';
import { Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { parseRegexQuery } from '@/lib/search';
import { clipboardApi } from '@/lib/tauriApi';
import { useClipboardStore } from '@/store/clipboardStore';

export function SearchBar(): JSX.Element {
  const searchQuery = useClipboardStore((state) => state.searchQuery);
  const setSearchQuery = useClipboardStore((state) => state.setSearchQuery);
  const inputRef = useRef<HTMLInputElement>(null);
  const isRegexQuery = Boolean(parseRegexQuery(searchQuery));

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
        placeholder="输入要搜索的内容"
        title="支持普通文本搜索和正则搜索，例如 /token|key/i 或 re:token"
        className="h-9 w-full truncate rounded-xl border border-slate-200 bg-white py-2 pl-10 pr-16 text-sm font-medium text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-teal-400 focus:ring-4 focus:ring-teal-50"
      />
      <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
        {isRegexQuery ? (
          <span className="rounded-md bg-teal-50 px-1.5 py-0.5 text-[10px] font-black text-teal-700">.*</span>
        ) : null}
        {searchQuery ? (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 rounded-full hover:bg-orange-50 hover:text-orange-700"
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
