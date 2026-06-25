import { Clipboard, Search } from 'lucide-react';

export function EmptyState(): JSX.Element {
  return (
    <div className="flex h-full min-h-[260px] items-center justify-center rounded-2xl border border-dashed border-teal-200 bg-teal-50/45 p-6">
      <div className="max-w-xs text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-white text-teal-700 shadow-sm">
          <Clipboard className="h-7 w-7" />
        </div>
        <p className="mt-4 text-base font-black text-slate-950">暂无剪贴板历史</p>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          复制文本、链接、图片或文件路径后，ClipVault 会在本地自动记录并支持搜索。
        </p>
        <div className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-xs font-semibold text-teal-800 shadow-sm">
          <Search className="h-3.5 w-3.5" />
          Ctrl+Shift+F 轻量搜索
        </div>
      </div>
    </div>
  );
}
