import { describe, expect, it, vi } from 'vitest';
import { checkForUpdateOnStartup } from './updater';

describe('checkForUpdateOnStartup', () => {
  it('does not prompt when no update exists', async () => {
    const check = vi.fn().mockResolvedValue(null);
    const confirm = vi.fn();

    await checkForUpdateOnStartup({ check, confirm, relaunch: vi.fn() });

    expect(confirm).not.toHaveBeenCalled();
  });

  it('downloads and relaunches when user accepts an update', async () => {
    const downloadAndInstall = vi.fn().mockResolvedValue(undefined);
    const check = vi.fn().mockResolvedValue({
      version: '2.1.8',
      body: '更新说明',
      downloadAndInstall
    });
    const relaunch = vi.fn().mockResolvedValue(undefined);

    await checkForUpdateOnStartup({
      check,
      confirm: vi.fn().mockReturnValue(true),
      relaunch
    });

    expect(downloadAndInstall).toHaveBeenCalled();
    expect(relaunch).toHaveBeenCalled();
  });

  it('does not download when user rejects an update', async () => {
    const downloadAndInstall = vi.fn();
    const check = vi.fn().mockResolvedValue({
      version: '2.1.8',
      body: '更新说明',
      downloadAndInstall
    });

    await checkForUpdateOnStartup({
      check,
      confirm: vi.fn().mockReturnValue(false),
      relaunch: vi.fn()
    });

    expect(downloadAndInstall).not.toHaveBeenCalled();
  });
});
