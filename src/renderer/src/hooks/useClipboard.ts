import { useEffect } from 'react';
import { useClipboardStore } from '@/store/clipboardStore';

const INITIAL_HISTORY_LIMIT = 50;
const FULL_HISTORY_LIMIT = 300;

export function useClipboardData(): void {
  const setItems = useClipboardStore((state) => state.setItems);
  const upsertItem = useClipboardStore((state) => state.upsertItem);
  const setSettings = useClipboardStore((state) => state.setSettings);

  useEffect(() => {
    const offNewItem = window.electron.onNewItem((item) => {
      upsertItem(item);
    });

    // 先完成事件订阅，再通知主进程渲染层已就绪，避免启动阶段丢事件。
    window.electron.rendererReady();
    let lastRevision = 0;
    void window.electron.getHistoryRevision().then((revision) => {
      lastRevision = revision;
    });
    void window.electron.getHistory(INITIAL_HISTORY_LIMIT).then((items) => {
      setItems(items);
      window.setTimeout(() => {
        void window.electron.getHistory(FULL_HISTORY_LIMIT).then((fullItems) => {
          setItems(fullItems);
        });
      }, 180);
    });
    void window.electron.getSettings().then(setSettings);

    // IPC 偶发丢失时的兜底同步：轮询修订号，变化后再拉取完整历史。
    const timer = window.setInterval(() => {
      void window.electron.getHistoryRevision().then((revision) => {
        if (revision === lastRevision) {
          return;
        }
        lastRevision = revision;
        void window.electron.getHistory(FULL_HISTORY_LIMIT).then((latestItems) => {
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
