import { FileText } from 'lucide-react';

export function EmptyState(): JSX.Element {
  return (
    <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-border bg-card p-6">
      <div className="space-y-3 text-center">
        <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-accent/30">
          <FileText className="h-10 w-10 text-muted-foreground/60" />
        </div>
        <p className="text-base font-medium">暂无剪贴板历史</p>
        <p className="text-sm text-muted-foreground">复制任何内容，它们会自动出现在这里</p>
      </div>
    </div>
  );
}
