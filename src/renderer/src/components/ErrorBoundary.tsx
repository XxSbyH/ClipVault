import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<React.PropsWithChildren, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error): void {
    console.error('renderer boundary caught error', error);
  }

  override render(): React.ReactNode {
    if (!this.state.error) {
      return this.props.children;
    }

    return (
      <div className="flex h-full items-center justify-center bg-background p-6">
        <div className="max-w-sm rounded-2xl border border-red-200 bg-white p-5 text-center shadow-xl">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-red-50 text-red-600">
            <AlertTriangle className="h-6 w-6" />
          </div>
          <h1 className="text-base font-semibold text-foreground">界面加载失败</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            ClipVault 已捕获异常，核心数据未受影响。可以刷新界面后继续使用。
          </p>
          <Button
            className="mt-4"
            onClick={() => this.setState({ error: null })}
          >
            返回面板
          </Button>
        </div>
      </div>
    );
  }
}
