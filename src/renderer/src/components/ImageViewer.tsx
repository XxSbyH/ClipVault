import { useEffect } from 'react';

interface ImageViewerProps {
  open: boolean;
  imageUrl: string;
  title: string;
  onClose: () => void;
  onCopy: () => void;
}

export function ImageViewer({ open, imageUrl, title, onClose, onCopy }: ImageViewerProps): JSX.Element | null {
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose, open]);

  if (!open) {
    return null;
  }

  return (
    <div
      className="image-viewer-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="image-viewer-content relative max-h-[90vh] max-w-[90vw]"
        onClick={(event) => event.stopPropagation()}
      >
        <img
          src={imageUrl}
          alt={title}
          className="max-h-[90vh] max-w-[90vw] cursor-copy object-contain"
          onClick={() => {
            onCopy();
            setTimeout(() => {
              onClose();
            }, 300);
          }}
        />
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-4 py-1 text-xs text-white">
          点击图片复制 · 点击空白关闭
        </div>
      </div>
      <div className="pointer-events-none absolute right-4 top-4 rounded-full bg-black/45 px-3 py-1 text-xs text-white/80">
        按 ESC 关闭
      </div>
    </div>
  );
}
