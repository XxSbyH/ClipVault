import { memo, useEffect, useMemo, useState } from 'react';
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ImageViewer } from '@/components/ImageViewer';
import { cn } from '@/lib/utils';
import type { ClipboardItem as ClipboardItemType } from '@shared/types';

interface ClipboardItemProps {
  item: ClipboardItemType;
  selected: boolean;
  onPaste: (id: number) => void;
  onTogglePin: (id: number) => void;
  onToggleFavorite: (id: number) => void;
  onDelete: (id: number) => void;
  onSelect: (id: number) => void;
}

function typeIcon(type: ClipboardItemType['contentType']): JSX.Element {
  switch (type) {
    case 'url':
      return <Link2 className="h-4 w-4 text-sky-600" />;
    case 'code':
      return <Code2 className="h-4 w-4 text-indigo-600" />;
    case 'image':
      return <ImageIcon className="h-4 w-4 text-primary" />;
    case 'file':
      return <Folder className="h-4 w-4 text-amber-600" />;
    case 'color':
      return <Palette className="h-4 w-4 text-pink-600" />;
    case 'email':
      return <Mail className="h-4 w-4 text-emerald-600" />;
    default:
      return <FileText className="h-4 w-4 text-muted-foreground" />;
  }
}

function formatFileSize(value: unknown): string {
  if (typeof value !== 'number' || Number.isNaN(value) || value <= 0) {
    return '未知大小';
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
  onSelect
}: ClipboardItemProps): JSX.Element {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [showViewer, setShowViewer] = useState(false);

  useEffect(() => {
    if (item.contentType !== 'image') {
      setImageUrl(null);
      return;
    }
    void window.electron.getImageDataUrl(item.id).then(setImageUrl);
  }, [item.contentType, item.id]);

  const imageTitle = useMemo(() => {
    const filename = item.metadata.fileName;
    if (typeof filename === 'string' && filename.trim()) {
      return filename;
    }
    if (item.preview?.trim()) {
      return item.preview;
    }
    return '未命名图片.png';
  }, [item.metadata.fileName, item.preview]);

  const baseClass = cn(
    'clipboard-item-card group w-full min-h-[88px] rounded-lg border border-border bg-card p-3 transition-colors duration-100',
    'hover:border-primary/40 hover:bg-accent/30',
    selected && 'ring-2 ring-primary/80'
  );

  const actionButtons = (
    <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
      <Button
        variant="ghost"
        size="icon"
        onClick={(event) => {
          event.stopPropagation();
          onTogglePin(item.id);
        }}
        title="置顶"
      >
        <Pin className={cn('h-4 w-4', item.isPinned ? 'fill-primary text-primary' : 'text-muted-foreground')} />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onClick={(event) => {
          event.stopPropagation();
          onToggleFavorite(item.id);
        }}
        title="收藏"
      >
        <Star className={cn('h-4 w-4', item.isFavorite ? 'fill-amber-500 text-amber-500' : 'text-muted-foreground')} />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onClick={(event) => {
          event.stopPropagation();
          onDelete(item.id);
        }}
        title="删除"
      >
        <Trash2 className="h-4 w-4 text-muted-foreground hover:text-red-500" />
      </Button>
    </div>
  );

  if (item.contentType === 'image') {
    return (
      <>
        <div
          className={baseClass}
          role="button"
          tabIndex={0}
          onClick={() => onSelect(item.id)}
          title="点击缩略图查看，点击信息区复制"
        >
          <div className="flex items-start gap-3">
            <button
              type="button"
              className="h-16 w-16 flex-shrink-0 overflow-hidden rounded-md border border-border hover:opacity-90"
              onClick={(event) => {
                event.stopPropagation();
                onSelect(item.id);
                setShowViewer(true);
              }}
            >
              {imageUrl ? (
                <img
                  src={imageUrl}
                  alt={imageTitle}
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center">
                  <ImageIcon className="h-5 w-5 text-muted-foreground" />
                </div>
              )}
            </button>

            <div
              className="min-w-0 flex-1 cursor-copy rounded-md p-1 hover:bg-accent/40"
              onClick={(event) => {
                event.stopPropagation();
                onSelect(item.id);
                onPaste(item.id);
              }}
            >
              <p className="truncate text-sm font-medium">{imageTitle}</p>
              <div className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
                <span>{formatFileSize(item.metadata.fileSize ?? item.metadata.compressedSize)}</span>
                <span>·</span>
                <span>{formatDistanceToNow(new Date(item.createdAt), { addSuffix: true })}</span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground/70">点击查看 · 点此复制</p>
            </div>

            {actionButtons}
          </div>
        </div>

        {imageUrl ? (
          <ImageViewer
            open={showViewer}
            imageUrl={imageUrl}
            title={imageTitle}
            onClose={() => setShowViewer(false)}
            onCopy={() => {
              onPaste(item.id);
            }}
          />
        ) : null}
      </>
    );
  }

  return (
    <div
      className={baseClass}
      onClick={() => {
        onSelect(item.id);
        onPaste(item.id);
      }}
      role="button"
      tabIndex={0}
      title="点击复制到剪贴板"
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 h-5 w-5 flex-shrink-0">{typeIcon(item.contentType)}</div>
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-sm leading-snug">{item.preview}</p>
          <div className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
            <span>{formatDistanceToNow(new Date(item.createdAt), { addSuffix: true })}</span>
            <span>·</span>
            <Badge>{item.contentType}</Badge>
          </div>
        </div>
        {actionButtons}
      </div>
    </div>
  );
}

export const ClipboardItem = memo(ClipboardItemView);
