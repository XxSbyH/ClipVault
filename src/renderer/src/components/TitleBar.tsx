import { ClipboardList, Minus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function TitleBar(): JSX.Element {
  return (
    <div className="drag-region flex items-center justify-between border-b border-border bg-card px-3 py-2">
      <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <ClipboardList className="h-4 w-4 text-primary" />
        <span>ClipVault</span>
      </div>
      <div className="no-drag flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          title="最小化"
          onClick={() => {
            void window.electron.minimizeWindow();
          }}
        >
          <Minus className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          title="关闭"
          onClick={() => {
            void window.electron.hideWindow();
          }}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
