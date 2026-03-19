/// <reference types="vite/client" />

import type { ClipboardApi } from '@shared/types';

declare global {
  interface Window {
    electron: ClipboardApi;
  }
}

export {};
