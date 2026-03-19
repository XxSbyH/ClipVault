import { cn } from '@/lib/utils';

export function Separator({ className }: { className?: string }): JSX.Element {
  return <div className={cn('h-px w-full bg-border', className)} />;
}
