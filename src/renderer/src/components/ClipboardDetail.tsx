import { useEffect, useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import {
  CheckCircle2,
  Code2,
  Copy,
  FileText,
  Folder,
  Image as ImageIcon,
  Keyboard,
  Link2,
  Mail,
  Palette
} from 'lucide-react';
import type { ClipboardItem } from '@shared/types';
import { ImageViewer } from '@/components/ImageViewer';
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

function getDetailHint(item: ClipboardItem): string {
  switch (item.contentType) {
    case 'image':
      return '点击图片可放大预览';
    case 'file':
      return '仅保存路径与元数据';
    case 'url':
      return 'Enter 复制链接';
    case 'code':
      return 'Enter 复制代码片段';
    case 'color':
      return 'Enter 复制颜色值';
    default:
      return 'Enter 复制文本';
  }
}

export function ClipboardDetail(): JSX.Element {
  const items = useClipboardStore((state) => state.items);
  const selectedItemId = useClipboardStore((state) => state.selectedItemId);
  const upsertItem = useClipboardStore((state) => state.upsertItem);
  const item = items.find((entry) => entry.id === selectedItemId) ?? null;
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [showViewer, setShowViewer] = useState(false);
  const [copied, setCopied] = useState(false);
  const itemId = item?.id ?? null;
  const itemType = item?.contentType ?? null;

  useEffect(() => {
    setCopied(false);
    setShowViewer(false);
  }, [itemId]);

  useEffect(() => {
    if (!itemId || itemType !== 'image') {
      setImageUrl(null);
      return;
    }
    setImageUrl(null);
    let cancelled = false;
    const imageId = itemId;
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
  }, [itemId, itemType]);

  if (!item) {
    return (
      <aside className="detail-panel flex h-full min-h-0 flex-col justify-center rounded-[1.35rem] border border-dashed border-slate-200 bg-white px-4 text-center">
        <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-2xl bg-slate-50 text-slate-500">
          <FileText className="h-[18px] w-[18px]" />
        </div>
        <p className="text-sm font-semibold text-slate-900">详情预览</p>
        <p className="mt-1 text-xs leading-5 text-slate-500">方向键选择历史记录，Enter 或点击列表可复制到剪贴板。</p>
      </aside>
    );
  }

  const size = formatFileSize(item.metadata.fileSize ?? item.metadata.compressedSize);
  const time = formatDistanceToNow(new Date(item.createdAt), { addSuffix: true });
  const preview = item.contentType === 'file' ? item.filePath ?? item.preview : item.preview;
  const detailHint = getDetailHint(item);
  const imageTitle =
    typeof item.metadata.fileName === 'string' && item.metadata.fileName.trim()
      ? item.metadata.fileName
      : item.preview || '剪贴板图片';

  const copy = () => {
    void clipboardApi.copyItem(item.id).then((result) => {
      if (result.success) {
        if (result.item) {
          upsertItem(result.item);
        }
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      }
    });
  };

  return (
    <>
      <aside className="detail-panel flex h-full min-h-0 flex-col overflow-hidden rounded-[1.35rem] border border-slate-200 bg-white p-3">
        <div className="flex shrink-0 items-center gap-2 border-b border-slate-100 pb-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl bg-teal-50 text-teal-800">
            {iconForType(item.contentType)}
          </div>
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">当前选择</p>
            <p className="truncate text-sm font-semibold text-slate-950">{TYPE_LABELS[item.contentType]}</p>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {item.contentType === 'image' && imageUrl ? (
            <button
              type="button"
              className="mt-3 block w-full overflow-hidden rounded-2xl border border-slate-200 bg-slate-50 text-left transition hover:border-teal-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-400"
              onClick={() => setShowViewer(true)}
              title="点击放大图片"
            >
              <span className="flex h-32 w-full items-center justify-center bg-slate-100/70 p-2">
                <img
                  src={imageUrl}
                  alt={imageTitle}
                  className="max-h-full max-w-full rounded-xl object-contain"
                />
              </span>
              <span className="block border-t border-slate-200 px-3 py-2 text-[11px] font-medium text-slate-500">
                点击图片放大预览
              </span>
            </button>
          ) : null}

          <div className="mt-3 rounded-2xl bg-slate-50 p-3">
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">内容</p>
            <p className="max-h-28 overflow-auto break-words text-sm font-medium leading-6 text-slate-900">
              {preview || '空内容'}
            </p>
          </div>

          <div className="mt-3 space-y-2 text-[11px] text-slate-500">
            <div className="flex items-center justify-between gap-3">
              <span>时间</span>
              <span className="truncate text-right text-slate-700">{time}</span>
            </div>
            {size ? (
              <div className="flex items-center justify-between gap-3">
                <span>大小</span>
                <span className="text-slate-700">{size}</span>
              </div>
            ) : null}
            <div className="flex items-center justify-between gap-3">
              <span>使用</span>
              <span className="text-slate-700">{item.useCount > 0 ? `${item.useCount} 次` : '尚未使用'}</span>
            </div>
          </div>

          <div className="mt-4 rounded-2xl border border-slate-100 bg-white/85 px-3 py-2.5 text-[11px] font-medium text-slate-500">
            <div className="flex items-center justify-between gap-3">
              <span className="truncate text-slate-600">{detailHint}</span>
              <span className="flex shrink-0 items-center gap-1.5 text-slate-400">
                <Keyboard className="h-3.5 w-3.5 text-slate-400" />
                Delete / Ctrl+D
              </span>
            </div>
          </div>
        </div>

        <Button
          size="sm"
          className={cn('mt-3 h-11 shrink-0 gap-1.5 bg-teal-700 text-sm hover:bg-teal-800', copied && 'bg-emerald-600')}
          onClick={copy}
        >
          {copied ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? '已复制' : '复制'}
        </Button>
      </aside>

      {item.contentType === 'image' && imageUrl ? (
        <ImageViewer
          open={showViewer}
          imageUrl={imageUrl}
          title={imageTitle}
          onClose={() => setShowViewer(false)}
          onCopy={copy}
        />
      ) : null}
    </>
  );
}
