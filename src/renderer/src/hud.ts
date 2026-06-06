import type { HudPayload } from '@shared/types';
import { clipboardApi } from '@/lib/tauriApi';
import '@/hud.css';

const container = document.getElementById('hud-container');
const directionEl = document.getElementById('hud-direction');
const iconEl = document.getElementById('hud-icon');
const titleEl = document.getElementById('hud-title');
const textEl = document.getElementById('hud-text');

const directionLabel: Record<NonNullable<HudPayload['direction']>, string> = {
  prev: '上一项',
  next: '下一项'
};

const typeLabel: Record<NonNullable<HudPayload['type']>, string> = {
  text: '文本',
  image: '图片',
  file: '文件',
  url: '链接',
  code: '代码',
  color: '颜色',
  email: '邮箱'
};

const kindLabel: Record<HudPayload['kind'], string> = {
  quickPaste: '快速粘贴',
  copy: '复制成功',
  panel: '控制面板',
  status: '状态'
};

let hideTimer: number | null = null;
let hideWindowTimer: number | null = null;

function clearHudTimers(): void {
  if (hideTimer !== null) {
    window.clearTimeout(hideTimer);
    hideTimer = null;
  }
  if (hideWindowTimer !== null) {
    window.clearTimeout(hideWindowTimer);
    hideWindowTimer = null;
  }
}

function hideHudWindowAfterTransition(): void {
  hideWindowTimer = window.setTimeout(() => {
    hideWindowTimer = null;
    void clipboardApi.hideWindow();
  }, 180);
}

function statusText(payload: HudPayload): string {
  if (payload.direction) {
    return directionLabel[payload.direction];
  }
  if (payload.kind === 'copy') {
    return '已复制';
  }
  if (payload.kind === 'panel') {
    return '面板';
  }
  return '提示';
}

clipboardApi.onHudShow((payload: HudPayload) => {
  if (!container || !directionEl || !iconEl || !titleEl || !textEl) {
    return;
  }

  clearHudTimers();

  directionEl.textContent = statusText(payload);
  iconEl.textContent = payload.type ? typeLabel[payload.type] : kindLabel[payload.kind];
  titleEl.textContent = payload.title || kindLabel[payload.kind];
  textEl.textContent = payload.text || '操作完成';

  requestAnimationFrame(() => {
    container.classList.add('show');
  });

  hideTimer = window.setTimeout(() => {
    container.classList.remove('show');
    hideTimer = null;
    hideHudWindowAfterTransition();
  }, 1250);
});
