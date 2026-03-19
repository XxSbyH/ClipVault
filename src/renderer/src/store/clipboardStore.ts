import { create } from 'zustand';
import type { AppSettings, ClipboardItem, FilterType } from '@shared/types';

interface ClipboardState {
  items: ClipboardItem[];
  searchQuery: string;
  selectedType: FilterType;
  selectedItemId: number | null;
  settings: AppSettings | null;
  setItems: (items: ClipboardItem[]) => void;
  upsertItem: (item: ClipboardItem) => void;
  removeItem: (id: number) => void;
  setSearchQuery: (query: string) => void;
  setSelectedType: (type: FilterType) => void;
  setSelectedItemId: (id: number | null) => void;
  setSettings: (settings: AppSettings) => void;
}

function sortItems(items: ClipboardItem[]): ClipboardItem[] {
  return [...items].sort((a, b) => {
    if (a.isPinned !== b.isPinned) {
      return Number(b.isPinned) - Number(a.isPinned);
    }
    return b.createdAt - a.createdAt;
  });
}

export const useClipboardStore = create<ClipboardState>((set) => ({
  items: [],
  searchQuery: '',
  selectedType: 'all',
  selectedItemId: null,
  settings: null,
  setItems: (items) => set({ items: sortItems(items) }),
  upsertItem: (item) =>
    set((state) => {
      const next = state.items.filter((current) => current.id !== item.id);
      next.unshift(item);
      return { items: sortItems(next) };
    }),
  removeItem: (id) =>
    set((state) => ({
      items: state.items.filter((item) => item.id !== id),
      selectedItemId: state.selectedItemId === id ? null : state.selectedItemId
    })),
  setSearchQuery: (query) => set({ searchQuery: query }),
  setSelectedType: (type) => set({ selectedType: type }),
  setSelectedItemId: (id) => set({ selectedItemId: id }),
  setSettings: (settings) => set({ settings })
}));
