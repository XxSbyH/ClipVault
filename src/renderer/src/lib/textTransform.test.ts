import { describe, expect, it } from 'vitest';
import { applyTextTransform } from './textTransform';

describe('applyTextTransform', () => {
  const now = () => '2026-06-25 10:20:30';

  it('transforms casing and camel case', () => {
    expect(applyTextTransform('Abc Text', 'upper', now)).toBe('ABC TEXT');
    expect(applyTextTransform('AbC Text', 'lower', now)).toBe('abc text');
    expect(applyTextTransform('hello world-example', 'camel', now)).toBe('helloWorldExample');
    expect(applyTextTransform('Order ID value', 'camel', now)).toBe('orderIdValue');
  });

  it('capitalizes text and sentence starts', () => {
    expect(applyTextTransform('  hello world', 'capitalize', now)).toBe('  Hello world');
    expect(applyTextTransform('hello. next item! done?', 'sentence', now)).toBe('Hello. Next item! Done?');
  });

  it('removes newlines and appends content', () => {
    expect(applyTextTransform('alpha\nbeta\r\n gamma', 'removeNewlines', now)).toBe('alpha beta gamma');
    expect(applyTextTransform('alpha', 'appendNewline', now)).toBe('alpha\n');
    expect(applyTextTransform('alpha', 'appendCurrentTime', now)).toBe('alpha\n2026-06-25 10:20:30');
  });
});
