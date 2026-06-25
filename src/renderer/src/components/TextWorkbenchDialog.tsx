import { useEffect, useMemo, useState } from 'react';
import { FilePlus2, Save, X } from 'lucide-react';
import type { ClipboardItem } from '@shared/types';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';

interface TextWorkbenchDialogProps {
  open: boolean;
  item: ClipboardItem | null;
  onOpenChange: (open: boolean) => void;
  onSaveCurrent: (item: ClipboardItem, content: string) => Promise<void> | void;
  onSaveNew: (content: string) => Promise<void> | void;
}

export function TextWorkbenchDialog({
  open,
  item,
  onOpenChange,
  onSaveCurrent,
  onSaveNew
}: TextWorkbenchDialogProps): JSX.Element {
  const original = item?.content ?? item?.preview ?? '';
  const [draft, setDraft] = useState(original);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    setDraft(original);
    setSaving(false);
  }, [open, original, item?.id]);

  const changed = draft !== original;
  const canSave = Boolean(item && draft.trim());

  const previewTitle = useMemo(() => {
    const source = item?.preview || original;
    return source.trim().split(/\r?\n/).find(Boolean)?.slice(0, 48) || '文本工作台';
  }, [item?.preview, original]);

  const saveCurrent = async () => {
    if (!item || !canSave) {
      return;
    }
    setSaving(true);
    try {
      await onSaveCurrent(item, draft);
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  const saveNew = async () => {
    if (!canSave) {
      return;
    }
    setSaving(true);
    try {
      await onSaveNew(draft);
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-2rem)] max-w-[560px] overflow-y-auto rounded-[1.35rem] bg-[#f8fcfa]">
        <DialogHeader className="flex flex-row items-start justify-between gap-3">
          <div className="min-w-0">
            <DialogTitle>编辑内容</DialogTitle>
            <DialogDescription className="truncate">{previewTitle}</DialogDescription>
          </div>
          <DialogClose className="shrink-0 rounded-full">
            <X className="h-4 w-4" />
          </DialogClose>
        </DialogHeader>

        <div className="space-y-3">
          <section className="rounded-xl border border-slate-200 bg-white p-3">
            <p className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-teal-700">原始内容</p>
            <pre className="max-h-28 whitespace-pre-wrap break-words rounded-lg bg-slate-50 px-3 py-2 text-sm leading-6 text-slate-700">
              {original}
            </pre>
          </section>

          <label className="block space-y-1 text-xs font-semibold text-slate-600">
            <span>编辑结果</span>
            <textarea
              aria-label="编辑结果"
              className="min-h-44 w-full resize-y rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm leading-6 outline-none transition-colors focus:border-teal-300 focus:ring-2 focus:ring-teal-100"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
          </label>

          <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 pt-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!canSave || saving}
              onClick={saveNew}
            >
              <FilePlus2 className="mr-1.5 h-3.5 w-3.5" />
              另存为新记录
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!canSave || !changed || saving}
              onClick={saveCurrent}
            >
              <Save className="mr-1.5 h-3.5 w-3.5" />
              保存到当前历史
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
