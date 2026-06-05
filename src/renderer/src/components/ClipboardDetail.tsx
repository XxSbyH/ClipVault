import { useEffect, useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import {
  CheckCircle2,
  Code2,
  Copy,
  FileText,
  Folder,
  Image as ImageIcon,
  Link2,
  Mail,
  Palette,
  Pin,
  Star,
  Trash2
} from 'lucide-react';
import type { ClipboardItem } from '@shared/types';
import { Button } from '@/components/ui/button';
import { clipboardApi } from '@/lib/tauriApi';
import { cn } from '@/lib/utils';
import { useClipboardStore } from '@/store/clipboardStore';

const TYPE_LABELS: Record<ClipboardItem['contentType'], string> = {
  text: '文本',
  image: '图片',
  file: '文件',
  url: '链接',
  code: '代码',
  color: '颜色',
  email: '邮箱'
};

function iconForType(type: ClipboardItem['contentType']): JSX.Element {
  const className = 'h-4 w-4';
  switch (type) {
    case 'url':
      return <Link2 className={className} />;
    case 'code':
      return <Code2 className={className} />;
    case 'image':
      return <ImageIcon className={className} />;
    case 'file':
      return <Folder className={className} />;
    case 'color':
      return <Palette className={className} />;
    case 'email':
      return <Mail className={className} />;
    default:
      return <FileText className={className} />;
  }
}

function formatFileSize(value: unknown): string | null {
  if (typeof value !== 'number' || Number.isNaN(value) || value <= 0) {
    return null;
  }
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function ClipboardDetail(): JSX.Element {
  const items = useClipboardStore((state) => state.items);
  const selectedItemId = useClipboardStore((state) => state.selectedItemId);
  const upsertItem = useClipboardStore((state) => state.upsertItem);
  const removeItem = useClipboardStore((state) => state.removeItem);
  const item = items.find((entry) => entry.id === selectedItemId) ?? null;
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setCopied(false);
    if (!item || item.contentType !== 'image') {
      setImageUrl(null);
      return;
    }
    setImageUrl(null);
    let cancelled = false;
    const imageId = item.id;
    void clipboardApi
      .getImageDataUrl(imageId)
      .then((url) => {
        if (!cancelled && useClipboardStore.getState().selectedItemId === imageId) {
          setImageUrl(url);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setImageUrl(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [item]);

  if (!item) {
    return (
      <aside className="detail-panel flex min-h-[154px] flex-col items-center justify-center rounded-2xl border border-dashed border-teal-200/80 bg-white/65 px-4 text-center">
        <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-teal-50 text-teal-700">
          <FileText className="h-5 w-5" />
        </div>
        <p className="text-sm font-semibold text-foreground">选择一条历史记录</p>
        <p className="mt-1 text-xs text-muted-foreground">预览内容、路径、大小和使用状态。</p>
      </aside>
    );
  }

  const size = formatFileSize(item.metadata.fileSize ?? item.metadata.compressedSize);
  const time = formatDistanceToNow(new Date(item.createdAt), { addSuffix: true });
  const preview = item.contentType === 'file' ? item.filePath ?? item.preview : item.preview;

  const paste = () => {
    void clipboardApi.pasteItem(item.id).then((result) => {
      if (result.success) {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      }
    });
  };

  const togglePin = () => {
    void clipboardApi.togglePin(item.id).then((updated) => {
      const stillExists = useClipboardStore.getState().items.some((current) => current.id === item.id);
      if (updated && stillExists) {
        upsertItem(updated);
      }
    });
  };

  const toggleFavorite = () => {
    void clipboardApi.toggleFavorite(item.id).then((updated) => {
      const stillExists = useClipboardStore.getState().items.some((current) => current.id === item.id);
      if (updated && stillExists) {
        upsertItem(updated);
      }
    });
  };

  const deleteItem = () => {
    void clipboardApi.deleteItem(item.id).then((result) => {
      if (result.success) {
        removeItem(item.id);
      }
    });
  };

  return (
    <aside className="detail-panel rounded-2xl border border-teal-100 bg-white/78 p-3 shadow-[0_18px_45px_rgba(15,118,110,0.10)]">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-teal-100 text-teal-800">
          {iconForType(item.contentType)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-teal-50 px-2 py-0.5 text-[11px] font-semibold text-teal-800">
              {TYPE_LABELS[item.contentType]}
            </span>
            {item.isPinned ? <span className="rounded-full bg-orange-50 px-2 py-0.5 text-[11px] text-orange-700">已置顶</span> : null}
            {item.isFavorite ? <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] text-amber-700">已收藏</span> : null}
          </div>
          <p className="mt-2 line-clamp-3 text-sm leading-6 text-slate-800">{preview || '空内容'}</p>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            <span>{time}</span>
            {size ? <span>{size}</span> : null}
            {item.useCount > 0 ? <span>已使用 {item.useCount} 次</span> : <span>尚未使用</span>}
          </div>
        </div>
        {item.contentType === 'image' && imageUrl ? (
          <img
            src={imageUrl}
            alt={item.preview || '剪贴板图片'}
            className="h-20 w-20 shrink-0 rounded-xl border border-teal-100 object-cover"
          />
        ) : null}
      </div>

      <div className="mt-3 grid grid-cols-4 gap-2">
        <Button
          size="sm"
          className={cn('gap-1.5 bg-teal-700 hover:bg-teal-800', copied && 'bg-emerald-600')}
          onClick={paste}
        >
          {copied ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? '已粘贴' : '粘贴'}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={togglePin}
        >
          <Pin className={cn('h-3.5 w-3.5', item.isPinned && 'fill-teal-700 text-teal-700')} />
          置顶
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={toggleFavorite}
        >
          <Star className={cn('h-3.5 w-3.5', item.isFavorite && 'fill-amber-500 text-amber-500')} />
          收藏
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 text-red-600 hover:bg-red-50"
          onClick={deleteItem}
        >
          <Trash2 className="h-3.5 w-3.5" />
          删除
        </Button>
      </div>
    </aside>
  );
}
