import { useEffect } from 'react';
import { clipboardApi } from '@/lib/tauriApi';
import { useClipboardStore } from '@/store/clipboardStore';

const INITIAL_HISTORY_LIMIT = 50;
const FULL_HISTORY_LIMIT = 300;

export function useClipboardData(): void {
  const setItems = useClipboardStore((state) => state.setItems);
  const upsertItem = useClipboardStore((state) => state.upsertItem);
  const setSettings = useClipboardStore((state) => state.setSettings);

  useEffect(() => {
    const offNewItem = clipboardApi.onNewItem((item) => {
      upsertItem(item);
    });

    // 先完成事件订阅，再通知主进程渲染层已就绪，避免启动阶段丢事件。
    clipboardApi.rendererReady();
    let lastRevision = 0;
    void clipboardApi.getHistoryRevision().then((revision) => {
      lastRevision = revision;
    });
    void clipboardApi.getHistory(INITIAL_HISTORY_LIMIT).then((items) => {
      setItems(items);
      window.setTimeout(() => {
        void clipboardApi.getHistory(FULL_HISTORY_LIMIT).then((fullItems) => {
          setItems(fullItems);
        });
      }, 180);
    });
    void clipboardApi.getSettings().then(setSettings);

    // IPC 偶发丢失时的兜底同步：轮询修订号，变化后再拉取完整历史。
    const timer = window.setInterval(() => {
      void clipboardApi.getHistoryRevision().then((revision) => {
        if (revision === lastRevision) {
          return;
        }
        lastRevision = revision;
        void clipboardApi.getHistory(FULL_HISTORY_LIMIT).then((latestItems) => {
          setItems(latestItems);
        });
      });
    }, 1200);

    return () => {
      offNewItem();
      window.clearInterval(timer);
    };
  }, [setItems, setSettings, upsertItem]);
}
