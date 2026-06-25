import { useEffect, useMemo, useState } from 'react';
import { RotateCcw, RotateCw, Save, Star, X } from 'lucide-react';
import type { ClipboardItem, SpecialPasteAction } from '@shared/types';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import { applyTextTransform } from '@/lib/textTransform';

const TRANSFORM_BUTTONS: Array<{ action: SpecialPasteAction; label: string }> = [
  { action: 'upper', label: '全部大写' },
  { action: 'lower', label: '全部小写' },
  { action: 'camel', label: '驼峰命名法' },
  { action: 'capitalize', label: '首字母大写' },
  { action: 'sentence', label: '句首字母大写' },
  { action: 'removeNewlines', label: '移除换行符' },
  { action: 'appendNewline', label: '追加换行' },
  { action: 'appendCurrentTime', label: '追加当前时间' }
];

interface TextWorkbenchDialogProps {
  open: boolean;
  item: ClipboardItem | null;
  onOpenChange: (open: boolean) => void;
  onSaveCurrent: (item: ClipboardItem, content: string) => Promise<void> | void;
  onSaveNew: (content: string) => Promise<void> | void;
  onAddFixedContent: (item: ClipboardItem, content: string) => void;
}

export function TextWorkbenchDialog({
  open,
  item,
  onOpenChange,
  onSaveCurrent,
  onSaveNew,
  onAddFixedContent
}: TextWorkbenchDialogProps): JSX.Element {
  const original = item?.content ?? item?.preview ?? '';
  const [draft, setDraft] = useState(original);
  const [past, setPast] = useState<string[]>([]);
  const [future, setFuture] = useState<string[]>([]);
  const [findText, setFindText] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    setDraft(original);
    setPast([]);
    setFuture([]);
    setFindText('');
    setReplaceText('');
    setSaving(false);
  }, [open, original, item?.id]);

  const changed = draft !== original;
  const canSave = Boolean(item && draft.trim());

  const previewTitle = useMemo(() => {
    const source = item?.preview || original;
    return source.trim().split(/\r?\n/).find(Boolean)?.slice(0, 48) || '文本工作台';
  }, [item?.preview, original]);

  const commitDraft = (next: string) => {
    setPast((current) => [...current, draft]);
    setFuture([]);
    setDraft(next);
  };

  const undo = () => {
    setPast((current) => {
      const previous = current.at(-1);
      if (previous === undefined) {
        return current;
      }
      setFuture((nextFuture) => [draft, ...nextFuture]);
      setDraft(previous);
      return current.slice(0, -1);
    });
  };

  const redo = () => {
    setFuture((current) => {
      const next = current[0];
      if (next === undefined) {
        return current;
      }
      setPast((nextPast) => [...nextPast, draft]);
      setDraft(next);
      return current.slice(1);
    });
  };

  const replaceAll = () => {
    if (!findText) {
      return;
    }
    commitDraft(draft.split(findText).join(replaceText));
  };

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
      <DialogContent className="max-w-[860px] rounded-[1.45rem] bg-[#f8fcfa]">
        <DialogHeader className="flex flex-row items-start justify-between gap-3">
          <div className="min-w-0">
            <DialogTitle>文本工作台</DialogTitle>
            <DialogDescription className="truncate">{previewTitle}</DialogDescription>
          </div>
          <DialogClose className="shrink-0 rounded-full">
            <X className="h-4 w-4" />
          </DialogClose>
        </DialogHeader>

        <div className="grid gap-3 md:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)]">
          <section className="min-h-0 rounded-lg border border-slate-200 bg-white p-3">
            <p className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-teal-700">原始内容</p>
            <pre className="max-h-72 whitespace-pre-wrap break-words rounded-md bg-slate-50 p-3 text-sm leading-6 text-slate-700">
              {original}
            </pre>
          </section>

          <section className="space-y-3 rounded-lg border border-slate-200 bg-white p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={past.length === 0}
                onClick={undo}
              >
                <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                撤销
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={future.length === 0}
                onClick={redo}
              >
                <RotateCw className="mr-1.5 h-3.5 w-3.5" />
                重做
              </Button>
            </div>

            <label className="block space-y-1 text-xs font-semibold text-slate-600">
              <span>编辑结果</span>
              <textarea
                aria-label="编辑结果"
                className="min-h-40 w-full resize-y rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm leading-6 outline-none transition-colors focus:border-teal-300 focus:ring-2 focus:ring-teal-100"
                value={draft}
                onChange={(event) => commitDraft(event.target.value)}
              />
            </label>

            <div className="grid gap-2 sm:grid-cols-2">
              <input
                aria-label="查找"
                className="h-9 rounded-md border border-slate-200 px-3 text-sm outline-none focus:border-teal-300 focus:ring-2 focus:ring-teal-100"
                value={findText}
                onChange={(event) => setFindText(event.target.value)}
                placeholder="查找"
              />
              <div className="flex gap-2">
                <input
                  aria-label="替换为"
                  className="h-9 min-w-0 flex-1 rounded-md border border-slate-200 px-3 text-sm outline-none focus:border-teal-300 focus:ring-2 focus:ring-teal-100"
                  value={replaceText}
                  onChange={(event) => setReplaceText(event.target.value)}
                  placeholder="替换为"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!findText}
                  onClick={replaceAll}
                >
                  替换
                </Button>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              {TRANSFORM_BUTTONS.map((entry) => (
                <Button
                  key={entry.action}
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => commitDraft(applyTextTransform(draft, entry.action))}
                >
                  {entry.label}
                </Button>
              ))}
            </div>

            <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 pt-3">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={!item || !draft.trim()}
                onClick={() => {
                  if (item) {
                    onAddFixedContent(item, draft);
                    onOpenChange(false);
                  }
                }}
              >
                <Star className="mr-1.5 h-3.5 w-3.5" />
                添加为固定内容
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!canSave || saving}
                onClick={saveNew}
              >
                另存为新历史
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
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
