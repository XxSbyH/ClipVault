import type { HudPayload } from '@shared/types';
import '@/hud.css';

const container = document.getElementById('hud-container');
const directionEl = document.getElementById('hud-direction');
const iconEl = document.getElementById('hud-icon');
const textEl = document.getElementById('hud-text');

const directionLabel: Record<HudPayload['direction'], string> = {
  prev: '← 上一项',
  next: '→ 下一项'
};

const iconLabel: Record<HudPayload['type'], string> = {
  text: '📋',
  image: '🖼️',
  file: '📄',
  url: '🔗',
  code: '💻',
  color: '🎨',
  email: '✉️'
};

window.electron.onHudShow((payload: HudPayload) => {
  if (!container || !directionEl || !iconEl || !textEl) {
    return;
  }

  directionEl.textContent = directionLabel[payload.direction];
  iconEl.textContent = iconLabel[payload.type] ?? '📋';
  textEl.textContent = payload.text || '空内容';

  // 连续触发时保持 HUD 可见，只更新内容，避免“先消失再出现”的闪断感。
  if (!container.classList.contains('show')) {
    requestAnimationFrame(() => {
      container.classList.add('show');
    });
    return;
  }
  container.classList.add('show');
});
