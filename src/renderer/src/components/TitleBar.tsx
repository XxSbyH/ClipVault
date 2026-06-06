import { ClipboardList, Minus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { clipboardApi } from '@/lib/tauriApi';

export function TitleBar(): JSX.Element {
  return (
    <div className="drag-region relative z-20 flex h-10 items-center justify-between px-4 pt-2">
      <div className="flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-700">
        <ClipboardList className="h-3.5 w-3.5 text-teal-700" />
        <span>ClipVault</span>
      </div>

      <div className="no-drag flex items-center gap-1 rounded-full border border-slate-200 bg-white p-1">
        <Button
          variant="ghost"
          size="icon"
          title="最小化"
          className="h-7 w-7 rounded-full hover:bg-teal-50"
          onClick={() => {
            void clipboardApi.minimizeWindow();
          }}
        >
          <Minus className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          title="隐藏面板"
          className="h-7 w-7 rounded-full hover:bg-orange-50 hover:text-orange-700"
          onClick={() => {
            void clipboardApi.hideWindow();
          }}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
