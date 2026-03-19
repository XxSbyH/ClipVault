import MiniSearch from 'minisearch';
import type { ClipboardItem } from '@shared/types';

interface SearchDoc {
  id: number;
  content: string;
  preview: string;
}

let miniSearch = new MiniSearch<SearchDoc>({
  fields: ['content', 'preview'],
  storeFields: ['id'],
  searchOptions: {
    boost: { preview: 2 },
    fuzzy: 0.2,
    prefix: true
  }
});

function toDoc(item: ClipboardItem): SearchDoc {
  return {
    id: item.id,
    content: item.content ?? '',
    preview: item.preview
  };
}

export function rebuildSearchIndex(items: ClipboardItem[]): void {
  miniSearch = new MiniSearch<SearchDoc>({
    fields: ['content', 'preview'],
    storeFields: ['id'],
    searchOptions: {
      boost: { preview: 2 },
      fuzzy: 0.2,
      prefix: true
    }
  });
  miniSearch.addAll(items.map(toDoc));
}

export function addToSearchIndex(item: ClipboardItem): void {
  try {
    miniSearch.discard(item.id);
  } catch {
    // 忽略不存在的旧文档，直接追加新文档
  }
  miniSearch.add(toDoc(item));
}

export function removeFromSearchIndex(id: number): void {
  try {
    miniSearch.discard(id);
  } catch {
    // 目标可能已不在索引中，忽略即可
  }
}

export function searchIds(query: string): number[] {
  const q = query.trim();
  if (!q) {
    return [];
  }
  const results = miniSearch.search(q);
  return results.map((result) => result.id);
}
