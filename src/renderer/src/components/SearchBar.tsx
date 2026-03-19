import { useEffect, useRef } from 'react';
import { Search, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useClipboardStore } from '@/store/clipboardStore';

export function SearchBar(): JSX.Element {
  const searchQuery = useClipboardStore((state) => state.searchQuery);
  const setSearchQuery = useClipboardStore((state) => state.setSearchQuery);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const offFocus = window.electron.onFocusSearch(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => {
      offFocus();
    };
  }, []);

  return (
    <div className="flex items-center gap-2">
      <div className="relative flex-1">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={inputRef}
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder="搜索剪贴板..."
          className="search-input pl-9 pr-10"
        />
        {searchQuery ? (
          <Button
            variant="ghost"
            size="icon"
            className="absolute right-1 top-1 h-8 w-8"
            onClick={() => setSearchQuery('')}
          >
            <X className="h-4 w-4" />
          </Button>
        ) : null}
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={() => inputRef.current?.focus()}
      >
        Ctrl+F
      </Button>
    </div>
  );
}
