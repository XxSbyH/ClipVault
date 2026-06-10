import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@shared/types';
import { getHistoryFetchLimit } from './historyLimit';

describe('history fetch limit', () => {
  it('uses the configured maximum item count instead of a fixed 300 limit', () => {
    expect(getHistoryFetchLimit({ ...DEFAULT_SETTINGS, maxItems: 1000 })).toBe(1000);
  });

  it('falls back to the default settings limit while settings are loading', () => {
    expect(getHistoryFetchLimit(null)).toBe(DEFAULT_SETTINGS.maxItems);
  });
});
