import type { HudPayload } from '@shared/types';
import { clipboardApi } from '@/lib/tauriApi';
import '@/hud.css';

const container = document.getElementById('hud-container');
const directionEl = document.getElementById('hud-direction');
const iconEl = document.getElementById('hud-icon');
const textEl = document.getElementById('hud-text');

const directionLabel: Record<HudPayload['direction'], string> = {
  prev: '上一项',
  next: '下一项'
};

const typeLabel: Record<HudPayload['type'], string> = {
  text: '文本',
  image: '图片',
  file: '文件',
  url: '链接',
  code: '代码',
  color: '颜色',
  email: '邮箱'
};

let hideTimer: number | null = null;

clipboardApi.onHudShow((payload: HudPayload) => {
  if (!container || !directionEl || !iconEl || !textEl) {
    return;
  }

  directionEl.textContent = directionLabel[payload.direction];
  iconEl.textContent = typeLabel[payload.type] ?? '内容';
  textEl.textContent = payload.text || '空内容';

  if (hideTimer) {
    window.clearTimeout(hideTimer);
  }

  requestAnimationFrame(() => {
    container.classList.add('show');
  });

  hideTimer = window.setTimeout(() => {
    container.classList.remove('show');
    hideTimer = null;
  }, 1400);
});
