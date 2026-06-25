import { memo, useEffect, useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import {
  Code2,
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
import type { ClipboardItem as ClipboardItemType } from '@shared/types';
import { Button } from '@/components/ui/button';
import { clipboardApi } from '@/lib/tauriApi';
import { cn } from '@/lib/utils';

interface ClipboardItemProps {
  item: ClipboardItemType;
  selected: boolean;
  onPaste: (id: number) => void;
  onTogglePin: (id: number) => void;
  onToggleFavorite: (id: number) => void;
  onDelete: (id: number) => void;
  onSelect: (id: number) => void;
  onContextMenu: (item: ClipboardItemType, x: number, y: number) => void;
}

const TYPE_META: Record<
  ClipboardItemType['contentType'],
  { label: string; className: string; icon: JSX.Element }
> = {
  text: {
    label: '文本',
    className: 'bg-slate-50 text-slate-600',
    icon: <FileText className="h-4 w-4" />
  },
  image: {
    label: '图片',
    className: 'bg-teal-50 text-teal-800',
    icon: <ImageIcon className="h-4 w-4" />
  },
  file: {
    label: '文件',
    className: 'bg-amber-50 text-amber-800',
    icon: <Folder className="h-4 w-4" />
  },
  url: {
    label: '链接',
    className: 'bg-sky-50 text-sky-800',
    icon: <Link2 className="h-4 w-4" />
  },
  code: {
    label: '代码',
    className: 'bg-indigo-50 text-indigo-800',
    icon: <Code2 className="h-4 w-4" />
  },
  color: {
    label: '颜色',
    className: 'bg-pink-50 text-pink-800',
    icon: <Palette className="h-4 w-4" />
  },
  email: {
    label: '邮箱',
    className: 'bg-emerald-50 text-emerald-800',
    icon: <Mail className="h-4 w-4" />
  }
};

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

function ClipboardItemView({
  item,
  selected,
  onPaste,
  onTogglePin,
  onToggleFavorite,
  onDelete,
  onSelect,
  onContextMenu
}: ClipboardItemProps): JSX.Element {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const typeMeta = TYPE_META[item.contentType];

  useEffect(() => {
    if (item.contentType !== 'image') {
      setImageUrl(null);
      return;
    }
    setImageUrl(null);
    let cancelled = false;
    const imageId = item.id;
    void clipboardApi
      .getImageDataUrl(imageId)
      .then((url) => {
        if (!cancelled && imageId === item.id) {
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
  }, [item.contentType, item.id]);

  const imageTitle =
    typeof item.metadata.fileName === 'string' && item.metadata.fileName.trim()
      ? item.metadata.fileName
      : item.preview || '剪贴板图片';

  const size = formatFileSize(item.metadata.fileSize ?? item.metadata.compressedSize);
  const time = formatDistanceToNow(new Date(item.createdAt), { addSuffix: true });

  const actionButtons = (
    <div className="flex shrink-0 items-center gap-0.5 opacity-70 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 rounded-full hover:bg-teal-50 hover:text-teal-800"
        onClick={(event) => {
          event.stopPropagation();
          onTogglePin(item.id);
        }}
        title={item.isPinned ? '取消置顶' : '置顶'}
      >
        <Pin className={cn('h-4 w-4', item.isPinned ? 'fill-teal-700 text-teal-700' : 'text-muted-foreground')} />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 rounded-full hover:bg-amber-50 hover:text-amber-700"
        onClick={(event) => {
          event.stopPropagation();
          onToggleFavorite(item.id);
        }}
        title={item.isFavorite ? '取消收藏' : '收藏'}
      >
        <Star className={cn('h-4 w-4', item.isFavorite ? 'fill-amber-500 text-amber-500' : 'text-muted-foreground')} />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 rounded-full hover:bg-red-50 hover:text-red-600"
        onClick={(event) => {
          event.stopPropagation();
          onDelete(item.id);
        }}
        title="删除"
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    </div>
  );

  return (
    <>
      <article
        className={cn(
          'clipboard-item-card group grid h-[68px] w-full cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 rounded-[1.1rem] border bg-white p-2 text-left transition-colors',
          'hover:border-teal-200 hover:bg-teal-50/35',
          selected
            ? 'border-teal-500 bg-teal-50/65 ring-2 ring-teal-100'
            : 'border-slate-200/70'
        )}
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        title="点击查看详情，双击粘贴"
        onClick={() => {
          onSelect(item.id);
        }}
        onDoubleClick={() => {
          onSelect(item.id);
          onPaste(item.id);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          onSelect(item.id);
          onContextMenu(item, event.clientX, event.clientY);
        }}
      >
        {item.contentType === 'image' ? (
          <div className="h-11 w-11 overflow-hidden rounded-xl border border-slate-200 bg-teal-50">
            {imageUrl ? (
              <img
                src={imageUrl}
                alt={imageTitle}
                className="h-full w-full object-cover"
              />
            ) : (
              <span className="flex h-full w-full items-center justify-center text-teal-700">
                <ImageIcon className="h-5 w-5" />
              </span>
            )}
          </div>
        ) : (
          <div className={cn('flex h-10 w-10 items-center justify-center rounded-xl', typeMeta.className)}>
            {typeMeta.icon}
          </div>
        )}

        <div className="min-w-0">
          <div className="mb-0.5 flex items-center gap-1.5">
            <span className={cn('rounded-full px-1.5 py-0.5 text-[10px] font-semibold', typeMeta.className)}>
              {typeMeta.label}
            </span>
            {item.isPinned ? <span className="h-1.5 w-1.5 rounded-full bg-teal-600" title="已置顶" /> : null}
            {item.isFavorite ? <span className="h-1.5 w-1.5 rounded-full bg-amber-500" title="已收藏" /> : null}
          </div>
          <p className="line-clamp-1 break-words text-sm font-medium leading-5 text-slate-950">
            {item.preview || item.content || '空内容'}
          </p>
          <div className="mt-0.5 flex items-center gap-2 text-[11px] text-slate-500">
            <span>{time}</span>
            {size ? <span>{size}</span> : null}
            {item.useCount > 0 ? <span>已用 {item.useCount} 次</span> : null}
          </div>
        </div>

        {actionButtons}
      </article>
    </>
  );
}

export const ClipboardItem = memo(ClipboardItemView);
