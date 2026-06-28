import { relaunch } from '@tauri-apps/plugin-process';
import { check } from '@tauri-apps/plugin-updater';

interface UpdateLike {
  version: string;
  body?: string;
  downloadAndInstall: () => Promise<void>;
}

interface UpdateDeps {
  check: () => Promise<UpdateLike | null>;
  confirm: (message: string) => boolean;
  relaunch: () => Promise<void>;
}

export async function checkForUpdateOnStartup(
  deps: UpdateDeps = { check, confirm: window.confirm, relaunch }
): Promise<void> {
  try {
    const update = await deps.check();
    if (!update) {
      return;
    }

    const accepted = deps.confirm(
      `发现新版本 ${update.version}。\n\n${update.body ?? '是否下载并安装更新？'}`
    );
    if (!accepted) {
      return;
    }

    await update.downloadAndInstall();
    await deps.relaunch();
  } catch (error) {
    console.warn('update check failed', error);
  }
}
