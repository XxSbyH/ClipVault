import type { SpecialPasteAction } from '@shared/types';

export function applyTextTransform(
  content: string,
  action: SpecialPasteAction,
  now: () => string = defaultTimestamp
): string {
  switch (action) {
    case 'upper':
      return content.toLocaleUpperCase();
    case 'lower':
      return content.toLocaleLowerCase();
    case 'plain':
      return content;
    case 'camel':
      return toLowerCamel(content);
    case 'capitalize':
      return capitalizeFirstLetter(content);
    case 'sentence':
      return capitalizeSentences(content);
    case 'removeNewlines':
      return content.replace(/[\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
    case 'appendNewline':
      return `${content}\n`;
    case 'appendCurrentTime':
      return `${content}\n${now()}`;
  }
}

function defaultTimestamp(): string {
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    '-',
    pad(date.getMonth() + 1),
    '-',
    pad(date.getDate()),
    ' ',
    pad(date.getHours()),
    ':',
    pad(date.getMinutes()),
    ':',
    pad(date.getSeconds())
  ].join('');
}

function toLowerCamel(content: string): string {
  return content
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((word, index) => {
      const lower = word.toLocaleLowerCase();
      if (index === 0) {
        return lower;
      }
      return `${lower.charAt(0).toLocaleUpperCase()}${lower.slice(1)}`;
    })
    .join('');
}

function capitalizeFirstLetter(content: string): string {
  return content.replace(/\p{L}/u, (match) => match.toLocaleUpperCase());
}

function capitalizeSentences(content: string): string {
  let shouldCapitalize = true;
  return Array.from(content).map((character) => {
    if (shouldCapitalize && /\p{L}/u.test(character)) {
      shouldCapitalize = false;
      return character.toLocaleUpperCase();
    }
    if (/[.!?。！？]/u.test(character)) {
      shouldCapitalize = true;
    } else if (shouldCapitalize && /[\p{L}\p{N}]/u.test(character)) {
      shouldCapitalize = false;
    }
    return character;
  }).join('');
}
