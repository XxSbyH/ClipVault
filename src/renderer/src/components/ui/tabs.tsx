import * as React from 'react';
import { cn } from '@/lib/utils';

interface TabsContextValue {
  value: string;
  onValueChange: (value: string) => void;
}

const TabsContext = React.createContext<TabsContextValue | null>(null);

export function Tabs({
  value,
  onValueChange,
  children,
  className
}: {
  value: string;
  onValueChange: (value: string) => void;
  children: React.ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <TabsContext.Provider value={{ value, onValueChange }}>
      <div className={cn('space-y-2', className)}>{children}</div>
    </TabsContext.Provider>
  );
}

export function TabsList({ className, children }: { className?: string; children: React.ReactNode }): JSX.Element {
  return <div className={cn('inline-flex rounded-md bg-muted p-1', className)}>{children}</div>;
}

export function TabsTrigger({
  value,
  className,
  children
}: {
  value: string;
  className?: string;
  children: React.ReactNode;
}): JSX.Element {
  const ctx = React.useContext(TabsContext);
  const active = ctx?.value === value;
  return (
    <button
      className={cn(
        'rounded-sm px-3 py-1.5 text-sm transition-colors',
        active ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
        className
      )}
      onClick={() => ctx?.onValueChange(value)}
    >
      {children}
    </button>
  );
}

export function TabsContent({
  value,
  className,
  children
}: {
  value: string;
  className?: string;
  children: React.ReactNode;
}): JSX.Element | null {
  const ctx = React.useContext(TabsContext);
  if (!ctx || ctx.value !== value) {
    return null;
  }
  return <div className={cn(className)}>{children}</div>;
}
