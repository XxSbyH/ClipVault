import * as React from 'react';
import { cn } from '@/lib/utils';

interface DialogContextValue {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const DialogContext = React.createContext<DialogContextValue | null>(null);

export function Dialog({
  open,
  onOpenChange,
  children
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}): JSX.Element {
  return <DialogContext.Provider value={{ open, onOpenChange }}>{children}</DialogContext.Provider>;
}

export function DialogContent({
  className,
  children
}: {
  className?: string;
  children: React.ReactNode;
}): JSX.Element | null {
  const ctx = React.useContext(DialogContext);

  React.useEffect(() => {
    if (!ctx?.open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        ctx.onOpenChange(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [ctx]);

  if (!ctx?.open) {
    return null;
  }
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onMouseDown={() => ctx.onOpenChange(false)}
    >
      <div
        role="dialog"
        aria-modal="true"
        className={cn('w-full max-w-2xl rounded-lg border border-border bg-card p-4 shadow-xl', className)}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

export function DialogClose({
  className,
  children
}: {
  className?: string;
  children?: React.ReactNode;
}): JSX.Element {
  const ctx = React.useContext(DialogContext);
  return (
    <button
      type="button"
      aria-label="关闭"
      className={cn(
        'inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground',
        className
      )}
      onClick={() => ctx?.onOpenChange(false)}
    >
      {children ?? '×'}
    </button>
  );
}

export function DialogHeader({ className, children }: { className?: string; children: React.ReactNode }): JSX.Element {
  return <div className={cn('mb-3 space-y-1', className)}>{children}</div>;
}

export function DialogTitle({ className, children }: { className?: string; children: React.ReactNode }): JSX.Element {
  return <h2 className={cn('text-base font-semibold text-foreground', className)}>{children}</h2>;
}

export function DialogDescription({
  className,
  children
}: {
  className?: string;
  children: React.ReactNode;
}): JSX.Element {
  return <p className={cn('text-sm text-muted-foreground', className)}>{children}</p>;
}
